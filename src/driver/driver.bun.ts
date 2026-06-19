import type { SerialPort, PortInfo, SerialOpts } from "./driver"
import { isTelnetPath, open as openTelnet } from "./telnet"
import * as path from "path"
import * as fs from "fs"

export type { Disp, Exit, PortInfo, SerialOpts, SerialPort } from "./driver"

/**
 * Bun-side serialport driver — talks to a Node sidecar process over stdio
 * JSON-RPC. See `helper.ts` for the wire format.
 *
 * Why this exists: bun 1.3.10 doesn't implement `uv_default_loop`, which
 * `serialport`'s NAPI bindings need at load time. Loading serialport
 * directly inside the bun-compiled main binary crashes the process. The
 * sidecar runs under Node (which has full libuv) and the main binary
 * shells out to it. The user-facing `SerialPort` API stays identical so
 * the Serial service doesn't need to change.
 *
 * The helper is launched lazily on first use and reused for the lifetime
 * of the opencode process. A single helper handles all open ports.
 */

type PendingResolve = (value: unknown) => void
type PendingReject = (err: Error) => void
type Pending = { resolve: PendingResolve; reject: PendingReject }

type DataListener = (data: string) => void
type ExitListener = (event: { exitCode: number }) => void

let helperReady: Promise<HelperHandle> | null = null

type HelperHandle = {
  send(cmd: Record<string, unknown>): Promise<unknown>
  registerHandle(
    h: number,
    d: { data: Set<DataListener>; close: Set<ExitListener> },
  ): void
  unregisterHandle(h: number): void
}

/* Locate the helper assets (helper.js + node_modules/serialport).
 *
 * Layout, mirroring the build script:
 *   <opencode binary>/../../serial-helper/helper.js
 *   <opencode binary>/../../serial-helper/node_modules/serialport/...
 *
 * In dev (running source via `bun run`) we walk up to a `node_modules/
 * serialport` and run the helper TypeScript via bun. */
function locateHelper(): { script: string; nodeModulesParent: string } | null {
  const candidates: Array<{ script: string; nodeModulesParent: string }> = []
  // Production layout — `dist/<pkg>/bin/opencode` + `dist/<pkg>/serial-helper/`
  const exePath = process.execPath
  const distRoot = path.dirname(path.dirname(exePath)) // <pkg>/
  candidates.push({
    script: path.join(distRoot, "serial-helper", "helper.js"),
    nodeModulesParent: path.join(distRoot, "serial-helper"),
  })
  // Dev / test — repo node_modules has the real serialport, plus we can
  // run the helper TypeScript via bun.
  const repoHelper = path.resolve(__dirname, "helper.ts")
  // Walk up looking for a `node_modules/serialport`. Cap at 8 levels (the
  // package may be nested deeper inside a monorepo than the old in-core path).
  let cur = path.dirname(repoHelper)
  for (let i = 0; i < 8; i++) {
    const probe = path.join(cur, "node_modules", "serialport")
    if (fs.existsSync(probe)) {
      candidates.push({ script: repoHelper, nodeModulesParent: cur })
      break
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const c of candidates) {
    if (fs.existsSync(c.script)) return c
  }
  return null
}

async function getHelper(): Promise<HelperHandle> {
  if (helperReady) return helperReady
  helperReady = (async () => {
    const loc = locateHelper()
    if (!loc) {
      throw new Error(
        "serial helper not found — expected `serial-helper/helper.js` next to the opencode binary or a `node_modules/serialport` in the workspace.",
      )
    }
    const isTs = loc.script.endsWith(".ts")
    // In dev (TS source) we re-launch via `bun` so it can transpile on the
    // fly. In prod we use system `node` because bun is exactly what we're
    // trying to avoid for serialport NAPI loading.
    const cmd = isTs ? "bun" : "node"
    const args = isTs ? ["run", loc.script] : [loc.script]
    // Make the bundled node_modules visible to whichever runtime we picked.
    const env = {
      ...process.env,
      NODE_PATH: [loc.nodeModulesParent + "/node_modules", process.env.NODE_PATH ?? ""]
        .filter(Boolean)
        .join(path.delimiter),
    }
    type HelperProc = {
      stdin: unknown
      stdout: ReadableStream<Uint8Array>
      stderr: ReadableStream<Uint8Array>
      exited: Promise<number>
      kill(signal?: number | string): void
    }
    let proc: HelperProc
    try {
      // Bun.spawn with all three pipes ⇒ stdin is FileSink, stdout/stderr
      // are ReadableStreams. Casting via `unknown` keeps TypeScript happy
      // while preserving the exact shape we rely on at runtime.
      proc = Bun.spawn([cmd, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
        cwd: loc.nodeModulesParent,
      }) as unknown as HelperProc
    } catch (e) {
      throw new Error(
        `Could not start serial helper — \`${cmd}\` is not available on PATH. ` +
          `serial_* tools require Node.js (the helper runs serialport's NAPI ` +
          `bindings under Node because bun 1.3.10 doesn't yet support them — ` +
          `oven-sh/bun#18546).`,
        { cause: e as Error },
      )
    }
    const stdin = proc.stdin
    if (!stdin) throw new Error("helper stdin missing")
    // Bun exposes child stdin as a FileSink — synchronous .write() is what
    // the rest of the codebase uses.
    const sink = stdin as unknown as {
      write(data: string | Uint8Array): unknown
      flush?: () => unknown
    }
    const writeLine = (line: string) => {
      sink.write(line + "\n")
      try {
        sink.flush?.()
      } catch {
        // ignore — flush isn't required for correctness, just latency.
      }
    }
    const pending = new Map<number, Pending>()
    const handles = new Map<
      number,
      { data: Set<DataListener>; close: Set<ExitListener> }
    >()
    let nextId = 1
    let alive = true

    // Pipe stderr to our own stderr so helper diagnostics aren't lost.
    void (async () => {
      const reader = proc.stderr.getReader()
      const dec = new TextDecoder()
      try {
        for (;;) {
          const r = await reader.read()
          if (r.done) break
          process.stderr.write("[serial-helper] " + dec.decode(r.value))
        }
      } catch {
        // ignore
      }
    })()

    // Read newline-delimited JSON from helper stdout.
    void (async () => {
      const reader = proc.stdout.getReader()
      const dec = new TextDecoder()
      let buf = ""
      try {
        for (;;) {
          const r = await reader.read()
          if (r.done) break
          buf += dec.decode(r.value, { stream: true })
          let nl = buf.indexOf("\n")
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line) handleLine(line)
            nl = buf.indexOf("\n")
          }
        }
      } catch {
        // ignore
      } finally {
        alive = false
        for (const p of pending.values()) p.reject(new Error("serial helper exited"))
        pending.clear()
        helperReady = null
      }
    })()

    function handleLine(line: string) {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (typeof msg.event === "string") {
        const handle = msg.handle as number | undefined
        if (msg.event === "data" && typeof handle === "number") {
          const reg = handles.get(handle)
          if (reg) {
            for (const fn of reg.data) {
              try {
                fn(String(msg.data ?? ""))
              } catch {
                // ignore
              }
            }
          }
        } else if (msg.event === "close" && typeof handle === "number") {
          const reg = handles.get(handle)
          if (reg) {
            const exitCode = (msg.exitCode as number | undefined) ?? 0
            for (const fn of reg.close) {
              try {
                fn({ exitCode })
              } catch {
                // ignore
              }
            }
          }
          handles.delete(handle)
        }
        return
      }
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(String(msg.error ?? "serial helper error")))
      }
    }

    const handle: HelperHandle = {
      send(cmd) {
        if (!alive) return Promise.reject(new Error("serial helper not alive"))
        const id = nextId++
        const promise = new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject })
        })
        writeLine(JSON.stringify({ ...cmd, id }))
        return promise
      },
      registerHandle(h, d) {
        handles.set(h, d)
      },
      unregisterHandle(h) {
        handles.delete(h)
      },
    }

    return handle
  })()
  // Reset the cached promise on failure so the next call retries.
  helperReady.catch(() => {
    helperReady = null
  })
  return helperReady
}

export async function listPorts(): Promise<PortInfo[]> {
  try {
    const helper = await getHelper()
    const result = (await helper.send({ op: "list" })) as PortInfo[]
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

export function open(devPath: string, opts: SerialOpts): SerialPort {
  // telnet:// is a TCP socket — net.Socket works natively under Bun (no NAPI),
  // so it bypasses the serialport node-sidecar helper entirely.
  if (isTelnetPath(devPath)) return openTelnet(devPath, opts)
  // The public API is sync but our IPC is async. Resolve a handle id
  // lazily and queue any operations that arrive before it lands.
  const dataListeners = new Set<DataListener>()
  const closeListeners = new Set<ExitListener>()
  const pendingWrites: string[] = []
  let helper: HelperHandle | null = null
  let handleId: number | null = null
  let openError: Error | null = null
  let closed = false

  const ready = (async () => {
    helper = await getHelper()
    helper.registerHandle(-1, { data: dataListeners, close: closeListeners })
    const result = (await helper.send({
      op: "open",
      path: devPath,
      baudRate: opts.baudRate,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? "none",
      flowControl: opts.flowControl ?? false,
      encoding: opts.encoding ?? "utf8",
    })) as { handle: number }
    handleId = result.handle
    helper.unregisterHandle(-1)
    helper.registerHandle(handleId, { data: dataListeners, close: closeListeners })
    // Drain any writes queued before the open round-trip completed.
    while (pendingWrites.length > 0) {
      const data = pendingWrites.shift()!
      void helper.send({ op: "write", handle: handleId, data })
    }
    if (closed) {
      void helper.send({ op: "close", handle: handleId })
    }
  })().catch((e: Error) => {
    openError = e
    for (const fn of closeListeners) {
      try {
        fn({ exitCode: 1 })
      } catch {
        // ignore
      }
    }
  })

  return {
    onData(listener) {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener) {
      closeListeners.add(listener)
      // If the open already failed before the user attached a listener,
      // surface it on the next tick so callers don't deadlock.
      if (openError) {
        queueMicrotask(() => listener({ exitCode: 1 }))
      }
      return { dispose: () => closeListeners.delete(listener) }
    },
    write(data) {
      if (handleId === null) {
        pendingWrites.push(data)
        return
      }
      if (helper && !closed) {
        void helper.send({ op: "write", handle: handleId, data })
      }
    },
    close() {
      closed = true
      if (handleId !== null && helper) {
        void helper.send({ op: "close", handle: handleId }).catch(() => {})
      }
    },
  }
  // Mark `ready` as used to silence noUnusedLocals — the promise is fire-
  // and-forget; errors are routed through `closeListeners`.
  void ready
}
