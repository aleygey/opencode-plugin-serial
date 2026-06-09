/**
 * The serial_* tools, rewritten from the core's Effect-based `Tool.define`
 * into the plugin `tool()` shape (plain async). Behaviour and parameters are
 * preserved 1:1 for the original tools; the only structural change is that the
 * core's `{ title, metadata, output }` result becomes `{ output, metadata }`
 * (the plugin ToolResult has no `title` field), so the title is folded into
 * metadata.
 *
 * Added on top:
 *   - Q1 noise reduction: dedup/cycles/normalize/exclude/include flags on the
 *     read tools, plus serial_digest.
 *   - Q2 discovery + lease: serial_list_ports is device-map annotated,
 *     serial_probe (live machine + model), serial_devices (the map), and the
 *     write/control tools enforce a per-device lease keyed by sessionID.
 */

import { tool, type ToolDefinition, type ToolContext } from "./vendor/opencode"
import { z } from "zod"
import { Serial } from "./service"
import { SerialID } from "./schema"

const format = (value: unknown) => JSON.stringify(value, null, 2)

// Pull the calling agent's session id — used as the device-lease owner so only
// one agent controls a prototype at a time (read tools never need it).
const ownerOf = (ctx?: ToolContext) => ctx?.sessionID

const isLockError = (e: unknown): e is { holder: { owner: string; acquiredAt: number; pid: number }; message: string } =>
  !!e && typeof e === "object" && (e as { name?: string }).name === "SerialLockError"

// Build a ReduceOptions from the shared read-tool flags (or undefined if none).
function reduceOptsOf(p: {
  dedup?: boolean
  cycles?: boolean
  normalize?: boolean
  exclude?: string
  include?: string
}): Serial.ReduceOptions | undefined {
  if (!p.dedup && !p.cycles && !p.normalize && !p.exclude && !p.include) return undefined
  return {
    dedup: p.dedup,
    cycles: p.cycles,
    normalize: p.normalize,
    exclude: p.exclude ? [p.exclude] : undefined,
    include: p.include ? [p.include] : undefined,
  }
}

// Shared zod shape for the noise-reduction flags.
const reduceArgs = {
  dedup: z.boolean().optional().describe("Collapse consecutive identical lines into `<line> (×N)`."),
  cycles: z
    .boolean()
    .optional()
    .describe("Detect & collapse repeating multi-line blocks, e.g. A/B/C/A/B/C → the block once with (×N). Implies dedup."),
  normalize: z
    .boolean()
    .optional()
    .describe(
      "Fold near-duplicate/templated lines that differ only in volatile tokens (timestamps, counters, hex, IP/MAC) before counting repeats.",
    ),
  exclude: z.string().optional().describe("Regex; drop lines matching this (e.g. drop watchdog/heartbeat noise)."),
  include: z.string().optional().describe("Regex; keep only lines matching this."),
}

export const serialTools: Record<string, ToolDefinition> = {
  // ── serial_list_ports ──────────────────────────────────────────────────
  serial_list_ports: tool({
    description:
      "List physical serial devices attached to the host, annotated with the device map (deviceName/model/suggestedBaud) when matched and whether each is already in use. Call this first to find a device before serial_create. To learn which model is on which port without a static map, use serial_probe.",
    args: {},
    async execute() {
      const ports = await Serial.listPortsAnnotated()
      return { output: format(ports), metadata: { title: `${ports.length} port(s)`, count: ports.length, ports } }
    },
  }),

  // ── serial_probe ───────────────────────────────────────────────────────
  serial_probe: tool({
    description:
      "Discover which ports have a LIVE machine and what it is. For each candidate port (skipping ones already open), transiently opens it, listens briefly (and by default nudges with \\r\\n to elicit a prompt), classifies the banner against the device map's readyRe (or generic prompts: '=> ', '# ', 'login:', 'U-Boot', 'BusyBox', ets/rst for ESP), then closes. Returns {path, model, alive, banner, detectedPrompt}. Use this when you have multiple prototypes and need to find the right one yourself.",
    args: {
      paths: z.array(z.string()).optional().describe("Restrict to these device paths. Omit to probe all attached ports."),
      nudge: z.boolean().default(true).describe("Send \\r\\n to elicit a prompt. Set false for a purely passive listen."),
      timeout_ms: z.number().int().positive().default(1500).describe("How long to listen per port. Default 1.5s."),
    },
    async execute(params) {
      const results = await Serial.probe({ paths: params.paths, nudge: params.nudge, timeoutMs: params.timeout_ms })
      const alive = results.filter((r) => r.alive).length
      return { output: format(results), metadata: { title: `${alive}/${results.length} alive`, results } }
    },
  }),

  // ── serial_devices ───────────────────────────────────────────────────────
  serial_devices: tool({
    description:
      "Inspect or bootstrap the device map (<base>/.opencode/serial/devices.json), which maps a USB adapter (serialNumber / vendorId+productId) to a prototype name+model+baud. action:'list' shows the loaded entries; action:'scaffold' returns a starter devices.json built from the currently attached ports (write it to <worktree>/.opencode/serial/devices.json and edit the names/models/baud); action:'reload' re-reads the file after you edit it.",
    args: {
      action: z.enum(["list", "scaffold", "reload"]).default("list"),
    },
    async execute(params) {
      if (params.action === "scaffold") {
        const scaffold = await Serial.scaffoldDevices()
        return {
          output:
            "Write this to <worktree>/.opencode/serial/devices.json, edit name/model/baudRate, then serial_devices({action:'reload'}):\n\n" +
            format(scaffold),
          metadata: { title: `scaffolded ${scaffold.devices.length} device(s)`, scaffold },
        }
      }
      if (params.action === "reload") {
        const r = Serial.reloadDevices()
        return { output: `reloaded ${r.count} device(s) from ${r.from ?? "(not configured)"}`, metadata: { title: `${r.count} device(s)`, ...r } }
      }
      const devices = Serial.listDevices()
      return { output: format(devices), metadata: { title: `${devices.length} device(s)`, count: devices.length, devices } }
    },
  }),

  // ── serial_list ──────────────────────────────────────────────────────────
  serial_list: tool({
    description:
      "List currently open serial sessions. Each session is shared between the agent and any UI client attached to the same SerialID.",
    args: {},
    async execute() {
      const list = await Serial.list()
      return { output: format(list), metadata: { title: `${list.length} session(s)`, count: list.length, sessions: list } }
    },
  }),

  // ── serial_create ──────────────────────────────────────────────────────────
  serial_create: tool({
    description:
      "Open a serial session on the given device path. Returns a SerialID. The session is visible to the UI so the user can monitor the same stream. Acquires a per-device lease for the calling agent — another agent that tries to create/write the same physical device is refused unless it passes takeover:true. Reading (serial_read_recent/grep/wait/digest) never needs the lease.",
    args: {
      path: z.string().describe("Device path (e.g. /dev/ttyUSB0 or COM3)"),
      baudRate: z.number().int().positive().default(115200),
      title: z.string().optional().describe("Human-readable label shown in the UI"),
      dataBits: z.number().int().optional(),
      stopBits: z.number().int().optional(),
      parity: z.enum(["none", "even", "odd", "mark", "space"]).optional(),
      flowControl: z.boolean().optional(),
      takeover: z.boolean().optional().describe("Seize the device even if another session holds the lease."),
    },
    async execute(params, context) {
      try {
        const { takeover, ...createParams } = params
        const info = await Serial.create(createParams, { owner: ownerOf(context), takeover })
        return { output: format(info), metadata: { serialID: info.id, ...info } }
      } catch (e) {
        if (isLockError(e)) {
          return { output: e.message, metadata: { title: "locked", locked: true, holder: e.holder } }
        }
        throw e
      }
    },
  }),

  // ── serial_write ───────────────────────────────────────────────────────────
  serial_write: tool({
    description:
      "Write data to an open serial session. Use a trailing \\r\\n if the target device expects a line terminator. Requires the calling agent to hold the device lease (from serial_create).",
    args: {
      serial_id: z.string().describe("SerialID returned by serial_create"),
      data: z
        .string()
        .describe(
          "Payload to send. Escape sequences are interpreted: \\r \\n \\t \\0 \\xNN \\u####. " +
            "Example: send Ctrl-C with \\x03, send 'slp' line with 'slp\\r\\n'.",
        ),
    },
    async execute(params, context) {
      const id = SerialID.zod.parse(params.serial_id)
      const interpreted = Serial.decode(params.data)
      try {
        await Serial.write(id, interpreted, ownerOf(context))
      } catch (e) {
        if (isLockError(e)) return { output: e.message, metadata: { title: "locked", serialID: id, locked: true, holder: e.holder } }
        throw e
      }
      return {
        output: `wrote ${interpreted.length} bytes to ${id}`,
        metadata: { title: `write ${interpreted.length}B`, serialID: id, bytes: interpreted.length },
      }
    },
  }),

  // ── serial_collect ────────────────────────────────────────────────────────
  serial_collect: tool({
    description:
      "Send a command and atomically collect the bytes the device prints in response, " +
      "stopping when `until` (typically a shell prompt) reappears. One tool call " +
      "replaces serial_write + serial_wait + serial_read_recent, saving both " +
      "round-trips and the token cost of re-parsing the boot log on the read step. " +
      "Use this for shell commands with a known prompt (e.g. send 'cat /proc/meminfo\\r\\n' " +
      "and collect until '# ' returns). For commands whose output ends with no clean " +
      "prompt, use serial_write + serial_wait separately so you can pick a different " +
      "stop pattern. Defaults to collapsing repeated lines/cycles and \\r progress bars; " +
      "pass dedup/cycles/normalize/exclude to tune the noise reduction.",
    args: {
      serial_id: z.string(),
      data: z
        .string()
        .describe(
          "Bytes to write before collecting. Same escape decoding as serial_write " +
            "(\\r \\n \\t \\xNN \\u####). Pass an empty string if you only want to " +
            "collect output after the current point without writing anything.",
        ),
      until: z
        .string()
        .describe(
          "Regex pattern that marks the end of the captured output (typically the " +
            "shell / u-boot prompt the device prints when ready for the next command).",
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .default(15_000)
        .describe(
          "How long to wait for `until` to appear. Default 15s. Set higher for slow " +
            "operations (flash, fsck) and lower for snappy interactive commands.",
        ),
      context_lines: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe(
          "Extra lines after the `until` match to include in the captured output. " +
            "0 (default) stops cleanly at the prompt; raise this only if the device " +
            "prints additional banner/status lines after the prompt that you need.",
        ),
      max_bytes: z
        .number()
        .int()
        .positive()
        .default(32_768)
        .describe("Hard cap on returned bytes — protects against runaway output. Default 32K."),
      ...reduceArgs,
    },
    async execute(params, context) {
      const id = SerialID.zod.parse(params.serial_id)
      const preSnap = await Serial.snapshot(id, { tailBytes: 1 })
      if (!preSnap) {
        return { output: `No active session ${id}.`, metadata: { title: "not found", serialID: id, found: false } }
      }
      const fromCursor = preSnap.cursor

      if (params.data.length > 0) {
        const interpreted = Serial.decode(params.data)
        try {
          await Serial.write(id, interpreted, ownerOf(context))
        } catch (e) {
          if (isLockError(e)) return { output: e.message, metadata: { title: "locked", serialID: id, locked: true, holder: e.holder } }
          throw e
        }
      }

      const waitResult = await Serial.wait(id, {
        pattern: params.until,
        timeoutMs: params.timeout_ms,
        contextLines: 0,
      })

      const captureSnap = await Serial.snapshot(id, { sinceCursor: fromCursor, maxBytes: params.max_bytes })
      const rawCaptured = captureSnap?.data ?? ""
      const droppedBytes = captureSnap?.dropped ?? 0
      // Default the noisy-device path to full denoise (dedup+cycles+normalize,
      // and reduce.ts always flattens \r progress bars).
      const reduceOpts: Serial.ReduceOptions = reduceOptsOf(params) ?? { cycles: true }
      const captured = Serial.reduceLines(rawCaptured, reduceOpts)

      if (!waitResult || !waitResult.matched) {
        return {
          output: [
            `Pattern /${params.until}/ did not appear within ${params.timeout_ms}ms.`,
            captured ? `─ captured before timeout ─\n${captured}` : "(no output captured)",
          ].join("\n"),
          metadata: {
            title: `timed out after ${params.timeout_ms}ms (${rawCaptured.length}B captured)`,
            serialID: id,
            found: false,
            matched: false,
            timedOut: true,
            bytes: captured.length,
            rawBytes: rawCaptured.length,
            fromCursor,
            ...(droppedBytes > 0 && { droppedBytes }),
          },
        }
      }

      return {
        output: captured,
        metadata: {
          title: `collected ${captured.length}B @ ${waitResult.cursor}${rawCaptured.length !== captured.length ? ` (raw ${rawCaptured.length}B)` : ""}`,
          serialID: id,
          found: true,
          matched: true,
          cursor: waitResult.cursor,
          match: waitResult.match,
          fromCursor,
          bytes: captured.length,
          rawBytes: rawCaptured.length,
          ...(droppedBytes > 0 && { droppedBytes }),
        },
      }
    },
  }),

  // ── serial_read_recent ─────────────────────────────────────────────────────
  serial_read_recent: tool({
    description:
      "Read buffered output of a serial session. Prefer `since_cursor` for incremental reads — the response includes a `cursor` you can pass back next time to read only newly arrived bytes. `tail_bytes` is the legacy mode that always returns the most recent N bytes. On noisy devices set dedup/cycles/normalize/exclude to slash the token cost server-side.",
    args: {
      serial_id: z.string(),
      since_cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Read from this absolute byte cursor onward. Pass back the `cursor` " +
            "value returned by a previous call to read only the new bytes since " +
            "then. Wins over tail_bytes when both are provided.",
        ),
      tail_bytes: z
        .number()
        .int()
        .positive()
        .default(4096)
        .describe("Return only the last N bytes. Ignored when since_cursor is set."),
      max_bytes: z.number().int().positive().optional().describe("Hard cap on returned data length. The most recent bytes are kept."),
      ...reduceArgs,
    },
    async execute(params) {
      const id = SerialID.zod.parse(params.serial_id)
      const snap = await Serial.snapshot(id, {
        tailBytes: params.tail_bytes,
        sinceCursor: params.since_cursor,
        maxBytes: params.max_bytes,
      })
      if (!snap) {
        return { output: `No active session ${id}.`, metadata: { title: "not found", serialID: id, found: false } }
      }
      const reduceOpts = reduceOptsOf(params)
      const data = reduceOpts ? Serial.reduceLines(snap.data, reduceOpts) : snap.data
      const reduced = data.length !== snap.data.length
      const title =
        snap.dropped > 0
          ? `${data.length}B @ ${snap.cursor} (lost ${snap.dropped}B)`
          : `${data.length}B @ ${snap.cursor}${reduced ? ` (raw ${snap.data.length}B)` : ""}`
      return {
        output: data,
        metadata: {
          title,
          serialID: id,
          found: true,
          cursor: snap.cursor,
          bufferCursor: snap.bufferCursor,
          fromCursor: snap.fromCursor,
          bytes: data.length,
          ...(reduced && { rawBytes: snap.data.length }),
          ...(snap.dropped > 0 && { droppedBytes: snap.dropped }),
        },
      }
    },
  }),

  // ── serial_digest ──────────────────────────────────────────────────────────
  serial_digest: tool({
    description:
      "Structured 'did anything break?' summary instead of the raw byte firehose: returns line/byte counts, the first and last line, and the deduped error/warn/panic lines (matching /err|fail|panic|warn|fatal|exception|.../i). Use this to decide the next action after a noisy operation without flooding context. Pair with since_cursor for incremental checks.",
    args: {
      serial_id: z.string(),
      since_cursor: z.number().int().nonnegative().optional().describe("Digest only bytes after this cursor."),
      tail_bytes: z.number().int().positive().optional().describe("Digest only the last N bytes (default 64K). Ignored when since_cursor is set."),
    },
    async execute(params) {
      const id = SerialID.zod.parse(params.serial_id)
      const d = await Serial.digest(id, { sinceCursor: params.since_cursor, tailBytes: params.tail_bytes })
      if (!d) {
        return { output: `No active session ${id}.`, metadata: { title: "not found", serialID: id, found: false } }
      }
      const out = [
        `lines=${d.lines} bytes=${d.bytes} cursor=${d.cursor}`,
        `first: ${d.firstLine}`,
        `last:  ${d.lastLine}`,
        d.errorLines.length ? `─ ${d.errorLines.length} error/warn line(s) ─\n${d.errorLines.join("\n")}` : "no error/warn lines",
      ].join("\n")
      return {
        output: out,
        metadata: {
          title: `${d.errorLines.length} issue(s), ${d.lines} lines`,
          serialID: id,
          found: true,
          ...d,
        },
      }
    },
  }),

  // ── serial_grep ────────────────────────────────────────────────────────────
  serial_grep: tool({
    description:
      "Filter the ring buffer for lines matching a regex pattern. Use this instead of serial_read_recent when scanning a noisy boot log for specific events — far fewer tokens than reading the whole tail.",
    args: {
      serial_id: z.string(),
      pattern: z.string().describe("Regex pattern matched against each line."),
      since_cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Scan from this byte cursor onward. Wins over tail_bytes when both are set."),
      tail_bytes: z.number().int().positive().optional().describe("Only scan the last N bytes."),
      max_matches: z.number().int().positive().default(50),
    },
    async execute(params) {
      const id = SerialID.zod.parse(params.serial_id)
      const result = await Serial.grep(id, {
        pattern: params.pattern,
        sinceCursor: params.since_cursor,
        tailBytes: params.tail_bytes,
        maxMatches: params.max_matches,
      })
      if (!result) {
        return { output: `No active session ${id}.`, metadata: { title: "not found", serialID: id, found: false } }
      }
      const lines = result.matches.map((m) => `[${m.cursor}] ${m.line}`).join("\n")
      return {
        output: lines || "(no matches)",
        metadata: {
          title: `${result.matches.length} match(es)`,
          serialID: id,
          found: true,
          matches: result.matches.length,
          scannedFrom: result.scannedFrom,
          scannedTo: result.scannedTo,
          truncated: result.truncated,
        },
      }
    },
  }),

  // ── serial_wait ────────────────────────────────────────────────────────────
  serial_wait: tool({
    description:
      "Block until a regex pattern appears in the serial stream, then return the match plus a few lines of context. Use this to wait for prompts (e.g. '=> ' for u-boot, '# $' for a shell, 'login:' before authenticating) without polling and without flooding context with the boot log.",
    args: {
      serial_id: z.string(),
      pattern: z.string().describe("Regex pattern; matched against the ring buffer with the 'm' flag."),
      timeout_ms: z.number().int().positive().default(10000),
      context_lines: z
        .number()
        .int()
        .nonnegative()
        .default(3)
        .describe("Number of lines of context to return before/after the match."),
    },
    async execute(params) {
      const id = SerialID.zod.parse(params.serial_id)
      const result = await Serial.wait(id, {
        pattern: params.pattern,
        timeoutMs: params.timeout_ms,
        contextLines: params.context_lines,
      })
      if (!result) {
        return { output: `No active session ${id}.`, metadata: { title: "not found", serialID: id, found: false } }
      }
      if (result.matched) {
        return {
          output: [
            result.before ? `─ before ─\n${result.before}` : undefined,
            `─ match ─\n${result.match}`,
            result.after ? `─ after ─\n${result.after}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            title: `matched @ ${result.cursor}`,
            serialID: id,
            found: true,
            matched: true,
            cursor: result.cursor,
            match: result.match,
          },
        }
      }
      return {
        output: `Pattern /${params.pattern}/ did not appear within ${params.timeout_ms}ms.`,
        metadata: {
          title: `timed out after ${params.timeout_ms}ms`,
          serialID: id,
          found: true,
          matched: false,
          cursor: result.cursor,
          timedOut: true,
        },
      }
    },
  }),

  // ── serial_arm ─────────────────────────────────────────────────────────────
  serial_arm: tool({
    description:
      "Arm a server-side reactive trigger on a serial session. The trigger fires entirely inside opencode's event loop (sub-millisecond latency), so it can hit deadlines that an LLM tool-call round-trip cannot — e.g. spam 'slp' to break into u-boot before autoboot completes.\n\nTwo modes:\n  • on_pattern: when regex matches incoming data → write response\n  • every_ms: periodically write response every N ms\n\nThis tool is FIRE-AND-FORGET: it returns IMMEDIATELY after queueing the timer/listener; the actual sending happens in the background. Always include a stop condition (until_pattern / max_fires / timeout_ms) — otherwise the trigger runs forever.\n\nRequires the calling agent to hold the device lease (the trigger writes to the port).\n\nReturns a trigger_id you can pass to serial_disarm.\n\nU-BOOT BREAK RECIPE (interrupt autoboot to drop into the `=> ` prompt):\n  1. ARM FIRST, REBOOT SECOND — arm() returns instantly, so the SLP spam must already be streaming when the device starts printing autoboot output. Reversing the order (reboot → arm) races the bootloader and the spam misses the window.\n  2. Use a TIGHT interval — `every_ms: 50` (or 30 on slow links). Many boards' autoboot countdown is <1s.\n  3. Send the break character that THIS BOARD expects. Common ones: `'slp\\r\\n'`, `'\\x03'` (ctrl-C), `'\\r'`, `' '` (space), `'a'`.\n  4. Set `until_pattern` to the uboot prompt (`'=> '` or `'# '`) so the spam auto-stops when you're in.\n\nCanonical call sequence:\n  serial_arm({ serial_id, every_ms: 50, response: 'slp\\r\\n', until_pattern: '=> ' })\n  serial_write({ serial_id, data: 'reboot\\n' })",
    args: {
      serial_id: z.string(),
      response: z
        .string()
        .describe("Bytes to send when the trigger fires. Escape sequences \\r \\n \\t \\xNN \\u#### are decoded."),
      on_pattern: z
        .string()
        .optional()
        .describe("Regex; fire `response` whenever this matches incoming data. Mutually exclusive with `every_ms`."),
      every_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Periodically fire `response` every N ms (no input gating; useful for u-boot break spam). " +
            "Mutually exclusive with `on_pattern`.",
        ),
      until_pattern: z
        .string()
        .optional()
        .describe("Regex; auto-disarm when this matches incoming data. Use to stop a periodic trigger on prompt detection."),
      max_fires: z.number().int().positive().optional().describe("Disarm after this many fires."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Hard deadline; auto-disarm after this many ms regardless of state."),
    },
    async execute(params, context) {
      // The core enforced these via zod .refine(); the plugin tool `args` is a
      // raw shape (no refine), so validate the mutually-exclusive / stop-
      // condition constraints here to keep behaviour identical.
      if (!params.on_pattern && !params.every_ms) {
        throw new Error("Must provide either `on_pattern` (reactive) or `every_ms` (periodic).")
      }
      if (params.on_pattern && params.every_ms) {
        throw new Error("`on_pattern` and `every_ms` are mutually exclusive.")
      }
      if (!params.until_pattern && !params.max_fires && !params.timeout_ms) {
        throw new Error("At least one stop condition is required: `until_pattern`, `max_fires`, or `timeout_ms`.")
      }

      const id = SerialID.zod.parse(params.serial_id)
      let triggerId: string | undefined
      try {
        triggerId = await Serial.arm(
          id,
          {
            response: Serial.decode(params.response),
            onPattern: params.on_pattern,
            everyMs: params.every_ms,
            untilPattern: params.until_pattern,
            maxFires: params.max_fires,
            timeoutMs: params.timeout_ms,
          },
          ownerOf(context),
        )
      } catch (e) {
        if (isLockError(e)) return { output: e.message, metadata: { title: "locked", serialID: id, locked: true, holder: e.holder } }
        throw e
      }
      if (!triggerId) {
        return { output: `No active session ${id}.`, metadata: { title: "not found", serialID: id, armed: false } }
      }
      const mode = params.every_ms ? `every ${params.every_ms}ms` : `on /${params.on_pattern}/`
      return {
        output: `armed ${triggerId} on ${id}: ${mode}`,
        metadata: {
          title: `armed ${triggerId} (${mode})`,
          serialID: id,
          armed: true,
          triggerID: triggerId,
          mode: params.every_ms ? "periodic" : "reactive",
        },
      }
    },
  }),

  // ── serial_disarm ──────────────────────────────────────────────────────────
  serial_disarm: tool({
    description:
      "Clear a trigger previously armed via serial_arm. No-op (returns `disarmed: false`) if the trigger has already auto-disarmed.",
    args: {
      serial_id: z.string(),
      trigger_id: z.string().describe("ID returned by serial_arm."),
    },
    async execute(params) {
      const id = SerialID.zod.parse(params.serial_id)
      const ok = await Serial.disarm(id, params.trigger_id)
      return {
        output: ok ? `disarmed ${params.trigger_id}` : `trigger ${params.trigger_id} not found (already disarmed?)`,
        metadata: { title: ok ? "disarmed" : "not found", serialID: id, triggerID: params.trigger_id, disarmed: ok },
      }
    },
  }),

  // ── serial_close ───────────────────────────────────────────────────────────
  serial_close: tool({
    description: "Close a serial session and release its device lease. Disconnects any UI clients attached to the same SerialID.",
    args: {
      serial_id: z.string(),
    },
    async execute(params) {
      const id = SerialID.zod.parse(params.serial_id)
      await Serial.remove(id)
      return { output: `closed ${id}`, metadata: { title: "closed", serialID: id, closed: true } }
    },
  }),
}
