/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "../vendor/tui"
import { createSignal, createEffect, onCleanup, For, Show, batch } from "solid-js"
import { useKeyboard, useTerminalDimensions, usePaste } from "@opentui/solid"
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Serial monitor — TUI plugin.
 *
 * Attaches to the plugin's OWN /serial server (not opencode core — core has no
 * serial in this standalone setup). It discovers the server's port from the
 * api.json the server writes, polls the session list, and streams a session's
 * bytes over the /serial/:id/connect WebSocket.
 *
 *   - app_bottom bar : a compact live status line per active session, rendered
 *     UNCONDITIONALLY at the bottom of the app frame — appears automatically the
 *     moment the agent calls serial_create.
 *   - sidebar block  : active sessions + status dot (only when the sidebar is
 *     shown — needs a session and width > 120 cols / manual toggle).
 *   - full-screen monitor (route "serial.monitor"): live byte stream (ONE text
 *     block, batched flush) + an INTERACTIVE INPUT LINE:
 *       · type a command, Enter sends it over the SAME WebSocket — the server's
 *         connect() onMessage writes any text frame to the port verbatim, so no
 *         new endpoint is needed. EOL defaults to "\r\n", per-device override
 *         via devices.json `eol`.
 *       · Tab completion from LOCAL sources only (command history / tokens
 *         already on screen / static dict + devices.json `commands`) — NEVER
 *         queries the device: the agent pattern-matches the same shared stream
 *         (serial_collect / serial_wait), and a hidden completion round-trip
 *         would pollute what it parses. To complete paths in a directory, `ls`
 *         it once — the output lands in the screen index.
 *       · ↑/↓ history (per-device JSON under ~/.opencode/serial/history/ —
 *         shared with the agent: Serial.write() mirrors agent commands there),
 *         ctrl+r reverse-i-search.
 *       · ctrl+c (and ctrl+g, see below) sends 0x03 — device interrupt.
 *       · escape: cancel completion/search → clear input → exit route.
 *       · [ / ] switch sessions while the input is empty; F3/F4 always.
 *
 * KEYMAP MODE: opencode's host keymap runs BEFORE plugin key handlers and, in
 * its base mode, owns tab (agent cycle) and ctrl+c/ctrl+d (app exit) even on a
 * plugin route. While this route is mounted we push a dedicated keymap mode
 * ("serial-terminal") — the same mechanism opencode dialogs use ('modal') — so
 * those keys fall through to this view; the mode is popped on unmount and the
 * modeless ctrl+x leader still works as the host escape hatch (ctrl+x q quits).
 * On older builds without api.mode the host keeps tab/ctrl+c: the hint line
 * says so and ctrl+g doubles as the interrupt key.
 *
 * IMPORTANT (loading): this TUI module is loaded by opencode's TUI plugin
 * loader, which reads `tui.json`, NOT opencode.json. List the plugin in BOTH
 * configs (see INSTALL.md) or none of this renders.
 *
 * Key-event handling is based on the verified @opentui/core parse semantics
 * (0.1.99 ↔ 0.3.4 identical): see normalizeKey(). Only box/text/span JSX
 * elements are used; the line editor is hand-rolled on useKeyboard.
 */

const id = "serial-monitor"
const ROUTE = "serial.monitor"

// Render tuning.
const FLUSH_MS = 33 // ~30fps: coalesce bursty WS chunks into one render/frame
const MAX_CHARS = 256 * 1024 // ring budget for the full-screen text block (~256KB)
const BAR_MAX_SESSIONS = 4 // how many session lines the bottom bar shows

// Input tuning.
const HISTORY_CAP = 500
const HISTORY_RELOAD_MS = 2000 // re-stat the history file at most this often
const TOKEN_INDEX_TTL_MS = 2000 // screen-token index rebuilt at most this often
const DEVICES_TTL_MS = 5000 // devices.json client cache
const NOTICE_MS = 3000
const MAX_CANDIDATES = 50

// `owner` appears once the server exposes it on Info (v0.3.0+); the driver
// badge guards on its presence, so older servers degrade to no badge.
type Session = { id: string; title: string; path: string; baudRate: number; status: string; owner?: string }

// Discover the plugin's self-hosted /serial server. Order:
//   1. OPENCODE_SERIAL_URL env (explicit override)
//   2. <cwd>/.opencode/serial/api.json     (TUI run from the worktree)
//   3. <home>/.opencode/serial/api.json    (global fallback the server also
//      writes — makes discovery work when the TUI's cwd != server worktree,
//      and on Windows where process.env.HOME is unset)
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
      // try next candidate
    }
  }
  return undefined
}

// Poll the session list off the plugin server. (Core has no serial event bus in
// the standalone setup, so we poll rather than subscribe.)
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
      // server not up yet / unreachable — keep last list
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
// Per-device INPUT options for the monitor. LIMITATION: client-side we only
// know the session's `path`, not its USB descriptors, so only `match.path`
// entries resolve here — add a path to entries whose eol/commands you want in
// the monitor (the server matches by serialNumber/vid+pid independently).
type DeviceEx = {
  name?: string
  match?: { path?: string }
  /** Line terminator for sent commands: "cr" | "lf" | "crlf" | raw string. Default "\r\n". */
  eol?: string
  /** Extra completion-dictionary entries (e.g. vendor CLI verbs). */
  commands?: string[]
  /** Echo sent commands into the local view (for echo-less consoles). Default false. */
  localEcho?: boolean
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
      // try next candidate
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

// ── Key normalization ────────────────────────────────────────────────────────
// VERIFIED against @opentui/core parse.keypress / KeyHandler (0.1.99 and 0.3.4
// are byte-identical here):
//   - evt.sequence carries the literal typed text in BOTH the legacy and kitty
//     parse paths (kitty puts the shifted char in sequence while name stays the
//     base-layout key) — so SEQUENCE is the insertion source, never name.
//     Named keys carry raw control sequences ("\r", "\x1b[A") which the
//     charCode>=32 filter rejects, so they can't leak in as text.
//   - enter arrives as name "return" ("\r"); a bare "\n" is "linefeed".
//   - shift+tab arrives as name "tab" + shift:true (legacy "[Z" and kitty).
//   - ctrl chords arrive as {name:"<letter>", ctrl:true}. Legacy terminals fold
//     ctrl+m→return / ctrl+i→tab / ctrl+h→backspace (protocol ambiguity; kitty
//     reports them distinctly).
//   - bracketed paste NEVER arrives as a keypress — it is a single PasteEvent
//     via usePaste (handled separately below).
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

// ── Line editor (hand-rolled; spans only) ────────────────────────────────────
function useLineEditor(opts: { onSubmit: (line: string) => void; onChange?: () => void }) {
  const [text, setTextSig] = createSignal("")
  const [cursor, setCursorSig] = createSignal(0)
  const set = (s: string, cur?: number) =>
    batch(() => {
      setTextSig(s)
      setCursorSig(Math.max(0, Math.min(cur ?? s.length, s.length)))
    })

  /** Returns true when the key was consumed by the editor. */
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
    if (k.name === "left" && !k.ctrl) {
      set(t, c - 1)
      return true
    }
    if (k.name === "right" && !k.ctrl) {
      set(t, c + 1)
      return true
    }
    if (k.name === "home" || (k.ctrl && k.name === "a")) {
      set(t, 0)
      return true
    }
    if (k.name === "end" || (k.ctrl && k.name === "e")) {
      set(t, t.length)
      return true
    }
    if (k.name === "backspace") {
      // legacy ctrl+h folds into "backspace" upstream — same action either way
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
      set(t.slice(c), 0) // kill to line start
      opts.onChange?.()
      return true
    }
    if (k.ctrl && k.name === "k") {
      set(t.slice(0, c), c) // kill to line end
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

/**
 * Render the editor line with a block cursor, windowed around the cursor so
 * very long input stays visible. Returns an array of <span>s (no fragments —
 * fragments inside <text> are unproven in this opentui build).
 *
 * Cursor: the cell at the cursor is REPLACED by "█" — true inverse video needs
 * span `bg`, unverified here; swap once confirmed.
 */
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
  return [
    <span>{before}</span>,
    <span style={{ fg: theme.success }}>█</span>,
    <span>{after}</span>,
  ]
}

// ── History store (per-device JSON file, shared with the agent) ──────────────
// File: <home>/.opencode/serial/history/<sanitized-path>.json
// Format: { version: 1, entries: [{ cmd, source: "human"|"agent", at }] }
// The server's Serial.write() appends agent commands to the SAME file (same
// sanitize rule, same format — service.ts appendSharedHistory), and this class
// re-stats the file (throttled) so they become ↑-recallable live. Concurrent
// writers are last-writer-wins (best-effort by design).
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
      if (Array.isArray(raw.entries)) {
        this.entries = raw.entries.filter((e) => e && typeof e.cmd === "string").slice(-HISTORY_CAP)
      }
    } catch {
      // missing/corrupt file — start empty
    }
  }

  /** Pick up entries appended by the server's agent hook. Throttled. */
  private maybeReload() {
    const now = Date.now()
    if (now - this.lastStat < HISTORY_RELOAD_MS) return
    this.lastStat = now
    try {
      const m = statSync(this.file).mtimeMs
      if (m !== this.mtime) this.load()
    } catch {
      // file gone — keep memory copy
    }
  }

  push(cmd: string, source: "human" | "agent" = "human") {
    const c = cmd.replace(/[\r\n]+$/, "")
    if (!c.trim()) return
    this.maybeReload()
    const last = this.entries[this.entries.length - 1]
    if (last && last.cmd === c) {
      last.at = Date.now() // consecutive dedup
      return
    }
    this.entries.push({ cmd: c, source, at: Date.now() })
    if (this.entries.length > HISTORY_CAP) this.entries = this.entries.slice(-HISTORY_CAP)
    this.save()
  }

  /** Commands ordered oldest→newest (newest-LAST). */
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
      // read-only FS etc. — history stays in-memory for this run
    }
  }
}

// ── Completion engine (LOCAL sources only — never queries the device) ────────
const STATIC_DICT = [
  // busybox-ish
  "ls", "cat", "cd", "echo", "cp", "mv", "rm", "mkdir", "mount", "umount",
  "insmod", "rmmod", "dmesg", "ps", "top", "kill", "reboot", "free", "df",
  "ifconfig", "ping",
  // u-boot
  "printenv", "setenv", "saveenv", "boot", "run",
]

type CandSource = "history" | "screen" | "dict"
type Cand = { text: string; source: CandSource }

class CompletionEngine {
  private idxCache: { at: number; tokens: string[] } | undefined

  constructor(
    private opts: {
      history: () => string[] // newest-last
      getText: () => string // the monitor's local received-byte buffer (≤256KB)
      extraDict: () => string[] // devices.json commands?: string[]
    },
  ) {}

  /** Token index over the received output. Built lazily on Tab, TTL-cached so
   *  a flooding stream cannot make Tab re-split 256KB on every press. */
  private screenTokens(): string[] {
    const now = Date.now()
    if (this.idxCache && now - this.idxCache.at < TOKEN_INDEX_TTL_MS) return this.idxCache.tokens
    const seen = new Set<string>()
    for (const t of this.opts.getText().split(/[^A-Za-z0-9_.\/-]+/)) if (t.length >= 3) seen.add(t)
    this.idxCache = { at: now, tokens: [...seen] }
    return this.idxCache.tokens
  }

  /**
   * Candidates for `prefix` (current token up to the cursor), ranked
   * history > screen > dict, deduped (first source wins). When the token is
   * the whole line and a history command's first word matches, the FULL
   * command is offered (recall-style). Path-like prefixes rank same-directory
   * matches first (stable sort keeps source order within ranks).
   */
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

// Attach a live-only WebSocket (cursor=-1, no replay) and track just the byte
// count + last line, flushed at most once per FLUSH_MS. O(1) memory — used by
// the compact status lines (bottom bar).
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
  const ingest = (chunk: string) => {
    pendingBytes += chunk.length
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
      if (arr[0] === 0x00) return // meta control frame { cursor }
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

// ── Bottom status bar (app_bottom) — auto-appears on serial_create ───────────
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

// ── Sidebar overview ─────────────────────────────────────────────────────────
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

// ── Full-screen monitor ──────────────────────────────────────────────────────
function Monitor(props: { api: TuiPluginApi; params?: Record<string, unknown> }) {
  const dim = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const sessions = useSessions()
  const initial = typeof props.params?.serial_id === "string" ? (props.params.serial_id as string) : undefined
  const [activeId, setActiveId] = createSignal<string | undefined>(initial)
  const current = () => {
    const sid = activeId() ?? sessions()[0]?.id
    return sessions().find((s) => s.id === sid)
  }

  // ── Keymap mode: release tab/ctrl+c from the host while we're mounted ─────
  // api.mode.push exists on current opencode (plugin adapters); signature is
  // tolerated loosely: push() returning a disposer, or push/pop pairs.
  const [hostKeys, setHostKeys] = createSignal(false) // true → host still owns tab/ctrl+c
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
      } else {
        setHostKeys(true)
      }
    } catch {
      setHostKeys(true)
    }
    onCleanup(() => {
      try {
        pop?.()
      } catch {}
    })
  }

  // ── Stream rendering (ONE renderable, batched flush) ──────────────────────
  const [text, setText] = createSignal("")

  let ws: WebSocket | undefined
  let connectedTo: string | undefined
  let buffer = ""
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const dec = new TextDecoder()

  const trimToBudget = (s: string): string => {
    if (s.length <= MAX_CHARS) return s
    const cut = s.length - MAX_CHARS
    const nl = s.indexOf("\n", cut)
    return nl >= 0 ? s.slice(nl + 1) : s.slice(cut)
  }

  const flush = () => {
    flushTimer = undefined
    buffer = trimToBudget(buffer)
    batch(() => setText(buffer))
  }
  const scheduleFlush = () => {
    if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_MS)
  }
  // Hot path: concat into a plain string and arm the timer. No signal write.
  const append = (chunk: string) => {
    buffer += chunk
    scheduleFlush()
  }

  const connect = (sid: string) => {
    if (connectedTo === sid && ws && ws.readyState <= 1) return
    ws?.close()
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    buffer = ""
    setText("")
    connectedTo = sid
    const base = readServerBase()
    if (!base) return
    const wsBase = base.replace(/^http/, "ws")
    // cursor=0 → replay the ring buffer first (history the agent produced
    // before this monitor opened), then live data follows.
    const socket = new WebSocket(`${wsBase}/serial/${sid}/connect?cursor=0`)
    socket.binaryType = "arraybuffer"
    socket.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        append(ev.data)
        return
      }
      const arr = new Uint8Array(ev.data as ArrayBuffer)
      if (arr[0] === 0x00) return // meta control frame { cursor }
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
  })

  // ── Interactive input ──────────────────────────────────────────────────────

  // Transient notice shown in the hint line (WS not open, no completions, …).
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

  // History: one store per device path, cached so [ ] switching keeps each
  // device's history separate.
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

  // History ↑/↓ navigation state. `draft` stashes the in-progress line when Up
  // is first pressed; editing resets navigation (editor onChange).
  const [histIdx, setHistIdx] = createSignal<number | undefined>(undefined)
  let draft = ""

  // Reverse-i-search (ctrl+r). While searching the editor is NOT modified —
  // the input line just RENDERS the search UI — so escape restores trivially.
  const [search, setSearch] = createSignal<{ query: string; pos: number; failed: boolean } | undefined>(undefined)

  // Completion state: snapshot of the line when Tab was first pressed, so
  // cycling always rewrites from the original token.
  type Completion = { line0: string; cursor0: number; start: number; end: number; prefix: string; cands: Cand[]; i: number }
  const [comp, setComp] = createSignal<Completion | undefined>(undefined)

  const editor = useLineEditor({
    onSubmit: (line) => submit(line),
    onChange: () => setHistIdx(undefined), // any edit invalidates history nav
  })

  const engine = new CompletionEngine({
    history: () => history().list(),
    getText: () => buffer, // includes not-yet-flushed bytes
    extraDict: () => deviceForPath(current()?.path)?.commands ?? [],
  })

  // Reset per-session input state when the ATTACHED PATH changes. (Compare by
  // path — the poll replaces the sessions array every 1.5s, so an effect keyed
  // on the array object would wrongly reset completion/search on every poll.)
  let lastPath: string | undefined
  createEffect(() => {
    const p = current()?.path
    if (p === lastPath) return
    lastPath = p
    setHistIdx(undefined)
    draft = ""
    setComp(undefined)
    setSearch(undefined)
  })

  const wsOpen = () => !!ws && ws.readyState === 1

  /** Raw passthrough (ctrl+c / ctrl+g → 0x03). Never touches local input. */
  const sendRaw = (s: string) => {
    if (!wsOpen()) {
      warn("⚠ serial link not open — byte dropped")
      return
    }
    ws!.send(s)
  }

  /** Enter: send line + per-device EOL over the existing monitor WS. The
   *  server's connect() onMessage writes the frame to the port verbatim.
   *  Human input intentionally bypasses the device lease — the human outranks
   *  agents — which works because this WS path has no lock check. */
  const submit = (line: string) => {
    const dev = deviceForPath(current()?.path)
    if (!wsOpen()) {
      warn("⚠ serial link not open — command NOT sent (kept in input)")
      return // keep the text so the user can retry
    }
    ws!.send(line + eolOf(dev))
    if (line.trim()) history().push(line, "human")
    // Device echo normally shows the command in the stream; localEcho is for
    // echo-less consoles (would double-print on echoing devices).
    if (dev?.localEcho) append(line + "\n")
    editor.set("", 0)
    setHistIdx(undefined)
    draft = ""
  }

  // ── History navigation ────────────────────────────────────────────────────
  const histUp = () => {
    const list = history().list()
    if (!list.length) return
    let i = histIdx()
    if (i === undefined) {
      draft = editor.text() // stash in-progress line on first Up
      i = list.length - 1
    } else if (i > 0) {
      i -= 1
    }
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
      editor.set(draft, draft.length) // restore draft past the newest entry
      return
    }
    setHistIdx(i + 1)
    const cmd = list[i + 1]!
    editor.set(cmd, cmd.length)
  }

  // ── Reverse-i-search ──────────────────────────────────────────────────────
  const findMatch = (q: string, from: number): number => {
    if (!q) return -1
    const list = history().list()
    for (let i = Math.min(from, list.length - 1); i >= 0; i--) if (list[i]!.includes(q)) return i
    return -1
  }
  const handleSearchKey = (k: NormKey) => {
    const st = search()!
    const list = history().list()
    if (k.ctrl && k.name === "r") {
      // step to the next OLDER match
      const from = st.pos >= 0 ? st.pos - 1 : list.length - 1
      const p = findMatch(st.query, from)
      setSearch(p >= 0 ? { query: st.query, pos: p, failed: false } : { ...st, failed: true })
      return
    }
    if (k.name === "escape") {
      setSearch(undefined) // editor untouched → draft preserved
      return
    }
    if (k.name === "return") {
      if (st.pos >= 0) {
        const m = list[st.pos]!
        editor.set(m, m.length) // accept into editor; user reviews, then Enter sends
      }
      setSearch(undefined)
      return
    }
    if (k.name === "backspace") {
      const q = st.query.slice(0, -1)
      const p = findMatch(q, list.length - 1)
      setSearch({ query: q, pos: p, failed: q.length > 0 && p < 0 })
      return
    }
    if (k.char !== undefined) {
      const q = st.query + k.char
      const p = findMatch(q, st.pos >= 0 ? st.pos : list.length - 1)
      setSearch({ query: q, pos: p, failed: p < 0 })
      return
    }
    // any other key: accept current match and leave search mode
    if (st.pos >= 0) {
      const m = list[st.pos]!
      editor.set(m, m.length)
    }
    setSearch(undefined)
  }

  // ── Completion ────────────────────────────────────────────────────────────
  const applyCand = (st: Completion) => {
    const cand = st.cands[st.i]!.text
    const line = st.line0.slice(0, st.start) + cand + st.line0.slice(st.end)
    editor.set(line, st.start + cand.length)
  }
  const cancelCompletion = () => {
    const st = comp()
    if (!st) return
    editor.set(st.line0, st.cursor0) // restore pre-completion line
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
    // token under cursor: whitespace-delimited
    let start = cur
    while (start > 0 && !/\s/.test(line[start - 1]!)) start--
    let end = cur
    while (end < line.length && !/\s/.test(line[end]!)) end++
    const prefix = line.slice(start, cur)
    if (!prefix) {
      warn("nothing to complete")
      return
    }
    const tokenIsWholeLine = start === 0 && end === line.length
    const cands = engine.gather(prefix, tokenIsWholeLine)
    if (!cands.length) {
      warn(`no completion for "${prefix}" — try ls'ing the directory first`)
      return
    }
    const st2: Completion = { line0: line, cursor0: cur, start, end, prefix, cands, i: 0 }
    applyCand(st2)
    if (cands.length > 1) setComp(st2) // single match commits immediately
  }

  // ── Paste (bracketed paste arrives as ONE PasteEvent, not keypresses) ─────
  usePaste((event: any) => {
    if (props.api.route.current.name !== ROUTE) return
    if (search()) return // pasting into the search query is not supported
    try {
      let s = ""
      if (event?.bytes instanceof Uint8Array) s = new TextDecoder().decode(event.bytes)
      else if (typeof event?.text === "string") s = event.text
      // Single-line editor: flatten newlines, strip control bytes. (Sending a
      // multi-line paste straight to a serial console would execute each line
      // blind — flattening is the safe default.)
      const flat = s.replace(/[\r\n]+/g, " ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim()
      if (!flat) return
      event?.preventDefault?.()
      const t = editor.text()
      const c = editor.cursor()
      editor.set(t.slice(0, c) + flat + t.slice(c), c + flat.length)
      setHistIdx(undefined)
    } catch {
      // malformed paste event — ignore
    }
  })

  // ── Hint line ─────────────────────────────────────────────────────────────
  const hint = () => {
    if (notice()) return notice()
    const st = comp()
    if (st) {
      const c = st.cands[st.i]!
      const n = st.cands.length
      const w0 = Math.max(0, Math.min(st.i - 1, n - 4))
      const inline = st.cands
        .slice(w0, w0 + 4)
        .map((x, j) => (w0 + j === st.i ? `[${x.text}]` : x.text))
        .join("  ")
      return `↹ ${st.i + 1}/${n}: ${c.text} (${c.source})  ${inline}${n > w0 + 4 ? " …" : ""}`
    }
    if (search()) return "ctrl+r older · enter accept · esc cancel"
    if (hostKeys()) return "⚠ old opencode build: tab/ctrl+c stay host keys — ctrl+g sends interrupt"
    return ""
  }

  // ── Key routing ───────────────────────────────────────────────────────────
  useKeyboard((evt) => {
    if (props.api.route.current.name !== ROUTE) return
    const k = normalizeKey(evt)
    const consume = () => {
      evt.preventDefault()
      evt.stopPropagation()
    }

    // 1. ctrl+c / ctrl+g → device interrupt, ALWAYS (even during search).
    //    ctrl+c reaches us only with the keymap mode pushed; ctrl+g works on
    //    any build. Never clears local input.
    if (k.ctrl && (k.name === "c" || k.name === "g")) {
      consume()
      sendRaw("\x03")
      return
    }

    // 2. reverse-i-search mode swallows everything else
    if (search()) {
      consume()
      handleSearchKey(k)
      return
    }

    // 3. escape — 3-stage: cancel completion → clear input → exit route
    if (k.name === "escape") {
      consume()
      if (comp()) {
        cancelCompletion()
        return
      }
      if (editor.text().length > 0) {
        editor.set("", 0)
        setHistIdx(undefined)
        return
      }
      props.api.route.navigate("home")
      return
    }

    // 4. ctrl+r enters search
    if (k.ctrl && k.name === "r") {
      consume()
      setSearch({ query: "", pos: -1, failed: false })
      return
    }

    // 5. tab / shift+tab — completion cycling
    if (k.name === "tab") {
      consume()
      onTab(k.shift)
      return
    }
    // Any other key COMMITS the currently selected candidate (its text is
    // already in the editor) and proceeds.
    const hadComp = comp() !== undefined
    if (hadComp) setComp(undefined)

    // 6. session switching: [ / ] only while the input is empty (they are
    //    typeable characters); F3/F4 always work. (F2 is the host's
    //    model-cycle key in base mode — avoided entirely.)
    const cycle = (dir: 1 | -1) => {
      const list = sessions()
      if (!list.length) return
      const cur = activeId() ?? list[0]?.id
      const idx = Math.max(0, list.findIndex((s) => s.id === cur))
      setActiveId(list[(idx + dir + list.length) % list.length]?.id)
    }
    if (k.name === "f4" || (k.char === "]" && editor.text() === "")) {
      consume()
      cycle(1)
      return
    }
    if (k.name === "f3" || (k.char === "[" && editor.text() === "")) {
      consume()
      cycle(-1)
      return
    }

    // 7. up/down — history (right after a completion commit they only consume,
    //    so the just-completed line isn't clobbered)
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

    // 8. line editor: printables, arrows, home/end, backspace/delete,
    //    ctrl+u/k/w/a/e, enter→submit
    if (editor.handleKey(k)) {
      consume()
      return
    }
    // unhandled → fall through (leader ctrl+x etc. keep working)
  })

  // ── View ──────────────────────────────────────────────────────────────────
  const inputWidth = () => Math.max(8, dim().width - 8) // container padding + "❯ " + slack

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
          <Show when={activeId() ?? sessions()[0]?.id}>
            <span style={{ fg: theme().textMuted }}> {activeId() ?? sessions()[0]?.id}</span>
          </Show>
          {/* Driver badge — who currently holds the device lease. Human input
              bypasses the lease (humans outrank agents); the badge keeps the
              two-writers situation visible instead of surprising. */}
          <Show when={current()?.owner}>
            <span style={{ fg: theme().warning ?? theme().textMuted }}>
              {" "}· driver: agent {(current()?.owner ?? "").slice(0, 12)}
            </span>
          </Show>
        </text>
        <text fg={theme().textMuted}>tab complete · ↑↓ history · ^R search · ^C intr · [ ]/F3 F4 switch · esc exit</text>
      </box>
      <Show
        when={sessions().length > 0}
        fallback={
          <text fg={theme().textMuted}>No active serial sessions. Ask the agent to open one with serial_create.</text>
        }
      >
        <box border borderColor={theme().border} flexGrow={1} paddingLeft={1} paddingRight={1}>
          {/* ONE renderable holding the whole (bounded) block. */}
          <text fg={theme().text} wrapMode="word">
            {text()}
          </text>
        </box>
      </Show>

      {/* ── Input area — separate renderables: flooding output never repaints
            these except through their own signals ── */}
      <box flexDirection="column" flexShrink={0}>
        <Show when={hint()}>
          <text fg={theme().textMuted}>{hint()}</text>
        </Show>
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
                <span style={{ fg: theme().textMuted }}>
                  {st.failed ? "(failed reverse-i-search)`" : "(reverse-i-search)`"}
                </span>,
                <span>{st.query}</span>,
                <span style={{ fg: theme().textMuted }}>{"`: "}</span>,
                <span>{m}</span>,
              ]
            })()}
          </Show>
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      // Compact live status, bottom of the app frame — auto-appears on create.
      app_bottom() {
        return <BottomBar api={api} />
      },
      // Sidebar block (only visible when the sidebar is shown).
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
      onSelect: () => api.route.navigate(ROUTE, {}),
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
