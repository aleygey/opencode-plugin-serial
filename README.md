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

11 `serial_*` tools, registered via the `tool` plugin hook:

| tool | purpose |
| --- | --- |
| `serial_list_ports` | enumerate physical devices on the host |
| `serial_list` | list open sessions |
| `serial_create` | open a session (returns a SerialID; reuses an existing session on the same path) |
| `serial_write` | write bytes (escape decoding: `\r \n \t \xNN \u####`) |
| `serial_collect` | atomic write → wait-for-prompt → return captured output |
| `serial_read_recent` | read the ring buffer, incremental via `since_cursor` |
| `serial_grep` | regex-filter the ring buffer (token-cheap) |
| `serial_wait` | block until a pattern appears (sub-ms, in the event loop) |
| `serial_arm` / `serial_disarm` | server-side reactive triggers (e.g. spam `slp` to break u-boot) |
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

- **Sidebar block** — active serial sessions + status dot (green = connected),
  refreshed automatically.
- **Full-screen monitor** — run the **`/serial`** command (or pick *Serial
  Monitor* from the command palette) to open it. Keys: `[` / `]` switch session,
  `esc` exits. It replays ring-buffer history from cursor 0, so you see
  everything the agent did — including before you opened the monitor — then live
  data.

Under the hood the monitor reads `<worktree>/.opencode/serial/api.json` to find
the plugin's server port and attaches to `/serial/:id/connect?cursor=N`. Any
other client (a web view, `websocat`, …) can attach the same way.

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
| `directory` | string | `<worktree>/.opencode/serial` | base dir for `api.json` |

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
