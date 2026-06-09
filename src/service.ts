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
import { z } from "zod"
import * as driver from "#serial-driver"
import { SerialID } from "./schema"
import * as Devices from "./devices"
import { LockManager } from "./locks"
import { reduceLines as reduceLinesImpl, type ReduceOptions as ReduceOptionsImpl } from "./reduce"

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

  // ── Configuration (base dir for device map + lock files) ──────────────────
  let locks: LockManager | undefined

  export function configure(opts: { base: string }) {
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
    owner?: string
    leaseTimer?: ReturnType<typeof setInterval>
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
        const beforeLines = beforeText.split(/\r?\n/)
        const afterLines = afterText.split(/\r?\n/)
        try {
          w.resolve({
            matched: true,
            cursor: totalEnd,
            match: match[0],
            before: beforeLines.slice(-(w.contextLines + 1)).join("\n"),
            after: afterLines.slice(0, w.contextLines + 1).join("\n"),
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

  export async function create(
    input: CreateInput,
    ctx?: { owner?: string; takeover?: boolean },
  ): Promise<Info> {
    const owner = ctx?.owner
    const portInfo = await portForPath(input.path)
    const deviceKey = portInfo ? Devices.deviceKey(portInfo) : `path:${input.path}`
    const matchedDev = portInfo ? Devices.match(portInfo) : undefined

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
        // We now hold the lease (acquire above didn't throw) — bind it.
        if (owner) existing.owner = owner
        existing.deviceKey = deviceKey
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
    })

    const defaultTitle = matchedDev
      ? `${matchedDev.name}${matchedDev.model ? ` (${matchedDev.model})` : ""}`
      : `Serial ${id.slice(-4)}`

    const info: Info = {
      id,
      title: input.title || defaultTitle,
      path: input.path,
      baudRate: input.baudRate,
      dataBits: input.dataBits,
      stopBits: input.stopBits,
      parity: input.parity,
      status: "connected",
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
      owner,
    }
    sessions.set(id, session)

    // Heartbeat the lease while the session is open so a live owner keeps it,
    // but a crashed owner's lease expires (TTL). Renews for session.owner read
    // at fire time, so a takeover that swaps owner keeps renewing correctly.
    if (locks && owner) {
      session.leaseTimer = setInterval(() => {
        if (locks && session.deviceKey && session.owner) locks.renew(session.deviceKey, session.owner)
      }, 20_000)
    }

    port.onData((chunk) => {
      session.cursor += chunk.length

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
        const c = locks.check(session.deviceKey, owner)
        if (!c.ok) throw new SerialLockError(c.holder!)
      }
      session.port.write(data)
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
    const lines = snap.data.split("\n")
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

    const re = new RegExp(options.pattern)
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
    let cursorAt = fromCursor
    const lines = slice.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      re.lastIndex = 0
      if (re.test(line)) {
        matches.push({ line, cursor: cursorAt })
        if (matches.length >= maxMatches) break
      }
      cursorAt += line.length + (i < lines.length - 1 ? 1 : 0)
    }

    return {
      matches,
      scannedFrom: fromCursor,
      scannedTo: totalEnd,
      truncated: matches.length >= maxMatches,
    }
  }

  export async function wait(
    id: SerialID,
    options: { pattern: string; timeoutMs: number; contextLines?: number },
  ): Promise<WaitResult | undefined> {
    const session = sessions.get(id)
    if (!session) return undefined

    const re = new RegExp(options.pattern, "m")
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
        match: existingMatch[0],
        before: beforeText.split(/\r?\n/).slice(-(contextLines + 1)).join("\n"),
        after: afterText.split(/\r?\n/).slice(0, contextLines + 1).join("\n"),
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

    // A trigger writes to the port, so it needs the lease just like write().
    if (locks && session.deviceKey && owner) {
      const c = locks.check(session.deviceKey, owner)
      if (!c.ok) throw new SerialLockError(c.holder!)
    }

    const triggerId = "trg_" + randomBytes(6).toString("hex")
    const trigger: Trigger = {
      id: triggerId,
      response: input.response,
      onPattern: input.onPattern ? new RegExp(input.onPattern) : undefined,
      untilPattern: input.untilPattern ? new RegExp(input.untilPattern) : undefined,
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
