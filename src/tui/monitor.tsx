/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "../vendor/tui"
import { createSignal, createEffect, onCleanup, For, Show, batch } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { readFileSync } from "node:fs"
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
 *     moment the agent calls serial_create, with no /serial navigation, and is
 *     not gated by the sidebar's width/visibility rules.
 *   - sidebar block  : active sessions + status dot (only when the sidebar is
 *     shown — needs a session and width > 120 cols / manual toggle).
 *   - full-screen monitor (route "serial.monitor"): live byte stream, rendered
 *     as ONE text block with batched flushing so high-throughput serial output
 *     doesn't pin the TUI's CPU.
 *   - `/serial` command + palette entry to open the full-screen view.
 *
 * IMPORTANT (loading): this TUI module is loaded by opencode's TUI plugin
 * loader, which reads `tui.json`, NOT opencode.json. List the plugin in BOTH
 * configs (see INSTALL.md) or none of this renders.
 *
 * Rendering note: only @opentui/solid props/elements already proven in the
 * original monitor are used (box/text/span, border/borderColor, flex*,
 * padding*, wrapMode="word", style={{fg}}). The perf win is the BATCHED FLUSH +
 * SINGLE text node, which needs no special component. A <scrollbox> with
 * stickyScroll is a nice upgrade if your opentui build exposes it, but is left
 * out so this works on the proven element set.
 */

const id = "serial-monitor"
const ROUTE = "serial.monitor"

// Render tuning.
const FLUSH_MS = 33 // ~30fps: coalesce bursty WS chunks into one render/frame
const MAX_CHARS = 256 * 1024 // ring budget for the full-screen text block (~256KB)
const BAR_MAX_SESSIONS = 4 // how many session lines the bottom bar shows

type Session = { id: string; title: string; path: string; baudRate: number; status: string }

// Discover the plugin's self-hosted /serial server. Order:
//   1. OPENCODE_SERIAL_URL env (explicit override)
//   2. <cwd>/.opencode/serial/api.json     (TUI run from the worktree)
//   3. <home>/.opencode/serial/api.json    (global fallback the server also
//      writes — makes discovery work when the TUI's cwd != server worktree,
//      and on Windows where process.env.HOME is unset; os.homedir() is correct)
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

// Attach a live-only WebSocket (cursor=-1, no replay) and track just the byte
// count + last line, flushed at most once per FLUSH_MS. O(1) memory — used by
// the compact status lines (bottom bar). Returns reactive accessors.
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

  // ONE renderable: a single growing string, not a lines[] array. Bursty WS
  // chunks accumulate in a plain `buffer` (no signal write) and are flushed to
  // `text()` at most once per FLUSH_MS — one render per frame instead of one
  // per chunk. This is the dominant CPU win at high serial throughput.
  const [text, setText] = createSignal("")

  let ws: WebSocket | undefined
  let connectedTo: string | undefined
  let buffer = ""
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const dec = new TextDecoder()

  // Trim to the char budget, snapping the cut to the next newline so we never
  // start mid-line. Only runs at flush, only when over budget — no per-chunk
  // splitting of the whole buffer.
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

  useKeyboard((evt) => {
    if (props.api.route.current.name !== ROUTE) return
    if (evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      props.api.route.navigate("home")
      return
    }
    // [ / ] cycle the attached session
    if (evt.name === "]" || evt.name === "[") {
      const list = sessions()
      if (!list.length) return
      const cur = activeId() ?? list[0]?.id
      const idx = Math.max(0, list.findIndex((s) => s.id === cur))
      const next = evt.name === "]" ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length
      evt.preventDefault()
      evt.stopPropagation()
      setActiveId(list[next]?.id)
    }
  })

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
        </text>
        <text fg={theme().textMuted}>[ ] switch · esc exit</text>
      </box>
      <Show
        when={sessions().length > 0}
        fallback={
          <text fg={theme().textMuted}>No active serial sessions. Ask the agent to open one with serial_create.</text>
        }
      >
        <box border borderColor={theme().border} flexGrow={1} paddingLeft={1} paddingRight={1}>
          {/* ONE renderable holding the whole (bounded) block — far cheaper than one <text> per line. */}
          <text fg={theme().text} wrapMode="word">
            {text()}
          </text>
        </box>
      </Show>
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
