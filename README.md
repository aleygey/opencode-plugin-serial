# opencode-plugin-serial

Serial-port tools and a live monitor for [opencode](https://opencode.ai), as a
**standalone plugin** — it changes nothing in opencode core. It mirrors the
behaviour of the in-core serial subsystem (`serial/`, `tool/serial.ts`,
`/serial/*` routes) but ships as its own project, loaded by opencode through the
plugin mechanism.

Built on the same pattern as `opencode-plugin-exp` (the refiner/retrieve
plugin): vendored host types, `export default { id, server }`, and a self-hosted
HTTP/WebSocket server so nothing needs to mount routes in core.

---

## What it gives the agent

14 `serial_*` tools, registered via the `tool` plugin hook:

| tool | purpose |
| --- | --- |
| `serial_list_ports` | enumerate physical devices, annotated from the device map (name/model/baud/in-use) |
| `serial_probe` | which ports have a LIVE machine, and what it looks like (banner/prompt classification) |
| `serial_devices` | list / reload / scaffold the `devices.json` device map |
| `serial_list` | list open sessions |
| `serial_create` | open a session + acquire the device lease (refused if another agent drives it; `takeover` to seize) |
| `serial_write` | write bytes (escape decoding: `\r \n \t \xNN \u####`; needs the lease) |
| `serial_collect` | atomic write → wait-for-prompt → return captured output (auto de-noised) |
| `serial_read_recent` | read the ring buffer, incremental via `since_cursor`, with de-noise flags |
| `serial_digest` | structured "did anything break?" summary (counts + deduped error lines) |
| `serial_grep` | regex-filter the ring buffer (token-cheap) |
| `serial_wait` | block until a pattern appears (sub-ms, in the event loop) |
| `serial_arm` / `serial_disarm` | server-side reactive triggers (e.g. spam `slp` to break u-boot; needs the lease) |
| `serial_close` | close a session |

### Example: break into u-boot (reactive trigger)

```
serial_create({ path: "/dev/ttyUSB0", baudRate: 115200 })   → returns serial_id
serial_arm({ serial_id, every_ms: 50, response: "slp\r\n", until_pattern: "=> " })
serial_write({ serial_id, data: "reboot\n" })
serial_wait({ serial_id, pattern: "=> " })                  → you're at the prompt
```

The trigger fires inside the event loop (sub-millisecond), so it can hit the
autoboot window an LLM tool-call round-trip would miss.

---

## Watching the agent (TUI monitor)

The OS only lets one process hold a device path, so the plugin keeps **one
session per path** and fans the byte stream out to every subscriber. The agent's
tools and your monitor watch the *same* session.

Once the plugin is loaded the TUI gets:

- **Bottom status bar** (`app_bottom`) — one compact live line per session
  (status dot, path@baud, byte counter, last output line). Appears
  automatically the moment the agent calls `serial_create`; no navigation.
- **Sidebar block** — active serial sessions + status dot (needs the sidebar
  visible: terminal wider than 120 cols or the sidebar toggle).
- **Full-screen interactive monitor** — run **`/serial`** (or *Serial Monitor*
  in the palette). Replays ring-buffer history from cursor 0, then live data,
  rendered as ONE batched text block so a flooding device can't pin the TUI CPU.

### Typing into the device (v0.3.0)

The full-screen monitor has a dedicated input line — your command is composed
*outside* the scrolling stream, so flooding output can never eat what you type.
Enter sends it over the same WebSocket the monitor already holds (the server
writes any text frame to the port verbatim).

| key | action |
| --- | --- |
| `Enter` | send line + EOL (default `\r\n`, per-device via `devices.json` `eol`) |
| `Tab` / `Shift+Tab` / `Ctrl+N` | LOCAL completion: current token / cycle candidates (Ctrl+N = shadow-proof) |
| `↑` / `↓` | history (per-device, persisted, **shared with the agent** — `↑` recalls commands the agent ran too) |
| `Ctrl+R` | reverse-i-search through history (bash-style) |
| `Ctrl+C` / `Ctrl+G` | send `0x03` — interrupt the program on the DEVICE |
| `PageUp` / `PageDown` | scroll the scrollback (20k lines); `Home`/`End` (input empty) = top / bottom-follow |
| `/` (input empty) | incremental **find** over the scrollback; `↓`/`↑` next/prev match; `Esc` closes |
| `F4` | toggle **RAW** passthrough (device-native completion/line-editing); `Esc` exits raw |
| `Esc` | LAYERED, one level per press: raw → find → reverse-i-search → completion → clear input → exit view |
| `[` `]` (input empty) / `F3` | switch session |
| `Ctrl+U/K/W/A/E`, `Home/End`, arrows | line editing |

### RAW mode (native device completion) — F4

The local completion above never queries the device. When you specifically want
the **device shell's own** completion (e.g. type a few chars of a script/dir name
+ Tab → the device completes it), press `F4` to enter RAW mode: every keystroke
(incl. Tab, Ctrl-keys, arrows) is forwarded byte-for-byte and the device's echo
renders in the view. RAW transiently **seizes the port** — the agent's writes are
paused (server `rawHold`) while you drive — and `Esc` releases it (a 120s
server-side backstop releases it too if the monitor dies). Not a full VT
emulator (opentui has none): forward typing + unique completion render cleanly;
cursor-addressed redraws / multi-column candidate menus may look rough.

### Color & scrollback (v0.6.0)

The view renders only the visible rows (cheap at any depth) with **device ANSI
color** (16/256/truecolor) and **local keyword highlight** (error→red, warn→
yellow by default; add rules per device via `devices.json` `highlight`). Scroll
back through ~20k lines; new output auto-follows only while pinned to the bottom.

**Completion never queries the device.** The serial line is a single shared
channel that the agent pattern-matches (`serial_collect` / `serial_wait`) — a
hidden `ls` round-trip would pollute the stream it parses. Candidates come from
three local sources instead: command history, tokens already seen in the output
(so `ls` a directory once and its entries become completable), and a static
busybox/u-boot dict plus per-device `commands` from `devices.json`.

While the monitor is open the plugin pushes a dedicated keymap mode (the same
mechanism opencode dialogs use), so host keys like `Tab` (agent cycle) and
`Ctrl+C` (app exit) are released to the monitor; `Ctrl+X` leader chords still
reach the host (`ctrl+x q` quits opencode). On older opencode builds without
`api.mode` the hint line warns and `Ctrl+G` doubles as the interrupt key.

The header shows **`driver: agent <session>`** when an agent holds the device
lease. Human input intentionally bypasses the lease — you outrank the agent —
the badge just keeps the two-writers situation visible.

Per-device input options in `devices.json` (matched by `match.path` in the TUI):

```jsonc
{ "devices": [{
    "name": "proto-A", "match": { "path": "COM3", "serialNumber": "0001" },
    "baudRate": 1500000,
    "eol": "lf",                      // "cr" | "lf" | "crlf" | raw string
    "commands": ["rkdeveloptool"],    // extra Tab-completion entries
    "localEcho": false                 // true for consoles with echo off
}]}
```

Under the hood the monitor reads `.opencode/serial/api.json` (cwd, then home —
the server writes both) to find the server port and attaches to
`/serial/:id/connect?cursor=N`. Any other client (a web view, `websocat`, …)
can attach the same way. Command history lives in
`~/.opencode/serial/history/<port>.json`; the server appends the agent's
newline-terminated writes to the same file.

---

## Install

**During development** — point opencode at the project directory. The spec must
be a path opencode recognizes: an **absolute path**, a **`file://` URL**, or a
path starting with **`.`** (resolved relative to *this config file*).

```jsonc
// opencode config (e.g. .opencode/opencode.json) — server half (tools + /serial)
{
  "plugin": ["/Users/yuxiaotong/Documents/张泽南/opencode-plugin-serial"]
}
```

> ⚠️ **The live UI loads from a SEPARATE config.** opencode's TUI plugin loader
> reads `tui.json`, NOT `opencode.json`. List the plugin in BOTH or the tools
> work but the sidebar / bottom status bar / `/serial` view never appear:
>
> ```jsonc
> // .opencode/tui.json — TUI half (status bar / sidebar / /serial)
> { "plugin": ["/Users/yuxiaotong/Documents/张泽南/opencode-plugin-serial"] }
> ```

> ⚠️ `"file:../opencode-plugin-serial"` (single colon) is **not** recognized —
> opencode would treat it as an npm package name. Use `/abs/path`,
> `file:///abs/path`, or `./relative` / `../relative` instead.

**From the packaged tarball** (`opencode-plugin-serial-0.1.0.tgz`, see *Packaging*):

```sh
npm publish opencode-plugin-serial-0.1.0.tgz   # or host it privately
```
```jsonc
{ "plugin": ["opencode-plugin-serial"] }
```

> ⚠️ If your opencode build still ships the in-core serial tools, disable them so
> the `serial_*` names don't collide with this plugin's.

---

## Configuration

Pass options as the second element of the plugin spec:

```jsonc
{
  "plugin": [["opencode-plugin-serial", { "port": 4097 }]]
}
```

| option | type | default | meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | set `false` to disable the whole plugin |
| `server` | boolean | `true` | set `false` to skip the `/serial` HTTP/WS server (tools still work; no live monitor) |
| `port` | number | random free port | fix the `/serial` server port (useful if the monitor's cwd-based discovery doesn't fit your setup) |
| `directory` | string | `<worktree>/.opencode/serial` | base dir for `api.json`, `devices.json`, `locks/`, history |
| `winConsole` | string | — | win-console (super-work-host) daemon URL, e.g. `http://127.0.0.1:8799`. When set, the plugin registers a panel there (ports / sessions / leases / editable device map) and heartbeats it. Loopback only. |
| `winConsoleToken` | string | — | `x-winhost-token` if the daemon sets `WIN_HOST_PLUGIN_TOKEN`. |

### Auto-open ports on startup (v0.4.0)

Add `"autoOpen": true` (plus a concrete `match.path`) to a `devices.json` entry
and the plugin opens it the moment it loads — so `/serial` and the bottom bar
show the session without waiting for the agent to `serial_create`. Auto-opened
sessions have no lease owner, so an agent can still lease them later.

```jsonc
{ "devices": [
  { "name": "proto-A", "model": "RK3568", "match": { "path": "COM3", "serialNumber": "0001" },
    "baudRate": 1500000, "eol": "cr", "autoOpen": true }
]}
```

### Line endings (v0.4.0)

`eol` (`"cr"` | `"lf"` | `"crlf"` | raw) now applies to **both** the human input
line **and the agent's** writes: the service normalizes whatever trailing
terminator was sent to the device's `eol` (so the agent can keep emitting `\r\n`
and a `\r`-only board still gets a bare `\r`; no double terminator; pure
passthrough when no `eol` is set). Incoming `\r`-only output is also split into
lines for display/grep/digest. Resolve it via the device map (or a per-call
`eol` on `serial_create`).

### Tab to open the monitor (v0.4.0)

The Serial Monitor command registers `Tab` (repurposing the low-value host
`agent.cycle`) to open `/serial`. Inside the monitor, `Tab` stays completion
(the route pushes its own keymap mode). If your opencode build doesn't let a
plugin command's keybind win over the built-in `agent.cycle`, rebind it in your
opencode keybinds config, or just use `/serial`.

### Encoding, telnet & logging (v0.5.0)

**Corruption fix:** the drivers now decode serial input with a *streaming*
decoder, so a multibyte UTF-8 char split across read boundaries (the "◆◆
mid-word" garbage) no longer corrupts. For genuinely non-UTF-8 / binary
consoles set a per-device `encoding`:

```jsonc
{ "name": "board", "match": { "path": "COM3" }, "encoding": "latin1" }
// "utf8" (default, streaming) | "latin1" | "binary"  (latin1/binary = 1:1 byte passthrough, never corrupts)
```

**Telnet** — point a device at a TCP console (terminal server, ser2net, QEMU)
with a `telnet://` path; everything else (sessions, lease, monitor, agent tools)
works identically:

```jsonc
{ "name": "rack-A", "match": { "path": "telnet://10.0.0.5:23" }, "eol": "crlf", "autoOpen": true }
```
or `serial_create({ path: "telnet://10.0.0.5:23" })`. (No NAPI — runs directly
under Bun/Node, bypassing the serialport helper. IAC negotiation + TCP keepalive
handled in the driver.)

**Session logging** — set `"log": true` on a device (or `serial_create({ log:
true })`) to tee the complete, unbounded raw output to
`<base>/logs/<path>-<id>.log` (the 2MB ring buffer is for live/agent reads; the
file is the full record). Byte-exact for latin1/binary sessions.

**Agent sees clean text** — raw ANSI/color bytes stay in the ring buffer and the
WebSocket (so the monitor can render color), but the agent-facing reads
(`serial_read_recent`/`collect`/`grep`/`digest`/`wait`) strip ANSI + control
bytes, so a colored `error` still matches and escapes don't waste tokens.

### win-console panel (v0.4.0)

With `winConsole` set, the plugin appears in win-console as a panel showing
ports (name/model/in-use), open sessions, device leases (who's driving, with a
force-release button for stale holds), and an editable `devices.json`. The panel
is served by this plugin at `GET /serial/panel` and talks to its own `/serial`
REST — win-console only embeds the iframe + heartbeats it. Topology: run this
plugin as a **Windows** process (so it can open COMx) reachable on loopback; the
agent in WSL reaches the tools as usual.

---

## Architecture

```
src/
├── index.ts          plugin entry — export default { id:"serial", server }
│                     configures the service (base dir), registers the tools,
│                     starts the /serial server
├── service.ts        Serial service: session table, 2 MB ring buffer, reactive
│                     triggers, one-shot waiters, WS fan-out, device-map match,
│                     per-device leases. Plain singleton (no Effect, no core deps).
├── reduce.ts         log de-noiser (Q1): CR-flatten, volatile-token normalize,
│                     cyclic-block + consecutive-dup collapse. Pure, display-only.
├── devices.ts        device map (devices.json) — adapter → prototype/model/baud
├── locks.ts          LockManager — per-device lease (one writer, many observers)
├── schema.ts         SerialID (self-contained ascending id)
├── server.ts         self-hosted Hono + Bun.serve /serial/* REST + WebSocket
│                     (writes api.json to <base> AND <home> for robust discovery)
├── paths.ts          api.json discovery-file location
├── tools.ts          the serial_* tool definitions (plugin `tool()` shape)
├── tui/monitor.tsx   TUI plugin: bottom status bar + sidebar + full-screen monitor
├── driver/           serialport access
│   ├── driver.ts        platform-agnostic SerialPort interface
│   ├── driver.node.ts   direct serialport (Node)
│   ├── driver.bun.ts    node-sidecar driver (bun can't load serialport's NAPI)
│   └── helper.ts        the node sidecar process
└── vendor/
    ├── opencode.ts   vendored host types + tool()  (server side)
    └── tui.ts        vendored TUI plugin types       (monitor side)
```

The two `vendor/` files are what keep the project standalone: they inline the
slice of opencode's plugin contract this plugin needs, so there's no dependency
on `@opencode-ai/plugin` from a private fork registry.

### Why a node sidecar

`serialport` ships native NAPI bindings; bun (1.3.x) can't load them
(oven-sh/bun#18546). Under bun the driver spawns a Node child process that hosts
serialport and talks over stdio JSON-RPC. Under Node it loads serialport
directly. A locally installed Node + serialport is all the sidecar needs.

---

## Troubleshooting

- **`serial helper not found` / tools fail under bun** — the sidecar needs a
  `node` on PATH and a resolvable `serialport`. `bun install` in this project
  provides both for local/file installs.
- **Monitor shows "No active serial sessions"** — the agent hasn't opened one
  yet (`serial_create`), or the monitor can't find `api.json`. The monitor looks
  under `process.cwd()/.opencode/serial/`; if your TUI runs from a different cwd,
  set a fixed `port` and the monitor still discovers it via the same file once
  written, or attach a client directly to `http://127.0.0.1:<port>/serial`.
- **`serial_*` name collision** — disable the in-core serial tools in your
  opencode build (see *Install*).
- **`incorrect peer dependency "solid-js@1.9.10"`** on install — harmless; it's
  the version opencode's TUI pins.

---

## Packaging

```sh
bun pm pack          # → opencode-plugin-serial-0.1.0.tgz (src + package.json + README)
```

The tarball contains the `.ts`/`.tsx` sources (opencode loads plugins from
source) plus `package.json` and this README. `node_modules` and dev config are
excluded via the `files` field.

## Develop

```sh
bun install
bun run typecheck    # tsc/tsgo --noEmit, 0 errors
bun test
```
