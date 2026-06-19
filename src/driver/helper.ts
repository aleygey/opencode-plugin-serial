/**
 * Serial helper — Node-runtime sidecar for the Bun-compiled opencode binary.
 *
 * Why this file exists:
 *   The `serialport` npm package ships native NAPI bindings. Bun (1.3.10
 *   at time of writing) doesn't implement `uv_default_loop`, so loading
 *   serialport inside the bun-compiled main binary crashes immediately
 *   (oven-sh/bun#18546). To work around that without forcing the entire
 *   project off Bun, we host serialport inside a tiny Node child process
 *   and the main binary talks to it over stdio JSON-RPC.
 *
 * Wire format:
 *   - Each message is one line of UTF-8 JSON terminated by '\n'.
 *   - Commands (parent → helper):
 *       { id: <number>, op: "list" }
 *       { id: <number>, op: "open", path, baudRate, dataBits?, stopBits?, parity?, flowControl? }
 *       { id: <number>, op: "write", handle, data }
 *       { id: <number>, op: "close", handle }
 *   - Responses (helper → parent):
 *       { id, ok: true,  result?: <value> }
 *       { id, ok: false, error: <message> }
 *   - Async events (helper → parent, no id):
 *       { event: "data",  handle, data }
 *       { event: "close", handle, exitCode }
 *       { event: "ready" }                  // emitted once at startup
 *
 * Lifecycle:
 *   The helper runs forever until its stdin closes (parent exits) or it
 *   receives `{ op: "shutdown" }`. All open handles are torn down on exit.
 *
 * Build: bundled via `bun build --target=node` and shipped next to the main
 * binary as an asset; at runtime the bun driver (`driver.bun.ts`) spawns
 * `node` against it. See `driver.bun.ts` for the driver side.
 */

// `serialport` is required at runtime (not bundled). The build step ships
// `node_modules/serialport` next to the helper script, and the parent
// spawns node with that node_modules visible.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sp = require("serialport") as typeof import("serialport")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StringDecoder } = require("node:string_decoder") as typeof import("node:string_decoder")

type Cmd =
  | { id: number; op: "list" }
  | {
      id: number
      op: "open"
      path: string
      baudRate: number
      dataBits?: number
      stopBits?: number
      parity?: "none" | "even" | "odd" | "mark" | "space"
      flowControl?: boolean
      encoding?: "utf8" | "latin1" | "binary"
    }
  | { id: number; op: "write"; handle: number; data: string }
  | { id: number; op: "close"; handle: number }
  | { id: number; op: "shutdown" }

type SerialPortInst = InstanceType<typeof sp.SerialPort>

const ports = new Map<number, SerialPortInst>()
const decoders = new Map<number, InstanceType<typeof StringDecoder>>()
let nextHandle = 1

function send(payload: unknown) {
  process.stdout.write(JSON.stringify(payload) + "\n")
}

function ok(id: number, result?: unknown) {
  send({ id, ok: true, result })
}

function err(id: number, e: unknown) {
  send({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
}

async function handle(cmd: Cmd) {
  switch (cmd.op) {
    case "list": {
      try {
        const list = await sp.SerialPort.list()
        ok(cmd.id, list)
      } catch (e) {
        err(cmd.id, e)
      }
      return
    }
    case "open": {
      try {
        const port = new sp.SerialPort({
          path: cmd.path,
          baudRate: cmd.baudRate,
          dataBits: (cmd.dataBits ?? 8) as 5 | 6 | 7 | 8,
          stopBits: (cmd.stopBits ?? 1) as 1 | 2,
          parity: cmd.parity ?? "none",
          rtscts: cmd.flowControl ?? false,
          autoOpen: false,
        })
        const handleId = nextHandle++
        // STREAMING decode (was buf.toString('utf-8') per chunk — the cause of
        // the "◆◆ mid-word" corruption when a multibyte char straddled a chunk
        // boundary or a stray high byte appeared). latin1/binary = lossless 1:1.
        const decoder = new StringDecoder(cmd.encoding === "latin1" || cmd.encoding === "binary" ? "latin1" : "utf8")
        decoders.set(handleId, decoder)
        port.on("data", (buf: Buffer) => {
          const text = decoder.write(buf)
          if (text) send({ event: "data", handle: handleId, data: text })
        })
        port.on("close", () => {
          const tail = decoders.get(handleId)?.end()
          if (tail) send({ event: "data", handle: handleId, data: tail })
          decoders.delete(handleId)
          ports.delete(handleId)
          send({ event: "close", handle: handleId, exitCode: 0 })
        })
        port.on("error", (e: Error) => {
          // Don't tear down on error — surface it; serialport often emits
          // transient errors that don't necessarily mean the port is dead.
          send({ event: "error", handle: handleId, error: e.message })
        })
        port.open((openErr?: Error | null) => {
          if (openErr) {
            err(cmd.id, openErr)
            return
          }
          ports.set(handleId, port)
          ok(cmd.id, { handle: handleId })
        })
      } catch (e) {
        err(cmd.id, e)
      }
      return
    }
    case "write": {
      const port = ports.get(cmd.handle)
      if (!port) return err(cmd.id, `unknown handle: ${cmd.handle}`)
      port.write(cmd.data, (writeErr?: Error | null) => {
        if (writeErr) err(cmd.id, writeErr)
        else ok(cmd.id)
      })
      return
    }
    case "close": {
      const port = ports.get(cmd.handle)
      if (!port) return ok(cmd.id) // already closed — idempotent
      port.close((closeErr?: Error | null) => {
        ports.delete(cmd.handle)
        if (closeErr) err(cmd.id, closeErr)
        else ok(cmd.id)
      })
      return
    }
    case "shutdown": {
      cleanupAndExit(0)
      return
    }
  }
}

function cleanupAndExit(code: number) {
  for (const port of ports.values()) {
    try {
      port.close()
    } catch {
      // ignore
    }
  }
  ports.clear()
  process.exit(code)
}

// Read newline-delimited JSON from stdin.
let buf = ""
process.stdin.setEncoding("utf-8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  let nl = buf.indexOf("\n")
  while (nl !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) {
      try {
        const cmd = JSON.parse(line) as Cmd
        void handle(cmd)
      } catch (e) {
        // Malformed JSON — surface it but keep the stream alive.
        send({ event: "error", error: `bad json: ${e instanceof Error ? e.message : e}` })
      }
    }
    nl = buf.indexOf("\n")
  }
})
process.stdin.on("end", () => cleanupAndExit(0))
process.on("SIGTERM", () => cleanupAndExit(0))
process.on("SIGINT", () => cleanupAndExit(0))

send({ event: "ready" })
