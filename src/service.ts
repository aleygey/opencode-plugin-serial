/**
 * Serial service — session table, ring buffer, reactive triggers, one-shot
 * waiters, WebSocket fan-out, device-map matching, and per-device leases.
 *
 * This is the core's `src/serial/index.ts` rewritten off the Effect/Bus/
 * InstanceState stack into a plain process-singleton + EventEmitter, so the
 * package carries no dependency on opencode internals. The business logic
 * (teardown / evaluate / snapshot / grep / wait / arm / connect) is preserved
 * 1:1; only the wrapper changed:
 *
 *   - InstanceState<State>      → module-level `sessions` Map
 *   - Bus.publish(Event.X)      → `emit("serial.x", …)` on an EventEmitter
 *   - Effect.fn(function*(){})  → plain async/sync functions
 *   - Instance.bind(cb)         → cb (single process, no instance binding)
 *   - lazy(import("#serial"))   → static `import * as driver from "#serial-driver"`
 *
 * Added on top of the 1:1 port (all display-only / advisory — the raw ring
 * buffer and the WebSocket replay are never mutated):
 *   - reduceLines / digest      → server-side log de-noising (Q1)
 *   - device map + deviceKey    → "which port is which prototype" (Q2)
 *   - LockManager leases        → one writer per device, many observers (Q2)
 */

import { EventEmitter } from "node:events"
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, createWriteStream, type WriteStream } from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { z } from "zod"
import * as driver from "#serial-driver"
import { SerialID } from "./schema"
import * as Devices from "./devices"
import { LockManager } from "./locks"
import { reduceLines as reduceLinesImpl, type ReduceOptions as ReduceOptionsImpl, stripAnsi } from "./reduce"

export namespace Serial {
  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024
  // Lookback window used by the trigger / waiter scanner so patterns split
  // across `port.onData` chunk boundaries (e.g. uboot's "=> ") still match.
  const SCAN_LOOKBACK = 1024
  const encoder = new TextEncoder()

  // Diagnostics are intentionally a no-op: the original used the core file
  // logger, not stdout. Swap for console.* when debugging.
  const log = { info: (..._args: unknown[]) => {} }

  // ── Configuration (base dir for device map + lock files + session logs) ───
  let locks: LockManager | undefined
  let baseDirPath: string | undefined

  export function configure(opts: { base: string }) {
    baseDirPath = opts.base
    locks = new LockManager(opts.base)
    Devices.load(opts.base)
  }

  /** Thrown by create()/write()/arm() when another session holds the device. */
  export class SerialLockError extends Error {
    constructor(public holder: { owner: string; acquiredAt: number; pid: number }) {
      super(
        `device is controlled by session ${holder.owner} (pid ${holder.pid}) since ` +
          `${new Date(holder.acquiredAt).toISOString()} — pass takeover:true to seize it, or just read it (read tools need no lease)`,
      )
      this.name = "SerialLockError"
    }
  }

  // ── Triggers (server-side reactive automation) ────────────────────────────
  type Trigger = {
    id: string
    response: string
    onPattern?: RegExp
    untilPattern?: RegExp
    every?: { ms: number; timer: ReturnType<typeof setInterval> }
    maxFires?: number
    fires: number
    armedAt: number
    lastFireAt?: number
  }

  // ── Waiters (one-shot pattern blocking) ───────────────────────────────────
  type Waiter = {
    pattern: RegExp
    contextLines: number
    resolve: (result: WaitResult) => void
    timer: ReturnType<typeof setTimeout>
  }

  export type WaitResult =
    | {
        matched: true
        cursor: number
        match: string
        before: string
        after: string
      }
    | {
        matched: false
        cursor: number
        timed_out: true
      }

  function decodeEscapes(input: string): string {
    return input
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\0/g, "\0")
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  }

  // ── Log de-noising (Q1) — display-only transform on RETURNED bytes ─────────
  // Implemented in ./reduce (pure, never throws: CR-overwrite flatten, volatile-
  // token normalization, cyclic-block + consecutive-dup collapse, include/
  // exclude). Re-exported so callers use Serial.reduceLines / Serial.ReduceOptions.
  // NEVER mutates the ring buffer; every cursor stays on raw byte positions.
  export type ReduceOptions = ReduceOptionsImpl
  export const reduceLines = reduceLinesImpl

  // ── EOL handling (Q: \r vs \r\n adaptation) ───────────────────────────────
  // resolveEol maps a devices.json `eol` ("cr"|"lf"|"crlf"|raw) to the actual
  // terminator string. applyEol rewrites ONLY a trailing terminator the caller
  // already sent — so a bare payload (e.g. \x03 ctrl-C, or an unterminated
  // fragment) is left untouched and there's never a double terminator. When the
  // device map specifies no eol, Active.eol is undefined → byte-identical
  // passthrough (pre-0.4 behavior preserved; opt-in per device).
  function resolveEol(raw?: string): string | undefined {
    if (!raw) return undefined
    if (raw === "cr") return "\r"
    if (raw === "lf") return "\n"
    if (raw === "crlf") return "\r\n"
    return raw
  }
  function applyEol(data: string, eol?: string): string {
    return eol ? data.replace(/(?:\r\n|\r|\n)$/, eol) : data
  }
  // Split on \r\n, lone \r, OR \n — for DISPLAY/SPLIT on snapshot COPIES only;
  // never mutates the ring buffer or cursor accounting. Lets a \r-only device's
  // output break into lines for digest / wait-context.
  function splitLines(s: string): string[] {
    return s.split(/\r\n|\r|\n/)
  }

  export type Socket = {
    readyState: number
    data?: unknown
    send: (data: string | Uint8Array | ArrayBuffer) => void
    close: (code?: number, reason?: string) => void
  }

  const sock = (ws: Socket) => (ws.data && typeof ws.data === "object" ? ws.data : ws)

  type Active = {
    info: Info
    port: driver.SerialPort
    buffer: string
    bufferCursor: number
    cursor: number
    subscribers: Map<unknown, Socket>
    triggers: Map<string, Trigger>
    waiters: Set<Waiter>
    scanCursor: number
    deviceKey?: string
    eol?: string
    encoding?: "utf8" | "latin1" | "binary"
    owner?: string
    leaseTimer?: ReturnType<typeof setInterval>
    logStream?: WriteStream
  }

  // WebSocket control frame: 0x00 + UTF-8 JSON.
  const meta = (cursor: number) => {
    const json = JSON.stringify({ cursor })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out
  }

  export const Info = z
    .object({
      id: SerialID.zod,
      title: z.string(),
      path: z.string(),
      baudRate: z.number(),
      dataBits: z.number().optional(),
      stopBits: z.number().optional(),
      parity: z.enum(["none", "even", "odd", "mark", "space"]).optional(),
      status: z.enum(["connected", "disconnected", "error"]),
      // Device-lease holder (opencode sessionID). Exposed so monitors can show
      // a "driver: agent …" badge — human input bypasses the lease by design.
      owner: z.string().optional(),
      // Resolved per-device line terminator (\r / \n / \r\n / raw). Surfaced so
      // the monitor uses the SAME eol for human input as the write path uses for
      // the agent, instead of re-matching devices.json by path.
      eol: z.string().optional(),
    })
    .meta({ ref: "Serial" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    path: z.string(),
    baudRate: z.number().default(115200),
    title: z.string().optional(),
    dataBits: z.number().optional(),
    stopBits: z.number().optional(),
    parity: z.enum(["none", "even", "odd", "mark", "space"]).optional(),
    flowControl: z.boolean().optional(),
    // Override the line terminator for this session ("cr"|"lf"|"crlf"|raw).
    // Defaults to the matched device's devices.json `eol`, else passthrough.
    eol: z.string().optional(),
    // Inbound decoding override ("utf8" | "latin1" | "binary"); default from the
    // device map, else "utf8". Use latin1/binary for non-UTF-8 / binary consoles.
    encoding: z.enum(["utf8", "latin1", "binary"]).optional(),
    // Tee raw output to <base>/logs/; default from the device map, else off.
    log: z.boolean().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  // ── Events (replaces the core Bus) ────────────────────────────────────────
  // The core route layer subscribes to these and republishes on the core Bus,
  // so the SDK event stream keeps emitting serial.created/data/etc.
  export type EventMap = {
    "serial.created": { info: Info }
    "serial.updated": { info: Info }
    "serial.data": { id: SerialID; data: string }
    "serial.disconnected": { id: SerialID }
    "serial.deleted": { id: SerialID }
  }

  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)

  function emit<K extends keyof EventMap>(type: K, payload: EventMap[K]) {
    emitter.emit(type, payload)
  }

  export const events = {
    on<K extends keyof EventMap>(type: K, handler: (payload: EventMap[K]) => void): () => void {
      emitter.on(type, handler as (p: unknown) => void)
      return () => emitter.off(type, handler as (p: unknown) => void)
    },
  }

  export type SnapshotOptions = {
    tailBytes?: number
    sinceCursor?: number
    maxBytes?: number
    /** Keep ANSI/control bytes in the returned text. Default false → stripped
     *  for the agent (the raw bytes always stay in the ring buffer + WS). */
    raw?: boolean
  }

  export type SnapshotResult = {
    data: string
    cursor: number
    bufferCursor: number
    fromCursor: number
    dropped: number
  }

  export type ArmInput = {
    response: string
    onPattern?: string
    everyMs?: number
    untilPattern?: string
    maxFires?: number
    timeoutMs?: number
  }

  export type GrepResult = {
    matches: Array<{ line: string; cursor: number }>
    scannedFrom: number
    scannedTo: number
    truncated: boolean
  }

  export type DigestResult = {
    lines: number
    bytes: number
    firstLine: string
    lastLine: string
    errorLines: string[]
    cursor: number
  }

  export type ProbeResult = {
    path: string
    serialNumber?: string
    vendorId?: string
    productId?: string
    deviceName?: string
    model?: string
    alive: boolean
    busy?: boolean
    banner?: string
    detectedPrompt?: string
  }

  // ── State (replaces InstanceState) ────────────────────────────────────────
  const sessions = new Map<SerialID, Active>()

  function teardown(session: Active) {
    if (session.leaseTimer) clearInterval(session.leaseTimer)
    if (locks && session.deviceKey && session.owner) locks.release(session.deviceKey, session.owner)
    if (session.logStream) {
      try {
        session.logStream.end()
      } catch {}
      session.logStream = undefined
    }
    for (const t of session.triggers.values()) {
      if (t.every) clearInterval(t.every.timer)
    }
    session.triggers.clear()
    for (const w of session.waiters) {
      clearTimeout(w.timer)
      try {
        w.resolve({ matched: false, cursor: session.cursor, timed_out: true })
      } catch {}
    }
    session.waiters.clear()
    try {
      session.port.close()
    } catch {}
    for (const [sub, ws] of session.subscribers.entries()) {
      try {
        if (sock(ws) === sub) ws.close()
      } catch {}
    }
    session.subscribers.clear()
  }

  // Tear down every session — call from the host plugin's dispose hook.
  export function disposeAll() {
    for (const session of sessions.values()) teardown(session)
    sessions.clear()
  }

  function fireTrigger(active: Active, t: Trigger) {
    try {
      active.port.write(t.response)
      t.fires += 1
      t.lastFireAt = Date.now()
    } catch {
      disarmInternal(active, t.id)
      return
    }
    if (typeof t.maxFires === "number" && t.fires >= t.maxFires) {
      disarmInternal(active, t.id)
    }
  }

  function disarmInternal(active: Active, triggerId: string): boolean {
    const t = active.triggers.get(triggerId)
    if (!t) return false
    if (t.every) clearInterval(t.every.timer)
    active.triggers.delete(triggerId)
    return true
  }

  function evaluate(active: Active) {
    if (active.triggers.size === 0 && active.waiters.size === 0) return

    const totalEnd = active.cursor
    const lookbackStart = Math.max(active.scanCursor - SCAN_LOOKBACK, active.bufferCursor)
    const offset = Math.max(0, lookbackStart - active.bufferCursor)
    const window = active.buffer.slice(offset)

    if (active.triggers.size > 0) {
      for (const t of [...active.triggers.values()]) {
        if (t.untilPattern) {
          t.untilPattern.lastIndex = 0
          if (t.untilPattern.test(window)) {
            disarmInternal(active, t.id)
            continue
          }
        }
        if (!t.every && t.onPattern) {
          t.onPattern.lastIndex = 0
          if (t.onPattern.test(window)) {
            fireTrigger(active, t)
          }
        }
      }
    }

    if (active.waiters.size > 0) {
      for (const w of [...active.waiters]) {
        w.pattern.lastIndex = 0
        const match = w.pattern.exec(window)
        if (!match) continue
        active.waiters.delete(w)
        clearTimeout(w.timer)
        const matchStart = match.index ?? 0
        const matchEnd = matchStart + match[0].length
        const beforeText = window.slice(0, matchStart)
        const afterText = window.slice(matchEnd)
        const beforeLines = splitLines(beforeText)
        const afterLines = splitLines(afterText)
        try {
          w.resolve({
            matched: true,
            cursor: totalEnd,
            match: stripAnsi(match[0]),
            before: stripAnsi(beforeLines.slice(-(w.contextLines + 1)).join("\n")),
            after: stripAnsi(afterLines.slice(0, w.contextLines + 1).join("\n")),
          })
        } catch {}
      }
    }

    active.scanCursor = totalEnd
  }

  export async function list(): Promise<Info[]> {
    return Array.from(sessions.values()).map((session) => session.info)
  }

  export async function get(id: SerialID): Promise<Info | undefined> {
    return sessions.get(id)?.info
  }

  // Resolve the USB descriptor for a device path (so we can derive a stable
  // deviceKey + match the device map). Falls back to a path-based key.
  async function portForPath(p: string): Promise<Devices.PortLike | undefined> {
    try {
      const ports = await driver.listPorts()
      return ports.find((x) => x.path === p)
    } catch {
      return undefined
    }
  }

  // Renew the device lease every 20s while a session is open so a live owner
  // keeps it (a crashed owner's lease expires at its TTL). Reads session.owner
  // at fire time, so a takeover/rebind that swaps the owner keeps renewing.
  // Idempotent — safe to call from the fresh-open, reuse, and write paths.
  function startLeaseTimer(session: Active) {
    if (session.leaseTimer) return
    session.leaseTimer = setInterval(() => {
      if (locks && session.deviceKey && session.owner) locks.renew(session.deviceKey, session.owner)
    }, 20_000)
  }

  // MobaXterm-style session logging: tee raw output to <base>/logs/. Idempotent
  // so it can be turned on from the fresh-open OR the reuse path (e.g. an
  // autoOpen'd session a later create asks to log). For latin1/binary sessions
  // the onData tee reconstructs the original bytes so the file is byte-exact.
  function openSessionLog(session: Active) {
    if (session.logStream || !baseDirPath) return
    try {
      const dir = nodePath.join(baseDirPath, "logs")
      mkdirSync(dir, { recursive: true })
      const safe = session.info.path.replace(/[^A-Za-z0-9._-]+/g, "_") || "session"
      session.logStream = createWriteStream(nodePath.join(dir, `${safe}-${session.info.id}.log`), { flags: "a" })
    } catch {
      // logging is best-effort; never block the session
    }
  }

  export async function create(
    input: CreateInput,
    ctx?: { owner?: string; takeover?: boolean },
  ): Promise<Info> {
    const owner = ctx?.owner
    const portInfo = await portForPath(input.path)
    const deviceKey = portInfo ? Devices.deviceKey(portInfo) : `path:${input.path}`
    const matchedDev = portInfo ? Devices.match(portInfo) : undefined
    const encoding = input.encoding ?? matchedDev?.encoding
    const logEnabled = input.log ?? matchedDev?.log ?? false

    // Device lease: one writer per physical prototype. Acquire BEFORE reuse so
    // a second agent can't latch onto a shared session it isn't allowed to drive.
    if (locks && owner) {
      const denied = locks.acquire(deviceKey, owner, { takeover: ctx?.takeover })
      if (denied) throw new SerialLockError(denied)
    }

    // Port-level multiplex: the OS only allows one process to hold a device
    // path at a time. Reuse an existing session on the same path/params so the
    // Serial Monitor UI and the agent tools coexist without EBUSY — each
    // subscriber attaches via WebSocket to the same session.
    for (const existing of sessions.values()) {
      const e = existing.info
      if (
        e.path === input.path &&
        e.baudRate === input.baudRate &&
        (input.dataBits === undefined || e.dataBits === input.dataBits) &&
        (input.stopBits === undefined || e.stopBits === input.stopBits) &&
        (input.parity === undefined || e.parity === input.parity)
      ) {
        log.info("Serial.create reusing existing session for same path/params", { id: e.id, path: e.path })
        // We now hold the lease (acquire above didn't throw) — bind it, start
        // the heartbeat (an autoOpen'd / owner-less session had none), and
        // surface the new driver to monitors. deviceKey first so renew has it.
        existing.deviceKey = deviceKey
        // encoding/eol are fixed at first open (can't change a live port); only
        // logging can be turned on later for an already-open session.
        if (logEnabled) openSessionLog(existing)
        if (owner) {
          existing.owner = owner
          existing.info.owner = owner
          startLeaseTimer(existing)
          emit("serial.updated", { info: existing.info })
        }
        return e
      }
    }
    const id = SerialID.ascending()

    const port = driver.open(input.path, {
      baudRate: input.baudRate,
      dataBits: input.dataBits,
      stopBits: input.stopBits,
      parity: input.parity,
      flowControl: input.flowControl,
      encoding,
    })

    const defaultTitle = matchedDev
      ? `${matchedDev.name}${matchedDev.model ? ` (${matchedDev.model})` : ""}`
      : /^telnet:\/\//i.test(input.path)
        ? input.path.replace(/^telnet:\/\//i, "")
        : `Serial ${id.slice(-4)}`

    // Per-device line terminator: explicit create override wins, else the
    // device map's eol, else undefined (passthrough). Applies to BOTH agent
    // writes (Serial.write) and the monitor's human input (reads it off Info).
    const eol = resolveEol(input.eol ?? matchedDev?.eol)

    const info: Info = {
      id,
      title: input.title || defaultTitle,
      path: input.path,
      baudRate: input.baudRate,
      dataBits: input.dataBits,
      stopBits: input.stopBits,
      parity: input.parity,
      status: "connected",
      owner,
      eol,
    }
    const session: Active = {
      info,
      port,
      buffer: "",
      bufferCursor: 0,
      cursor: 0,
      subscribers: new Map(),
      triggers: new Map(),
      waiters: new Set(),
      scanCursor: 0,
      deviceKey,
      eol,
      encoding,
      owner,
    }
    sessions.set(id, session)

    if (locks && owner) startLeaseTimer(session)

    if (logEnabled) openSessionLog(session)

    port.onData((chunk) => {
      session.cursor += chunk.length

      if (session.logStream) {
        try {
          session.logStream.write(
            session.encoding === "latin1" || session.encoding === "binary" ? Buffer.from(chunk, "latin1") : chunk,
          )
        } catch {
          // log write failed (disk full etc.) — never affect the live session
        }
      }

      for (const [key, ws] of session.subscribers.entries()) {
        if (ws.readyState !== 1) {
          session.subscribers.delete(key)
          continue
        }
        if (sock(ws) !== key) {
          session.subscribers.delete(key)
          continue
        }
        try {
          ws.send(chunk)
        } catch {
          session.subscribers.delete(key)
        }
      }

      session.buffer += chunk
      if (session.buffer.length > BUFFER_LIMIT) {
        const excess = session.buffer.length - BUFFER_LIMIT
        session.buffer = session.buffer.slice(excess)
        session.bufferCursor += excess

        emit("serial.data", { id: session.info.id, data: chunk })
      }

      // Realtime reaction path: a pattern match here triggers `port.write`
      // within the same tick, no LLM in the loop.
      evaluate(session)
    })

    port.onExit(({ exitCode }) => {
      if (session.info.status === "disconnected") return
      log.info("session disconnected", { id, exitCode })
      session.info.status = "disconnected"
      emit("serial.disconnected", { id: session.info.id })
      void remove(id)
    })

    emit("serial.created", { info })
    return info
  }

  export async function update(id: SerialID, input: UpdateInput): Promise<Info | undefined> {
    const session = sessions.get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title
    }
    emit("serial.updated", { info: session.info })
    return session.info
  }

  export async function remove(id: SerialID): Promise<void> {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    log.info("removing session", { id })
    teardown(session)
    emit("serial.deleted", { id: session.info.id })
  }

  export async function connect(
    id: SerialID,
    ws: Socket,
    cursor?: number,
  ): Promise<{ onMessage: (message: string | ArrayBuffer) => void; onClose: () => void } | undefined> {
    const session = sessions.get(id)
    if (!session) {
      ws.close()
      return
    }
    log.info("client connected to session", { id })

    const sub = sock(ws)
    session.subscribers.delete(sub)
    session.subscribers.set(sub, ws)

    const cleanup = () => {
      session.subscribers.delete(sub)
    }

    const start = session.bufferCursor
    const end = session.cursor
    const from =
      cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

    const data = (() => {
      if (!session.buffer) return ""
      if (from >= end) return ""
      const offset = Math.max(0, from - start)
      if (offset >= session.buffer.length) return ""
      return session.buffer.slice(offset)
    })()

    if (data) {
      try {
        for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
          ws.send(data.slice(i, i + BUFFER_CHUNK))
        }
      } catch {
        cleanup()
        ws.close()
        return
      }
    }

    try {
      ws.send(meta(end))
    } catch {
      cleanup()
      ws.close()
      return
    }

    return {
      onMessage: (message: string | ArrayBuffer) => {
        session.port.write(String(message))
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        cleanup()
      },
    }
  }

  export async function listPorts(): Promise<
    Array<{
      path: string
      manufacturer?: string
      serialNumber?: string
      pnpId?: string
      vendorId?: string
      productId?: string
    }>
  > {
    return driver.listPorts()
  }

  // listPorts enriched with the device-map match — answers "which port is which
  // prototype/model" from the static map, no probing needed (Q2).
  export async function listPortsAnnotated(): Promise<
    Array<
      Awaited<ReturnType<typeof listPorts>>[number] & {
        deviceName?: string
        model?: string
        suggestedBaud?: number
        deviceKey: string
        inUse: boolean
      }
    >
  > {
    const ports = await driver.listPorts()
    const openPaths = new Set([...sessions.values()].map((s) => s.info.path))
    return ports.map((p) => {
      const d = Devices.match(p)
      return {
        ...p,
        deviceName: d?.name,
        model: d?.model,
        suggestedBaud: d?.baudRate,
        deviceKey: Devices.deviceKey(p),
        inUse: openPaths.has(p.path),
      }
    })
  }

  export function listDevices(): Devices.Device[] {
    return Devices.all()
  }

  export function reloadDevices(): { count: number; from?: string } {
    return Devices.reload()
  }

  export async function scaffoldDevices(): Promise<{ devices: Devices.Device[] }> {
    return Devices.scaffold(await driver.listPorts())
  }

  export function writeDevices(list: Devices.Device[]): { ok: boolean; from?: string } {
    return Devices.save(list)
  }

  // Lease enumeration / force-release for the win-console panel.
  export function leaseList() {
    return locks?.list() ?? []
  }
  export function forceReleaseLease(deviceKey: string): boolean {
    const released = locks?.forceRelease(deviceKey) ?? false
    // Also clear the in-process session that believes it holds this device, so
    // the monitor badge clears and the kicked owner must re-acquire on its next
    // write. ADVISORY: this does not interrupt an in-flight write, and the
    // kicked agent will silently re-acquire on its next write() (re-acquire
    // semantics) unless another agent grabs the device first.
    for (const s of sessions.values()) {
      if (s.deviceKey === deviceKey && s.owner) {
        if (s.leaseTimer) {
          clearInterval(s.leaseTimer)
          s.leaseTimer = undefined
        }
        s.owner = undefined
        s.info.owner = undefined
        emit("serial.updated", { info: s.info })
      }
    }
    return released
  }

  // ── Auto-open (startup) ─────────────────────────────────────────────────────
  // Open every devices.json entry flagged autoOpen with a concrete match.path,
  // so /serial shows the session without waiting for the agent to serial_create.
  // Sessions open with NO owner (lease stays free) — an agent can lease them
  // later via create()'s reuse path. Per-device failures (unplugged / EBUSY) are
  // swallowed so one bad port doesn't block the rest.
  export async function autoOpenConfigured(): Promise<{ opened: string[]; failed: string[] }> {
    const targets = Devices.all().filter((d) => d.autoOpen && d.match?.path)
    const opened: string[] = []
    const failed: string[] = []
    // Open in parallel so one slow/unplugged port (esp. telnet://) can't
    // serialize the rest. Each open is independently try/caught.
    await Promise.allSettled(
      targets.map(async (d) => {
        const p = d.match!.path!
        try {
          await create({ path: p, baudRate: d.baudRate ?? 115200, title: d.name })
          opened.push(p)
        } catch {
          failed.push(p)
        }
      }),
    )
    return { opened, failed }
  }

  // ── Probe (Q2): is a live machine on this port, and what is it? ────────────
  // Transiently opens each candidate, listens (and optionally nudges with
  // \r\n), classifies the banner against the device map's readyRe (or generic
  // prompts), then closes. Honors one-session-per-path: open ports are reported
  // busy without being disturbed.
  export async function probe(opts?: {
    paths?: string[]
    nudge?: boolean
    timeoutMs?: number
  }): Promise<ProbeResult[]> {
    const timeoutMs = opts?.timeoutMs ?? 1500
    const nudge = opts?.nudge ?? true
    let ports = await driver.listPorts()
    if (opts?.paths?.length) ports = ports.filter((p) => opts.paths!.includes(p.path))
    const openPaths = new Set([...sessions.values()].map((s) => s.info.path))

    const results: ProbeResult[] = []
    for (const port of ports) {
      const dev = Devices.match(port)
      const base: ProbeResult = {
        path: port.path,
        serialNumber: port.serialNumber,
        vendorId: port.vendorId,
        productId: port.productId,
        deviceName: dev?.name,
        model: dev?.model,
        alive: false,
      }
      if (openPaths.has(port.path)) {
        results.push({ ...base, alive: true, busy: true, banner: "(in use by an open session)" })
        continue
      }
      try {
        const r = await probeOne(port.path, dev?.baudRate ?? 115200, {
          nudge,
          timeoutMs,
          readyRe: dev?.prompt?.readyRe,
        })
        results.push({ ...base, alive: r.bytes > 0, banner: r.banner, detectedPrompt: r.detectedPrompt })
      } catch (e) {
        results.push({ ...base, alive: false, banner: `probe error: ${(e as Error).message}` })
      }
    }
    return results
  }

  function probeOne(
    path: string,
    baudRate: number,
    o: { nudge: boolean; timeoutMs: number; readyRe?: string },
  ): Promise<{ bytes: number; banner: string; detectedPrompt?: string }> {
    return new Promise((resolve) => {
      let buf = ""
      let done = false
      let port: driver.SerialPort | undefined
      const finish = () => {
        if (done) return
        done = true
        try {
          port?.close()
        } catch {}
        const generic = /(?:=>\s|#\s|\$\s|login:|BusyBox|U-Boot|ets\s|rst:0x)/
        const re = o.readyRe ? new RegExp(o.readyRe) : generic
        const m = buf.match(re)
        resolve({ bytes: buf.length, banner: buf.slice(-512), detectedPrompt: m ? m[0] : undefined })
      }
      try {
        port = driver.open(path, { baudRate })
        port.onData((c) => {
          buf += c
          if (buf.length > 8192) finish()
        })
        port.onExit(() => finish())
        if (o.nudge) setTimeout(() => {
          try {
            port?.write("\r\n")
          } catch {}
        }, 150)
        setTimeout(finish, o.timeoutMs)
      } catch (e) {
        resolve({ bytes: 0, banner: `open failed: ${(e as Error).message}` })
      }
    })
  }

  export async function write(id: SerialID, data: string, owner?: string): Promise<void> {
    const session = sessions.get(id)
    if (session && session.info.status === "connected") {
      if (locks && session.deviceKey && owner) {
        // Re-acquire (not just check): refreshes our hold, blocks only a
        // DIFFERENT live owner, and re-grabs a lease that was force-released or
        // expired — restoring a single writer after an advisory kick. Re-bind
        // the badge/heartbeat if ownership changed.
        const denied = locks.acquire(session.deviceKey, owner)
        if (denied) throw new SerialLockError(denied)
        if (session.owner !== owner) {
          session.owner = owner
          session.info.owner = owner
          startLeaseTimer(session)
          emit("serial.updated", { info: session.info })
        }
      }
      // Normalize the trailing terminator to the device's eol so the agent can
      // keep emitting \r\n (its documented habit) and a \r-only device still
      // gets a bare \r. No-op when no device eol is configured.
      session.port.write(applyEol(data, session.eol))
      // Mirror newline-terminated agent commands into the shared per-device
      // history file so the human monitor can ↑-recall what the agent ran.
      if (owner && /[\r\n]$/.test(data)) appendSharedHistory(session.info.path, data)
    }
  }

  // ── Shared command history ──────────────────────────────────────────────────
  // One JSON per device path — the SAME file/format the TUI monitor's
  // HistoryStore reads and writes (<home>/.opencode/serial/history/<path>.json,
  // { version: 1, entries: [{ cmd, source, at }] }, cap 500, consecutive
  // dedup). Keep the sanitize rule in sync with monitor.tsx or the keys split.
  // Best-effort: failures never affect the write path. Concurrent TUI/server
  // writers are last-writer-wins.
  const HISTORY_CAP = 500
  function appendSharedHistory(portPath: string, data: string) {
    try {
      const cmd = data.replace(/[\r\n]+$/, "")
      if (!cmd.trim()) return
      const dir = nodePath.join(os.homedir(), ".opencode", "serial", "history")
      const file = nodePath.join(dir, (portPath.replace(/[^A-Za-z0-9._-]+/g, "_") || "default") + ".json")
      let entries: Array<{ cmd: string; source: string; at: number }> = []
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: typeof entries }
        if (Array.isArray(raw.entries)) entries = raw.entries
      } catch {}
      const last = entries[entries.length - 1]
      if (last && last.cmd === cmd) {
        last.at = Date.now()
      } else {
        entries.push({ cmd, source: "agent", at: Date.now() })
        if (entries.length > HISTORY_CAP) entries = entries.slice(-HISTORY_CAP)
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, entries }))
    } catch {
      // best-effort
    }
  }

  export async function snapshot(id: SerialID, options?: SnapshotOptions): Promise<SnapshotResult | undefined> {
    const session = sessions.get(id)
    if (!session) return undefined

    const totalEnd = session.cursor
    const totalStart = session.bufferCursor
    const buffer = session.buffer

    let sliceOffset: number
    let fromCursor: number
    let dropped = 0
    if (typeof options?.sinceCursor === "number") {
      fromCursor = Math.max(options.sinceCursor, totalStart)
      dropped = Math.max(0, totalStart - options.sinceCursor)
      sliceOffset = fromCursor - totalStart
    } else if (typeof options?.tailBytes === "number" && options.tailBytes > 0) {
      if (options.tailBytes < buffer.length) {
        sliceOffset = buffer.length - options.tailBytes
        fromCursor = totalStart + sliceOffset
      } else {
        sliceOffset = 0
        fromCursor = totalStart
      }
    } else {
      sliceOffset = 0
      fromCursor = totalStart
    }

    let data = sliceOffset >= 0 && sliceOffset < buffer.length ? buffer.slice(sliceOffset) : ""
    if (typeof options?.maxBytes === "number" && options.maxBytes > 0 && data.length > options.maxBytes) {
      data = data.slice(data.length - options.maxBytes)
      fromCursor = totalEnd - data.length
    }

    // Strip ANSI/control bytes for the agent (display-only; the ring buffer and
    // the WebSocket replay keep the escapes so the monitor renders color). The
    // cursors above are decoded-string code-unit positions and stay correct —
    // stripping only shortens this returned copy.
    if (!options?.raw) data = stripAnsi(data)

    return { data, cursor: totalEnd, bufferCursor: totalStart, fromCursor, dropped }
  }

  // ── Digest (Q1): structured "did anything break?" summary, ~10 lines ───────
  export async function digest(
    id: SerialID,
    options?: { sinceCursor?: number; tailBytes?: number },
  ): Promise<DigestResult | undefined> {
    const snap = await snapshot(id, {
      sinceCursor: options?.sinceCursor,
      tailBytes: options?.sinceCursor === undefined ? (options?.tailBytes ?? 65536) : undefined,
    })
    if (!snap) return undefined
    const lines = splitLines(snap.data)
    const errRe = /err|fail|panic|warn|fatal|exception|traceback|segfault|oops|assert/i
    const errorLines: string[] = []
    const seen = new Set<string>()
    for (const l of lines) {
      if (errRe.test(l)) {
        const k = l.trim()
        if (k && !seen.has(k)) {
          seen.add(k)
          errorLines.push(l)
          if (errorLines.length >= 20) break
        }
      }
    }
    return {
      lines: lines.length,
      bytes: snap.data.length,
      firstLine: lines[0] ?? "",
      lastLine: lines[lines.length - 1] ?? "",
      errorLines,
      cursor: snap.cursor,
    }
  }

  export async function grep(
    id: SerialID,
    options: { pattern: string; sinceCursor?: number; tailBytes?: number; maxMatches?: number },
  ): Promise<GrepResult | undefined> {
    const session = sessions.get(id)
    if (!session) return undefined

    let re: RegExp
    try {
      re = new RegExp(options.pattern)
    } catch (e) {
      throw new Error(`invalid grep pattern /${options.pattern}/: ${(e as Error).message}`)
    }
    const totalEnd = session.cursor
    const totalStart = session.bufferCursor
    const buffer = session.buffer
    const maxMatches = options.maxMatches ?? 50

    let sliceOffset: number
    let fromCursor: number
    if (typeof options.sinceCursor === "number") {
      fromCursor = Math.max(options.sinceCursor, totalStart)
      sliceOffset = fromCursor - totalStart
    } else if (typeof options.tailBytes === "number" && options.tailBytes > 0) {
      if (options.tailBytes < buffer.length) {
        sliceOffset = buffer.length - options.tailBytes
      } else {
        sliceOffset = 0
      }
      fromCursor = totalStart + sliceOffset
    } else {
      sliceOffset = 0
      fromCursor = totalStart
    }

    const slice = sliceOffset >= 0 && sliceOffset < buffer.length ? buffer.slice(sliceOffset) : ""
    const matches: Array<{ line: string; cursor: number }> = []
    // Walk lines with EXACT byte offsets, honoring \r\n / lone \r / \n
    // terminators, so each match's cursor stays accurate regardless of the
    // device's line ending (the old `+1` math assumed single-char \n).
    const sep = /\r\n|\r|\n/g
    let lineStart = 0
    let sm: RegExpExecArray | null
    let stop = false
    const scanLine = (line: string, startOff: number): boolean => {
      // Match + return ANSI-stripped lines so a colored "error" still matches
      // and the agent gets clean text. Cursor stays the RAW byte offset.
      const clean = stripAnsi(line)
      re.lastIndex = 0
      if (re.test(clean)) {
        matches.push({ line: clean, cursor: fromCursor + startOff })
        if (matches.length >= maxMatches) return true
      }
      return false
    }
    while (!stop && (sm = sep.exec(slice)) !== null) {
      stop = scanLine(slice.slice(lineStart, sm.index), lineStart)
      lineStart = sm.index + sm[0].length
    }
    if (!stop) {
      const tail = slice.slice(lineStart)
      if (tail.length) scanLine(tail, lineStart)
    }

    return {
      matches,
      scannedFrom: fromCursor,
      scannedTo: totalEnd,
      // Only truncated if the scan actually hit the cap with more to find — not
      // when the buffer happened to contain exactly maxMatches and ran to end.
      truncated: stop,
    }
  }

  export async function wait(
    id: SerialID,
    options: { pattern: string; timeoutMs: number; contextLines?: number },
  ): Promise<WaitResult | undefined> {
    const session = sessions.get(id)
    if (!session) return undefined

    let re: RegExp
    try {
      re = new RegExp(options.pattern, "m")
    } catch (e) {
      throw new Error(`invalid wait pattern /${options.pattern}/: ${(e as Error).message}`)
    }
    const contextLines = options.contextLines ?? 3

    // Fast path: pattern is already in the buffer.
    re.lastIndex = 0
    const existingMatch = re.exec(session.buffer)
    if (existingMatch) {
      const matchStart = existingMatch.index ?? 0
      const matchEnd = matchStart + existingMatch[0].length
      const beforeText = session.buffer.slice(0, matchStart)
      const afterText = session.buffer.slice(matchEnd)
      return {
        matched: true,
        cursor: session.cursor,
        match: stripAnsi(existingMatch[0]),
        before: stripAnsi(splitLines(beforeText).slice(-(contextLines + 1)).join("\n")),
        after: stripAnsi(splitLines(afterText).slice(0, contextLines + 1).join("\n")),
      }
    }

    // Slow path: register a one-shot Waiter; `evaluate()` on the next chunk
    // resolves us, or the timer fires first.
    return new Promise<WaitResult>((resolve) => {
      const waiter: Waiter = {
        pattern: re,
        contextLines,
        resolve: (r) => {
          clearTimeout(waiter.timer)
          session.waiters.delete(waiter)
          resolve(r)
        },
        timer: setTimeout(() => {
          session.waiters.delete(waiter)
          resolve({ matched: false, cursor: session.cursor, timed_out: true })
        }, options.timeoutMs),
      }
      session.waiters.add(waiter)
    })
  }

  export async function arm(id: SerialID, input: ArmInput, owner?: string): Promise<string | undefined> {
    const session = sessions.get(id)
    if (!session) return undefined

    // A trigger writes to the port, so it needs the lease just like write() —
    // re-acquire so an armed agent (re)takes the lease and a different live
    // owner is blocked.
    if (locks && session.deviceKey && owner) {
      const denied = locks.acquire(session.deviceKey, owner)
      if (denied) throw new SerialLockError(denied)
      if (session.owner !== owner) {
        session.owner = owner
        session.info.owner = owner
        startLeaseTimer(session)
        emit("serial.updated", { info: session.info })
      }
    }

    let onPattern: RegExp | undefined
    let untilPattern: RegExp | undefined
    try {
      onPattern = input.onPattern ? new RegExp(input.onPattern) : undefined
      untilPattern = input.untilPattern ? new RegExp(input.untilPattern) : undefined
    } catch (e) {
      throw new Error(`invalid arm pattern: ${(e as Error).message}`)
    }

    const triggerId = "trg_" + randomBytes(6).toString("hex")
    const trigger: Trigger = {
      id: triggerId,
      // Same eol normalization as write() — a u-boot break spam armed as
      // "slp\r\n" reaches a \r-only board as "slp\r".
      response: applyEol(input.response, session.eol),
      onPattern,
      untilPattern,
      maxFires: input.maxFires,
      fires: 0,
      armedAt: Date.now(),
    }

    if (typeof input.everyMs === "number" && input.everyMs > 0) {
      trigger.every = {
        ms: input.everyMs,
        timer: setInterval(() => fireTrigger(session, trigger), input.everyMs),
      }
    }
    if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
      setTimeout(() => disarmInternal(session, triggerId), input.timeoutMs).unref?.()
    }

    session.triggers.set(triggerId, trigger)
    return triggerId
  }

  export async function disarm(id: SerialID, triggerId: string): Promise<boolean> {
    const session = sessions.get(id)
    if (!session) return false
    return disarmInternal(session, triggerId)
  }

  // Re-exported so callers can decode escape sequences (\r \n \t \xNN \u####)
  // the same way the tool layer does.
  export const decode = decodeEscapes
}
