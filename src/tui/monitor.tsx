/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "../vendor/tui"
import { createSignal, createMemo, createEffect, onCleanup, For, Index, Show, batch } from "solid-js"
import { useKeyboard, useTerminalDimensions, usePaste } from "@opentui/solid"
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseLine, type Style } from "./ansi"
import { stripAnsi } from "../reduce"

/**
 * Serial monitor — TUI plugin (terminal view).
 *
 * Attaches to the plugin's OWN /serial server, discovers it via api.json, polls
 * the session list, and streams a session's bytes over the WebSocket.
 *
 *   - app_bottom bar : compact live status per session (auto-appears on create).
 *   - sidebar block  : active sessions + status dot.
 *   - full-screen monitor (route "serial.monitor"): a WINDOWED terminal view —
 *     only the visible rows are rendered (cheap at any scrollback depth) with
 *     ANSI/SGR color + local keyword highlight, plus:
 *       · scrollback: PageUp/PageDown scroll; Home/End (when input empty) jump
 *         top/bottom; new data auto-follows only when pinned to the bottom.
 *       · find: "/" (input empty) opens incremental search; n / N jump to the
 *         next / previous matching line; matched lines get a gutter marker.
 *       · input line: type a command, Enter sends (per-device eol); Tab/Ctrl+N
 *         LOCAL completion (history / on-screen tokens / dict); ↑↓ history;
 *         Ctrl+R reverse-i-search; Ctrl+C/Ctrl+G send 0x03.
 *       · RAW mode (F4): byte-for-byte passthrough so the DEVICE shell does
 *         native completion/history/line-editing (type a few chars + Tab → the
 *         device completes a unique name). Raw transiently seizes the port
 *         (agent writes blocked via the server rawHold) and releases on Esc.
 *         Caveat: this is NOT a full VT emulator (opentui has none) — forward
 *         typing + unique completion render fine; cursor-addressed redraws /
 *         multi-column candidate menus may look rough.
 *       · escape is LAYERED (one level per press): raw → search → completion →
 *         clear input → exit route. So Esc-to-exit-/serial stays the last stage.
 *
 * KEYMAP MODE: while mounted we push a keymap mode so host base-mode keys (tab,
 * ctrl+c) fall through; popped on unmount. Older builds without api.mode keep
 * those host keys (hint says so; ctrl+g is the interrupt fallback).
 *
 * Loaded by opencode's TUI plugin loader (reads tui.json, NOT opencode.json) —
 * list the plugin in BOTH configs (see INSTALL.md).
 */

const id = "serial-monitor"
const ROUTE = "serial.monitor"

// Render tuning.
const FLUSH_MS = 33 // ~30fps: coalesce bursty WS chunks into one render/frame
const MAX_LINES = 20000 // scrollback depth (windowed render → cost is viewport-bound)
const BAR_MAX_SESSIONS = 4

// Input tuning.
const HISTORY_CAP = 500
const HISTORY_RELOAD_MS = 2000
const TOKEN_INDEX_TTL_MS = 2000
const DEVICES_TTL_MS = 5000
const NOTICE_MS = 3000
const MAX_CANDIDATES = 50

// Built-in local keyword highlight (applied when the device didn't color the
// run itself). devices.json `highlight` can add more.
const DEFAULT_HIGHLIGHT: Array<{ re: RegExp; color: string }> = [
  { re: /\b(error|fail(ed|ure)?|panic|fatal|critical|oops|segfault|assert)\b/i, color: "#ef2929" },
  { re: /\b(warn(ing)?)\b/i, color: "#fce94f" },
]

type Session = { id: string; title: string; path: string; baudRate: number; status: string; owner?: string; eol?: string; rawHold?: boolean; logPath?: string }

const LOG_VIEW_MAX = 16 * 1024 * 1024 // tail at most 16MB of the log file into the history view

// Read the tail of a (possibly huge) log file without loading it all. Drops a
// leading partial line when truncated. Returns the text + the full size.
function tailFile(p: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const size = statSync(p).size
  if (size <= maxBytes) return { text: readFileSync(p, "utf8"), bytes: size, truncated: false }
  const fd = openSync(p, "r")
  try {
    const buf = Buffer.alloc(maxBytes)
    // Slice to the bytes ACTUALLY read — if the file was rotated/truncated
    // between stat and read, the Buffer's zero-fill would otherwise leak NULs.
    const n = readSync(fd, buf, 0, maxBytes, Math.max(0, size - maxBytes))
    let text = buf.toString("utf8", 0, n)
    const nl = text.indexOf("\n")
    if (nl >= 0) text = text.slice(nl + 1) // drop the leading partial line
    return { text, bytes: size, truncated: true }
  } finally {
    closeSync(fd)
  }
}

function readServerBase(): string | undefined {
  const env = process.env.OPENCODE_SERIAL_URL
  if (env) return env
  const candidates = [
    path.join(process.cwd(), ".opencode", "serial", "api.json"),
    path.join(os.homedir(), ".opencode", "serial", "api.json"),
  ]
  for (const f of candidates) {
    try {
      const info = JSON.parse(readFileSync(f, "utf8")) as { url?: string; port?: number }
      if (info.url) return info.url
      if (typeof info.port === "number") return `http://127.0.0.1:${info.port}`
    } catch {
      // try next
    }
  }
  return undefined
}

function useSessions() {
  const [sessions, setSessions] = createSignal<Session[]>([])
  const refresh = async () => {
    const base = readServerBase()
    if (!base) return
    try {
      const res = await fetch(`${base}/serial`)
      const data = await res.json()
      if (Array.isArray(data)) setSessions(data as Session[])
    } catch {
      // keep last list
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 1500)
  onCleanup(() => clearInterval(timer))
  return sessions
}

function dotColor(theme: Record<string, any>, status: string) {
  if (status === "connected") return theme.success
  if (status === "error") return theme.error
  return theme.textMuted
}

// ── devices.json (client-side, read-only) ────────────────────────────────────
type DeviceEx = {
  name?: string
  match?: { path?: string }
  eol?: string
  commands?: string[]
  localEcho?: boolean
  highlight?: Array<{ pattern: string; color: string }>
}
let devCache: { at: number; list: DeviceEx[] } | undefined
function readDevices(): DeviceEx[] {
  const now = Date.now()
  if (devCache && now - devCache.at < DEVICES_TTL_MS) return devCache.list
  let list: DeviceEx[] = []
  for (const f of [
    path.join(process.cwd(), ".opencode", "serial", "devices.json"),
    path.join(os.homedir(), ".opencode", "serial", "devices.json"),
  ]) {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as { devices?: DeviceEx[] }
      if (Array.isArray(raw.devices)) {
        list = raw.devices
        break
      }
    } catch {
      // try next
    }
  }
  devCache = { at: now, list }
  return list
}
function deviceForPath(p?: string): DeviceEx | undefined {
  if (!p) return undefined
  return readDevices().find((d) => d?.match?.path === p)
}
function eolOf(dev?: DeviceEx): string {
  const e = dev?.eol
  if (e === "cr") return "\r"
  if (e === "lf") return "\n"
  if (e === "crlf") return "\r\n"
  return typeof e === "string" && e.length > 0 ? e : "\r\n"
}
function highlightRules(dev?: DeviceEx): Array<{ re: RegExp; color: string }> {
  const extra: Array<{ re: RegExp; color: string }> = []
  for (const h of dev?.highlight ?? []) {
    try {
      extra.push({ re: new RegExp(h.pattern, "i"), color: h.color })
    } catch {
      // bad pattern — skip
    }
  }
  return [...extra, ...DEFAULT_HIGHLIGHT]
}

// ── Key normalization (for the line-editor / non-raw path) ───────────────────
type NormKey = { char?: string; name: string; ctrl: boolean; shift: boolean }
function normalizeKey(evt: any): NormKey {
  let name = typeof evt?.name === "string" ? evt.name : ""
  const ctrl = !!evt?.ctrl
  let shift = !!evt?.shift
  const meta = !!(evt?.meta || evt?.option || evt?.super || evt?.hyper)
  if (name === "linefeed") name = "return"
  if (name === "backtab") {
    name = "tab"
    shift = true
  }
  let char: string | undefined
  if (!ctrl && !meta) {
    if (name === "space") {
      char = " "
    } else {
      const seq = typeof evt?.sequence === "string" ? evt.sequence : undefined
      if (seq && (seq.length === 1 || (seq.length === 2 && (seq.codePointAt(0) ?? 0) > 0xffff))) {
        const cc = seq.charCodeAt(0)
        if (cc >= 32 && cc !== 127) char = seq
      }
    }
  }
  return { char, name, ctrl, shift }
}

// The exact terminal bytes of a keypress, for RAW passthrough to the device.
function rawBytes(evt: any): string {
  if (typeof evt?.raw === "string" && evt.raw.length) return evt.raw
  if (typeof evt?.sequence === "string" && evt.sequence.length) return evt.sequence
  return ""
}

// ── Line editor (hand-rolled; spans only) ────────────────────────────────────
function useLineEditor(opts: { onSubmit: (line: string) => void; onChange?: () => void }) {
  const [text, setTextSig] = createSignal("")
  const [cursor, setCursorSig] = createSignal(0)
  const set = (s: string, cur?: number) =>
    batch(() => {
      setTextSig(s)
      setCursorSig(Math.max(0, Math.min(cur ?? s.length, s.length)))
    })
  const handleKey = (k: NormKey): boolean => {
    const t = text()
    const c = cursor()
    if (k.name === "return" && !k.ctrl) {
      opts.onSubmit(t)
      return true
    }
    if (k.char !== undefined) {
      set(t.slice(0, c) + k.char + t.slice(c), c + k.char.length)
      opts.onChange?.()
      return true
    }
    if (k.name === "left" && !k.ctrl) return (set(t, c - 1), true)
    if (k.name === "right" && !k.ctrl) return (set(t, c + 1), true)
    if (k.name === "home" || (k.ctrl && k.name === "a")) return (set(t, 0), true)
    if (k.name === "end" || (k.ctrl && k.name === "e")) return (set(t, t.length), true)
    if (k.name === "backspace") {
      if (c > 0) {
        set(t.slice(0, c - 1) + t.slice(c), c - 1)
        opts.onChange?.()
      }
      return true
    }
    if (k.name === "delete") {
      if (c < t.length) {
        set(t.slice(0, c) + t.slice(c + 1), c)
        opts.onChange?.()
      }
      return true
    }
    if (k.ctrl && k.name === "u") {
      set(t.slice(c), 0)
      opts.onChange?.()
      return true
    }
    if (k.ctrl && k.name === "k") {
      set(t.slice(0, c), c)
      opts.onChange?.()
      return true
    }
    if (k.ctrl && k.name === "w") {
      let s = c
      while (s > 0 && /\s/.test(t[s - 1]!)) s--
      while (s > 0 && !/\s/.test(t[s - 1]!)) s--
      set(t.slice(0, s) + t.slice(c), s)
      opts.onChange?.()
      return true
    }
    return false
  }
  return { text, cursor, set, handleKey }
}

function renderWithCursor(t: string, c: number, width: number, theme: Record<string, any>) {
  const w = Math.max(8, width)
  let start = 0
  if (t.length + 1 > w) start = Math.max(0, Math.min(c - Math.floor((w * 2) / 3), t.length + 1 - w))
  const end = Math.min(t.length, start + w)
  let vis = t.slice(start, end)
  const vc = c - start
  if (start > 0) vis = "…" + vis.slice(1)
  if (end < t.length && vis.length > 1) vis = vis.slice(0, -1) + "…"
  const before = vis.slice(0, vc)
  const after = vc < vis.length ? vis.slice(vc + 1) : ""
  return [<span>{before}</span>, <span style={{ fg: theme.success }}>█</span>, <span>{after}</span>]
}

// ── History store (per-device JSON, shared with the agent) ───────────────────
type HistEntry = { cmd: string; source: "human" | "agent"; at: number }
const HISTORY_DIR = path.join(os.homedir(), ".opencode", "serial", "history")
class HistoryStore {
  private entries: HistEntry[] = []
  private file: string
  private mtime = 0
  private lastStat = 0
  constructor(key: string) {
    const safe = key.replace(/[^A-Za-z0-9._-]+/g, "_") || "default"
    this.file = path.join(HISTORY_DIR, `${safe}.json`)
    this.load()
  }
  private load() {
    try {
      this.mtime = statSync(this.file).mtimeMs
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { entries?: HistEntry[] }
      if (Array.isArray(raw.entries)) this.entries = raw.entries.filter((e) => e && typeof e.cmd === "string").slice(-HISTORY_CAP)
    } catch {
      // empty
    }
  }
  private maybeReload() {
    const now = Date.now()
    if (now - this.lastStat < HISTORY_RELOAD_MS) return
    this.lastStat = now
    try {
      const m = statSync(this.file).mtimeMs
      if (m !== this.mtime) this.load()
    } catch {
      // keep memory
    }
  }
  push(cmd: string, source: "human" | "agent" = "human") {
    const c = cmd.replace(/[\r\n]+$/, "")
    if (!c.trim()) return
    this.maybeReload()
    const last = this.entries[this.entries.length - 1]
    if (last && last.cmd === c) {
      last.at = Date.now()
      return
    }
    this.entries.push({ cmd: c, source, at: Date.now() })
    if (this.entries.length > HISTORY_CAP) this.entries = this.entries.slice(-HISTORY_CAP)
    this.save()
  }
  list(): string[] {
    this.maybeReload()
    return this.entries.map((e) => e.cmd)
  }
  private save() {
    try {
      mkdirSync(HISTORY_DIR, { recursive: true })
      writeFileSync(this.file, JSON.stringify({ version: 1, entries: this.entries }))
      this.mtime = statSync(this.file).mtimeMs
    } catch {
      // in-memory only
    }
  }
}

// ── Completion engine (LOCAL sources only) ───────────────────────────────────
const STATIC_DICT = [
  "ls", "cat", "cd", "echo", "cp", "mv", "rm", "mkdir", "mount", "umount",
  "insmod", "rmmod", "dmesg", "ps", "top", "kill", "reboot", "free", "df",
  "ifconfig", "ping", "printenv", "setenv", "saveenv", "boot", "run",
]
type CandSource = "history" | "screen" | "dict"
type Cand = { text: string; source: CandSource }
class CompletionEngine {
  private idxCache: { at: number; tokens: string[] } | undefined
  constructor(
    private opts: { history: () => string[]; getText: () => string; extraDict: () => string[] },
  ) {}
  private screenTokens(): string[] {
    const now = Date.now()
    if (this.idxCache && now - this.idxCache.at < TOKEN_INDEX_TTL_MS) return this.idxCache.tokens
    const seen = new Set<string>()
    for (const t of this.opts.getText().split(/[^A-Za-z0-9_.\/-]+/)) if (t.length >= 3) seen.add(t)
    this.idxCache = { at: now, tokens: [...seen] }
    return this.idxCache.tokens
  }
  gather(prefix: string, tokenIsWholeLine: boolean): Cand[] {
    const out: Cand[] = []
    const seen = new Set<string>()
    const add = (text: string, source: CandSource) => {
      if (!text || text === prefix || seen.has(text)) return
      seen.add(text)
      out.push({ text, source })
    }
    const hist = this.opts.history()
    for (let i = hist.length - 1; i >= 0; i--) {
      const toks = hist[i]!.split(/\s+/).filter(Boolean)
      if (toks[0]?.startsWith(prefix)) add(tokenIsWholeLine ? hist[i]! : toks[0]!, "history")
      for (const t of toks) if (t.startsWith(prefix)) add(t, "history")
    }
    for (const t of this.screenTokens()) if (t.startsWith(prefix)) add(t, "screen")
    for (const t of [...STATIC_DICT, ...this.opts.extraDict()]) if (t.startsWith(prefix)) add(t, "dict")
    const slash = prefix.lastIndexOf("/")
    if (slash >= 0) {
      const dir = prefix.slice(0, slash + 1)
      out.sort((a, b) => Number(!a.text.startsWith(dir)) - Number(!b.text.startsWith(dir)))
    }
    return out.slice(0, MAX_CANDIDATES)
  }
}

// ── Live tail for the bottom bar ─────────────────────────────────────────────
function useLiveTail(sessionId: () => string | undefined) {
  const [lastLine, setLastLine] = createSignal("")
  const [bytes, setBytes] = createSignal(0)
  let ws: WebSocket | undefined
  let connectedTo: string | undefined
  let pendingBytes = 0
  let pendingLine: string | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const dec = new TextDecoder()
  const flush = () => {
    flushTimer = undefined
    batch(() => {
      if (pendingBytes) setBytes((n) => n + pendingBytes)
      if (pendingLine !== undefined) setLastLine(pendingLine)
    })
    pendingBytes = 0
    pendingLine = undefined
  }
  const schedule = () => {
    if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_MS)
  }
  const ingest = (raw: string) => {
    pendingBytes += raw.length
    const chunk = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const nl = chunk.lastIndexOf("\n")
    if (nl >= 0) {
      const after = chunk.slice(nl + 1)
      pendingLine = after.trim() ? after : (chunk.slice(0, nl).split("\n").filter(Boolean).pop() ?? after)
    } else {
      pendingLine = (pendingLine ?? lastLine()) + chunk
    }
    schedule()
  }
  createEffect(() => {
    const sid = sessionId()
    if (!sid || connectedTo === sid) return
    ws?.close()
    connectedTo = sid
    setBytes(0)
    setLastLine("")
    const base = readServerBase()
    if (!base) return
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/serial/${sid}/connect?cursor=-1`)
    socket.binaryType = "arraybuffer"
    socket.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        ingest(ev.data)
        return
      }
      const arr = new Uint8Array(ev.data as ArrayBuffer)
      if (arr[0] === 0x00) return
      ingest(dec.decode(arr))
    }
    ws = socket
  })
  onCleanup(() => {
    ws?.close()
    if (flushTimer !== undefined) clearTimeout(flushTimer)
  })
  return { lastLine, bytes }
}

function SessionLine(props: { api: TuiPluginApi; session: Session }) {
  const theme = () => props.api.theme.current
  const { lastLine, bytes } = useLiveTail(() => props.session.id)
  return (
    <box flexDirection="row" gap={1}>
      <text flexShrink={0} style={{ fg: dotColor(theme(), props.session.status) }}>
        •
      </text>
      <text flexShrink={0} fg={theme().textMuted}>
        {props.session.path}@{props.session.baudRate}
      </text>
      <text fg={theme().text}>
        {bytes()}B {lastLine().slice(0, 80)}
      </text>
    </box>
  )
}

function BottomBar(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const sessions = useSessions()
  return (
    <Show when={sessions().length > 0}>
      <box flexDirection="column" border borderColor={theme().border} paddingLeft={2} paddingRight={2}>
        <For each={sessions().slice(0, BAR_MAX_SESSIONS)}>{(s) => <SessionLine api={props.api} session={s} />}</For>
        <Show when={sessions().length > BAR_MAX_SESSIONS}>
          <text fg={theme().textMuted}>+{sessions().length - BAR_MAX_SESSIONS} more · /serial to view</text>
        </Show>
      </box>
    </Show>
  )
}

function Sidebar(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const sessions = useSessions()
  return (
    <Show
      when={sessions().length > 0}
      fallback={<text fg={theme().textMuted}>Serial: no sessions{readServerBase() ? "" : " (server not discovered)"}</text>}
    >
      <box flexDirection="column">
        <text fg={theme().text}>
          <b>Serial</b>
        </text>
        <For each={sessions()}>
          {(s) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: dotColor(theme(), s.status) }}>
                •
              </text>
              <text fg={theme().text} wrapMode="word">
                {s.path}{" "}
                <span style={{ fg: theme().textMuted }}>
                  @{s.baudRate} {s.status}
                </span>
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

// ── Full-screen terminal monitor ─────────────────────────────────────────────
type Line = { text: string; start: Style } // text = raw line (may contain ANSI), no trailing \n

// Build a Line[] from a blob (file load), carrying SGR state across lines.
// Caller passes \r-normalized text.
function buildLines(text: string): Line[] {
  const parts = text.split("\n")
  const out: Line[] = []
  let start: Style = {}
  for (let i = 0; i < parts.length; i++) {
    out.push({ text: parts[i]!, start })
    start = parseLine(parts[i]!, start).end
  }
  return out
}

function Monitor(props: { api: TuiPluginApi; params?: Record<string, unknown> }) {
  const dim = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const sessions = useSessions()
  const initial = typeof props.params?.serial_id === "string" ? (props.params.serial_id as string) : undefined
  const [activeId, setActiveId] = createSignal<string | undefined>(initial)
  const current = () => sessions().find((s) => s.id === (activeId() ?? sessions()[0]?.id))

  // Keymap mode: release tab/ctrl+c from the host while mounted.
  const [hostKeys, setHostKeys] = createSignal(false)
  {
    let pop: (() => void) | undefined
    try {
      const mode = (props.api as any).mode
      if (mode?.push) {
        const r = mode.push("serial-terminal")
        if (typeof r === "function") pop = r
        else if (typeof mode.pop === "function")
          pop = () => {
            try {
              mode.pop("serial-terminal")
            } catch {
              try {
                mode.pop()
              } catch {}
            }
          }
      } else setHostKeys(true)
    } catch {
      setHostKeys(true)
    }
    onCleanup(() => {
      try {
        pop?.()
      } catch {}
    })
  }

  // ── Windowed line model ────────────────────────────────────────────────────
  // `lines` is a plain array (NOT a signal — copying 20k items per flush is
  // wasteful); a `version` counter triggers re-render. Only the visible window
  // is rendered, so cost is bounded by viewport height regardless of depth.
  let lines: Line[] = [{ text: "", start: {} }]
  const [version, setVersion] = createSignal(0)
  // anchorBottom = absolute index of the line shown at the viewport bottom.
  // following = pinned to newest (auto-scroll on new data).
  const [anchorBottom, setAnchorBottom] = createSignal(0)
  const [following, setFollowing] = createSignal(true)
  // Full-history LOG VIEW: when set, the viewport/scroll/find act on the
  // session's log FILE (everything since session start, beyond the RAM ring)
  // instead of the live buffer; live `lines` keep accumulating behind it.
  const [logView, setLogView] = createSignal<Line[] | undefined>(undefined)
  const [logMeta, setLogMeta] = createSignal<{ bytes: number; truncated: boolean } | undefined>(undefined)
  const activeLines = (): Line[] => logView() ?? lines

  let ws: WebSocket | undefined
  let connectedTo: string | undefined
  let pending = ""
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const dec = new TextDecoder()

  const viewportH = () => Math.max(1, dim().height - 8) // header + border + input chrome

  const feed = (norm: string) => {
    // norm already has \r\n / lone \r → \n (display line breaks); ANSI kept.
    const parts = norm.split("\n")
    let last = lines[lines.length - 1]!
    last.text += parts[0]
    for (let i = 1; i < parts.length; i++) {
      const end = parseLine(last.text, last.start).end // carry SGR state across the closed line
      lines.push({ text: parts[i]!, start: end })
      last = lines[lines.length - 1]!
    }
    let dropped = 0
    if (lines.length > MAX_LINES) {
      dropped = lines.length - MAX_LINES
      lines = lines.slice(dropped)
    }
    // While the log-file view is up, its anchor/find are independent of the
    // live buffer — don't let live appends move the scroll or rebuild matches.
    if (!logView()) {
      if (following()) setAnchorBottom(lines.length - 1)
      else if (dropped) setAnchorBottom((a) => Math.max(0, a - dropped))
      // Find matches hold ABSOLUTE line indices — rebuild them against the
      // trimmed buffer so gutter markers + next/prev jumps stay correct.
      if (dropped) {
        const f = find()
        if (f && f.query) setFind(runFind(f.query))
      }
    }
  }

  // True when `tail` (which starts at an ESC / C1 introducer) is an INCOMPLETE
  // escape — so we hold it back across the flush boundary instead of mangling it.
  const isIncompleteEscape = (tail: string): boolean => {
    if (tail === "\x1b") return true
    const c = tail[1]
    if (c === "[") return !/^\x1b\[[0-9;:?<=>]*[@-~]/.test(tail)
    if (c === "]") return !(tail.includes("\x07") || tail.includes("\x1b\\"))
    return false // other 2-byte escape — both bytes already present
  }

  const flush = () => {
    flushTimer = undefined
    if (!pending) return
    // Hold back a trailing incomplete ESC/CSI/OSC so a color escape split across
    // the 33ms boundary completes on the next flush (give up past 64 held bytes
    // so a stray lone ESC can't wedge the stream).
    let s = pending
    const esc = s.lastIndexOf("\x1b")
    if (esc >= 0 && s.length - esc <= 64 && isIncompleteEscape(s.slice(esc))) {
      pending = s.slice(esc)
      s = s.slice(0, esc)
    } else {
      pending = ""
    }
    if (!s) return
    feed(s.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
    setVersion((v) => v + 1)
  }
  const scheduleFlush = () => {
    if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_MS)
  }
  const append = (chunk: string) => {
    pending += chunk
    scheduleFlush()
  }

  // Raw-mode passthrough also needs to SHOW the typed/echoed bytes; the device
  // echo arrives over the same WS, so no special local echo is needed.

  const connect = (sid: string) => {
    if (connectedTo === sid && ws && ws.readyState <= 1) return
    ws?.close()
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    lines = [{ text: "", start: {} }]
    pending = ""
    // Reset live buffer + tear down any log-file view atomically, so switching
    // session can't leave the old session's log on screen (don't rely on the
    // separate session-switch effect's ordering).
    setLogView(undefined)
    setLogMeta(undefined)
    setFind(undefined)
    setFollowing(true)
    setAnchorBottom(0)
    setVersion((v) => v + 1)
    connectedTo = sid
    const base = readServerBase()
    if (!base) return
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/serial/${sid}/connect?cursor=0`)
    socket.binaryType = "arraybuffer"
    socket.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        append(ev.data)
        return
      }
      const arr = new Uint8Array(ev.data as ArrayBuffer)
      if (arr[0] === 0x00) return
      append(dec.decode(arr))
    }
    ws = socket
  }

  createEffect(() => {
    const sid = activeId() ?? sessions()[0]?.id
    if (sid) connect(sid)
  })
  onCleanup(() => {
    ws?.close()
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    void setRawHold(false, rawHeldSid)
  })

  // ── Scroll (acts on the ACTIVE buffer — live or the log-file view) ──────────
  const scrollBy = (deltaLines: number) => {
    const n = activeLines().length
    const a = Math.max(0, Math.min(n - 1, anchorBottom() + deltaLines))
    batch(() => {
      setAnchorBottom(a)
      setFollowing(!logView() && a >= n - 1) // following only meaningful for the live buffer
    })
  }
  const scrollToTop = () =>
    batch(() => {
      const n = activeLines().length
      const a = Math.min(n - 1, viewportH() - 1)
      setAnchorBottom(a)
      setFollowing(!logView() && a >= n - 1)
    })
  const scrollToBottom = () => batch(() => (setAnchorBottom(activeLines().length - 1), setFollowing(!logView())))

  // ── Find (incremental search over the ACTIVE buffer: live ring OR log file) ──
  const [find, setFind] = createSignal<{ query: string; matches: number[]; idx: number } | undefined>(undefined)
  const runFind = (query: string, preferFrom?: number): { query: string; matches: number[]; idx: number } => {
    const buf = activeLines()
    const matches: number[] = []
    if (query) {
      const q = query.toLowerCase()
      // Match against the VISIBLE (ANSI-stripped) text so the gutter marker,
      // count, jump, and the substring highlight all agree (otherwise a query
      // like "31m" would mark a colored line that shows no visible hit). Strip
      // only when the line actually contains an escape (most don't).
      for (let i = 0; i < buf.length; i++) {
        const raw = buf[i]!.text
        const hay = (raw.includes("\x1b") ? stripAnsi(raw) : raw).toLowerCase()
        if (hay.includes(q)) matches.push(i)
      }
    }
    // pick the match nearest-below the current view
    let idx = matches.length - 1
    const from = preferFrom ?? anchorBottom()
    for (let i = 0; i < matches.length; i++) if (matches[i]! <= from) idx = i
    return { query, matches, idx: matches.length ? Math.max(0, idx) : -1 }
  }
  const jumpToMatch = (st: { matches: number[]; idx: number }) => {
    if (st.idx < 0 || !st.matches.length) return
    const line = st.matches[st.idx]!
    batch(() => {
      setAnchorBottom(Math.min(activeLines().length - 1, line + Math.floor(viewportH() / 2)))
      setFollowing(false)
    })
  }

  // ── Full-history log-file view ──────────────────────────────────────────────
  const enterLogView = () => {
    const p = current()?.logPath
    if (!p) {
      warn("no log file for this device — set \"log\": true in devices.json for full history")
      return
    }
    try {
      const { text, bytes, truncated } = tailFile(p, LOG_VIEW_MAX)
      const ll = buildLines(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
      setFind(undefined)
      setLogView(ll)
      setLogMeta({ bytes, truncated })
      batch(() => {
        setFollowing(false)
        setAnchorBottom(Math.min(ll.length - 1, viewportH() - 1)) // start at the TOP
      })
    } catch (e) {
      if ((e as { code?: string })?.code === "ENOENT") warn("log file not created yet — no output logged so far")
      else warn("log read failed: " + (e as Error).message)
    }
  }
  const exitLogView = () => {
    setFind(undefined)
    setLogView(undefined)
    setLogMeta(undefined)
    scrollToBottom()
  }
  const findStep = (dir: 1 | -1) => {
    const st = find()
    if (!st || !st.matches.length) return
    const idx = (st.idx + dir + st.matches.length) % st.matches.length
    const next = { ...st, idx }
    setFind(next)
    jumpToMatch(next)
  }
  // Memoized so the per-frame visible() render doesn't allocate a Set each flush;
  // recomputes only when the find result changes.
  const matchSet = createMemo(() => new Set(find()?.matches ?? []))

  // ── Raw mode (transient native passthrough) ─────────────────────────────────
  const [raw, setRaw] = createSignal(false)
  // The session id that holds rawHold — captured at enter so the OFF always
  // targets THAT session even if the user switched away (current() would return
  // the new session and leak the old hold until the server's 120s backstop).
  let rawHeldSid: string | undefined
  const setRawHold = async (on: boolean, sid: string | undefined) => {
    const base = readServerBase()
    if (!base || !sid) return
    try {
      await fetch(`${base}/serial/${sid}/rawhold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      })
    } catch {
      // best-effort; auto-releases server-side on a timeout
    }
  }
  const enterRaw = () => {
    if (!wsOpen()) {
      warn("⚠ serial link not open — can't enter raw mode")
      return
    }
    if (logView()) exitLogView() // raw is for live interaction, not history
    rawHeldSid = current()?.id
    setRaw(true)
    void setRawHold(true, rawHeldSid)
  }
  const exitRaw = () => {
    setRaw(false)
    const sid = rawHeldSid
    rawHeldSid = undefined
    void setRawHold(false, sid)
  }

  // ── Interactive input (non-raw) ──────────────────────────────────────────────
  const [notice, setNotice] = createSignal("")
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const warn = (msg: string) => {
    setNotice(msg)
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => setNotice(""), NOTICE_MS)
  }
  onCleanup(() => {
    if (noticeTimer) clearTimeout(noticeTimer)
  })

  const histCache = new Map<string, HistoryStore>()
  const history = (): HistoryStore => {
    const p = current()?.path ?? "default"
    let h = histCache.get(p)
    if (!h) {
      h = new HistoryStore(p)
      histCache.set(p, h)
    }
    return h
  }
  const [histIdx, setHistIdx] = createSignal<number | undefined>(undefined)
  let draft = ""
  const [search, setSearch] = createSignal<{ query: string; pos: number; failed: boolean } | undefined>(undefined)
  type Completion = { line0: string; cursor0: number; start: number; end: number; prefix: string; cands: Cand[]; i: number }
  const [comp, setComp] = createSignal<Completion | undefined>(undefined)

  const editor = useLineEditor({
    onSubmit: (line) => submit(line),
    onChange: () => setHistIdx(undefined),
  })
  const engine = new CompletionEngine({
    history: () => history().list(),
    getText: () => lines.slice(-2000).map((l) => l.text).join("\n"),
    extraDict: () => deviceForPath(current()?.path)?.commands ?? [],
  })

  let lastPath: string | undefined
  createEffect(() => {
    const p = current()?.path
    if (p === lastPath) return
    lastPath = p
    setHistIdx(undefined)
    draft = ""
    setComp(undefined)
    setSearch(undefined)
    setFind(undefined)
    if (raw()) exitRaw()
    if (logView()) exitLogView() // don't keep the old session's log file on screen
  })

  const wsOpen = () => !!ws && ws.readyState === 1
  const sendRaw = (s: string) => {
    if (!s) return
    if (!wsOpen()) {
      warn("⚠ serial link not open — byte dropped")
      return
    }
    ws!.send(s)
  }
  const submit = (line: string) => {
    const dev = deviceForPath(current()?.path)
    if (!wsOpen()) {
      warn("⚠ serial link not open — command NOT sent (kept in input)")
      return
    }
    const eol = current()?.eol ?? eolOf(dev)
    ws!.send(line + eol)
    if (line.trim()) history().push(line, "human")
    if (dev?.localEcho) append(line + "\n")
    editor.set("", 0)
    setHistIdx(undefined)
    draft = ""
  }

  const histUp = () => {
    const list = history().list()
    if (!list.length) return
    let i = histIdx()
    if (i === undefined) {
      draft = editor.text()
      i = list.length - 1
    } else if (i > 0) i -= 1
    setHistIdx(i)
    const cmd = list[i]!
    editor.set(cmd, cmd.length)
  }
  const histDown = () => {
    const list = history().list()
    const i = histIdx()
    if (i === undefined) return
    if (i >= list.length - 1) {
      setHistIdx(undefined)
      editor.set(draft, draft.length)
      return
    }
    setHistIdx(i + 1)
    const cmd = list[i + 1]!
    editor.set(cmd, cmd.length)
  }

  const findHistMatch = (q: string, from: number): number => {
    if (!q) return -1
    const list = history().list()
    for (let i = Math.min(from, list.length - 1); i >= 0; i--) if (list[i]!.includes(q)) return i
    return -1
  }
  const handleSearchKey = (k: NormKey) => {
    const st = search()!
    const list = history().list()
    if (k.ctrl && k.name === "r") {
      const from = st.pos >= 0 ? st.pos - 1 : list.length - 1
      const p = findHistMatch(st.query, from)
      setSearch(p >= 0 ? { query: st.query, pos: p, failed: false } : { ...st, failed: true })
      return
    }
    if (k.name === "escape") return setSearch(undefined)
    if (k.name === "return") {
      if (st.pos >= 0) {
        const m = list[st.pos]!
        editor.set(m, m.length)
      }
      setSearch(undefined)
      return
    }
    if (k.name === "backspace") {
      const q = st.query.slice(0, -1)
      const p = findHistMatch(q, list.length - 1)
      setSearch({ query: q, pos: p, failed: q.length > 0 && p < 0 })
      return
    }
    if (k.char !== undefined) {
      const q = st.query + k.char
      const p = findHistMatch(q, st.pos >= 0 ? st.pos : list.length - 1)
      setSearch({ query: q, pos: p, failed: p < 0 })
      return
    }
    if (st.pos >= 0) {
      const m = list[st.pos]!
      editor.set(m, m.length)
    }
    setSearch(undefined)
  }

  const applyCand = (st: Completion) => {
    const cand = st.cands[st.i]!.text
    editor.set(st.line0.slice(0, st.start) + cand + st.line0.slice(st.end), st.start + cand.length)
  }
  const cancelCompletion = () => {
    const st = comp()
    if (!st) return
    editor.set(st.line0, st.cursor0)
    setComp(undefined)
  }
  const onTab = (back: boolean) => {
    const st = comp()
    if (st) {
      const n = st.cands.length
      const next = { ...st, i: (st.i + (back ? -1 : 1) + n) % n }
      setComp(next)
      applyCand(next)
      return
    }
    const line = editor.text()
    const cur = editor.cursor()
    let start = cur
    while (start > 0 && !/\s/.test(line[start - 1]!)) start--
    let end = cur
    while (end < line.length && !/\s/.test(line[end]!)) end++
    const prefix = line.slice(start, cur)
    if (!prefix) return warn("nothing to complete")
    const cands = engine.gather(prefix, start === 0 && end === line.length)
    if (!cands.length) return warn(`no completion for "${prefix}" — F4 for the device's own completion`)
    const st2: Completion = { line0: line, cursor0: cur, start, end, prefix, cands, i: 0 }
    applyCand(st2)
    if (cands.length > 1) setComp(st2)
  }

  // ── Paste ────────────────────────────────────────────────────────────────────
  usePaste((event: any) => {
    if (props.api.route.current.name !== ROUTE) return
    try {
      let s = ""
      if (event?.bytes instanceof Uint8Array) s = new TextDecoder().decode(event.bytes)
      else if (typeof event?.text === "string") s = event.text
      if (!s) return
      event?.preventDefault?.()
      if (raw()) {
        sendRaw(s) // raw mode: paste straight to the device
        return
      }
      if (search()) return
      const flat = s.replace(/[\r\n]+/g, " ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim()
      if (!flat) return
      const t = editor.text()
      const c = editor.cursor()
      editor.set(t.slice(0, c) + flat + t.slice(c), c + flat.length)
      setHistIdx(undefined)
    } catch {
      // ignore
    }
  })

  // ── Hint line ────────────────────────────────────────────────────────────────
  const hint = () => {
    if (notice()) return notice()
    if (raw()) return "RAW · keys → device (Tab = device completion) · Esc exit raw"
    const f = find()
    if (f) return `/${f.query}  ${f.matches.length ? `${f.idx + 1}/${f.matches.length}` : "no match"} · ↓↑ next/prev · esc done`
    const st = comp()
    if (st) {
      const c = st.cands[st.i]!
      const n = st.cands.length
      const w0 = Math.max(0, Math.min(st.i - 1, n - 4))
      const inline = st.cands.slice(w0, w0 + 4).map((x, j) => (w0 + j === st.i ? `[${x.text}]` : x.text)).join("  ")
      return `↹ ${st.i + 1}/${n}: ${c.text} (${c.source})  ${inline}${n > w0 + 4 ? " …" : ""}`
    }
    if (search()) return "ctrl+r older · enter accept · esc cancel"
    if (hostKeys()) return "⚠ old opencode build: tab/ctrl+c stay host keys — ctrl+g sends interrupt"
    return ""
  }

  // ── Key routing ──────────────────────────────────────────────────────────────
  useKeyboard((evt) => {
    if (props.api.route.current.name !== ROUTE) return
    const consume = () => {
      evt.preventDefault()
      evt.stopPropagation()
    }
    const k = normalizeKey(evt)

    // F4 toggles raw mode (works in any sub-state).
    if (k.name === "f4") {
      consume()
      raw() ? exitRaw() : enterRaw()
      return
    }

    // RAW: forward exact bytes to the device; Esc exits raw (one Esc = one level).
    if (raw()) {
      consume()
      if (k.name === "escape") {
        exitRaw()
        return
      }
      sendRaw(rawBytes(evt))
      return
    }

    // ctrl+c / ctrl+g → device interrupt.
    if (k.ctrl && (k.name === "c" || k.name === "g")) {
      consume()
      sendRaw("\x03")
      return
    }

    // Find mode (over the scrollback) swallows keys. Navigation is on the ARROW
    // keys (and Enter) so every printable char — including 'n' (kernel, panic,
    // connect…) — flows into the query.
    if (find()) {
      consume()
      const st = find()!
      if (k.name === "escape") {
        setFind(undefined)
        return
      }
      if (k.name === "down" || k.name === "return") {
        findStep(1)
        return
      }
      if (k.name === "up") {
        findStep(-1)
        return
      }
      if (k.name === "backspace") {
        const next = runFind(st.query.slice(0, -1))
        setFind(next)
        jumpToMatch(next)
        return
      }
      if (k.char !== undefined) {
        const next = runFind(st.query + k.char)
        setFind(next)
        jumpToMatch(next)
        return
      }
      return
    }

    // reverse-i-search (history) swallows keys.
    if (search()) {
      consume()
      handleSearchKey(k)
      return
    }

    // escape — LAYERED, one level per press (raw + find handled above):
    // completion → clear input → exit log view → exit route. So Esc-to-exit-
    // /serial stays the LAST stage and never collides with sub-modes.
    if (k.name === "escape") {
      consume()
      if (comp()) return cancelCompletion()
      if (editor.text().length > 0) {
        editor.set("", 0)
        setHistIdx(undefined)
        return
      }
      if (logView()) return exitLogView()
      props.api.route.navigate("home")
      return
    }

    // scrollback — PageUp/PageDown always; Home/End only when the input is empty
    // (so they stay line-editor keys while typing).
    if (k.name === "pageup") {
      consume()
      scrollBy(-viewportH())
      return
    }
    if (k.name === "pagedown") {
      consume()
      scrollBy(viewportH())
      return
    }
    if ((k.name === "home" || k.name === "end") && editor.text() === "") {
      consume()
      k.name === "home" ? scrollToTop() : scrollToBottom()
      return
    }

    // F5 toggles the full-history LOG-FILE view (everything since session start,
    // beyond the 20k RAM ring). A function key avoids clashing with device
    // commands that start with a letter and with VSCode's Ctrl-chords.
    if (k.name === "f5") {
      consume()
      logView() ? exitLogView() : enterLogView()
      return
    }

    // ctrl+r → reverse-i-search (history).
    if (k.ctrl && k.name === "r") {
      consume()
      setSearch({ query: "", pos: -1, failed: false })
      return
    }

    // tab / ctrl+n → local completion.
    if (k.name === "tab" || (k.ctrl && k.name === "n")) {
      consume()
      onTab(k.shift)
      return
    }
    const hadComp = comp() !== undefined
    if (hadComp) setComp(undefined)

    // "/" opens find over the ACTIVE buffer (only when the input is empty).
    if (k.char === "/" && editor.text() === "") {
      consume()
      const st = runFind("")
      setFind(st)
      return
    }

    // session switching: [ / ] when input empty; F3 always.
    const cycle = (dir: 1 | -1) => {
      const list = sessions()
      if (!list.length) return
      const cur = activeId() ?? list[0]?.id
      const idx = Math.max(0, list.findIndex((s) => s.id === cur))
      setActiveId(list[(idx + dir + list.length) % list.length]?.id)
    }
    if (k.name === "f3") {
      consume()
      cycle(1)
      return
    }
    if (k.char === "]" && editor.text() === "") {
      consume()
      cycle(1)
      return
    }
    if (k.char === "[" && editor.text() === "") {
      consume()
      cycle(-1)
      return
    }

    // up/down — history.
    if (k.name === "up") {
      consume()
      if (!hadComp) histUp()
      return
    }
    if (k.name === "down") {
      consume()
      if (!hadComp) histDown()
      return
    }

    // line editor.
    if (editor.handleKey(k)) {
      consume()
      return
    }
  })

  // ── Render one scrollback line → spans (ANSI color + keyword highlight +
  //    exact find-substring highlight) ──────────────────────────────────────
  const renderLineSpans = (line: Line, dev: DeviceEx | undefined, query: string) => {
    const { runs } = parseLine(line.text, line.start)
    const rules = highlightRules(dev)
    // line-level keyword color, applied only to runs the device left uncolored
    let kw: string | undefined
    for (const r of rules) {
      r.re.lastIndex = 0
      if (r.re.test(line.text)) {
        kw = r.color
        break
      }
    }
    const t = theme()
    if (!runs.length) return [<span> </span>]
    const q = query.toLowerCase()
    const hlFg = t.background ?? "#101010"
    const hlBg = t.warning ?? "#fce94f"
    const spans: any[] = []
    for (const run of runs) {
      const baseStyle: Record<string, any> = {}
      const fg = run.style.reverse ? run.style.bg ?? t.backgroundPanel : run.style.fg ?? kw
      const bg = run.style.reverse ? run.style.fg ?? t.text : run.style.bg
      if (fg) baseStyle.fg = fg
      if (bg) baseStyle.bg = bg
      if (!q) {
        spans.push(<span style={baseStyle}>{run.text}</span>)
        continue
      }
      // highlight exact (case-insensitive) query occurrences within this run
      const lower = run.text.toLowerCase()
      let pos = 0
      let hit = lower.indexOf(q, pos)
      if (hit < 0) {
        spans.push(<span style={baseStyle}>{run.text}</span>)
        continue
      }
      while (hit >= 0) {
        if (hit > pos) spans.push(<span style={baseStyle}>{run.text.slice(pos, hit)}</span>)
        spans.push(<span style={{ fg: hlFg, bg: hlBg }}>{run.text.slice(hit, hit + q.length)}</span>)
        pos = hit + q.length
        hit = lower.indexOf(q, pos)
      }
      if (pos < run.text.length) spans.push(<span style={baseStyle}>{run.text.slice(pos)}</span>)
    }
    return spans
  }

  const visible = () => {
    void version() // re-render trigger (live appends bump version)
    const buf = activeLines()
    const n = buf.length
    const end = Math.min(n, anchorBottom() + 1)
    const start = Math.max(0, end - viewportH())
    const dev = deviceForPath(current()?.path)
    const set = matchSet()
    const q = find()?.query ?? ""
    const out: Array<{ spans: any; match: boolean }> = []
    for (let i = start; i < end; i++) out.push({ spans: renderLineSpans(buf[i]!, dev, q), match: set.has(i) })
    return out
  }

  const inputWidth = () => Math.max(8, dim().width - 8)

  return (
    <box
      width={dim().width}
      height={dim().height}
      backgroundColor={theme().backgroundPanel}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme().text}>
          <b>Serial Monitor</b>
          <Show when={current()?.id}>
            <span style={{ fg: theme().textMuted }}> {current()?.id}</span>
          </Show>
          <Show when={raw()}>
            <span style={{ fg: theme().error ?? theme().warning }}> · RAW (you drive)</span>
          </Show>
          <Show when={!raw() && current()?.owner}>
            <span style={{ fg: theme().warning ?? theme().textMuted }}> · driver: agent {(current()?.owner ?? "").slice(0, 12)}</span>
          </Show>
          <Show when={logView()}>
            <span style={{ fg: theme().success }}>
              {" "}· LOG {Math.round((logMeta()?.bytes ?? 0) / 1024)}KB{logMeta()?.truncated ? " (tail)" : ""} · F5/esc live
            </span>
          </Show>
          <Show when={!logView() && !following()}>
            <span style={{ fg: theme().textMuted }}> · scrolled (End↓)</span>
          </Show>
        </text>
        <text fg={theme().textMuted}>PgUp/Dn/wheel scroll · / find · F5 full-log · F4 raw · ↑↓ hist · [ ]/F3 switch · esc</text>
      </box>
      <Show
        when={sessions().length > 0}
        fallback={<text fg={theme().textMuted}>No active serial sessions. Ask the agent to open one with serial_create.</text>}
      >
        <box
          border
          borderColor={raw() ? theme().error ?? theme().border : logView() ? theme().success : theme().border}
          flexDirection="column"
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
          onMouseScroll={(e: any) => {
            const dir = e?.scroll?.direction
            if (dir !== "up" && dir !== "down") return
            const step = Math.max(1, Math.round((e?.scroll?.delta ?? 1) * 3)) // ~opencode scroll feel
            scrollBy(dir === "up" ? -step : step)
            e?.stopPropagation?.()
          }}
        >
          {/* Only the visible window is rendered. <Index> keys by POSITION (a
              fixed-height viewport) and passes each row as a signal, so a flush
              patches changed cells instead of remounting every row. */}
          <Index each={visible()}>
            {(row) => (
              <text fg={theme().text} wrapMode="word">
                <Show when={row().match}>
                  <span style={{ fg: theme().warning ?? theme().success }}>▸ </span>
                </Show>
                {row().spans}
              </text>
            )}
          </Index>
        </box>
      </Show>

      <box flexDirection="column" flexShrink={0}>
        <Show when={hint()}>
          <text fg={theme().textMuted}>{hint()}</text>
        </Show>
        <Show when={!raw()}>
          <text fg={theme().text}>
            <Show when={!search()}>
              <span style={{ fg: theme().success }}>{"❯ "}</span>
              {renderWithCursor(editor.text(), editor.cursor(), inputWidth(), theme())}
            </Show>
            <Show when={search()}>
              {(() => {
                const st = search()
                if (!st) return <span />
                const list = history().list()
                const m = st.pos >= 0 ? list[st.pos]! : ""
                return [
                  <span style={{ fg: theme().textMuted }}>{st.failed ? "(failed reverse-i-search)`" : "(reverse-i-search)`"}</span>,
                  <span>{st.query}</span>,
                  <span style={{ fg: theme().textMuted }}>{"`: "}</span>,
                  <span>{m}</span>,
                ]
              })()}
            </Show>
          </text>
        </Show>
        <Show when={raw()}>
          <text fg={theme().error ?? theme().warning}>{"▮ RAW — typing goes straight to the device · Esc to exit"}</text>
        </Show>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      app_bottom() {
        return <BottomBar api={api} />
      },
      sidebar_content() {
        return <Sidebar api={api} />
      },
    },
  })

  api.route.register([
    {
      name: ROUTE,
      render: ({ params }) => <Monitor api={api} params={params} />,
    },
  ])

  api.command.register(() => [
    {
      title: "Serial Monitor",
      value: "serial.monitor.open",
      category: "Serial",
      slash: { name: "serial" },
      keybind: "tab",
      onSelect: () => api.route.navigate(ROUTE, {}),
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
