/**
 * Telnet transport — a SerialPort over a TCP socket (RFC 854), so the same
 * service/tools/monitor stack drives networked consoles (terminal servers,
 * QEMU, ser2net, board telnet) exactly like a physical port.
 *
 * Wired into both drivers by PATH SHAPE: open()/listPorts() in driver.node.ts
 * and driver.bun.ts dispatch to here when the path is `telnet://host[:port]`.
 * net.Socket needs no native addon, so this runs directly under Bun AND Node —
 * it does NOT go through the serialport node-sidecar helper.
 *
 * Telnet differs from a raw byte pipe in ONE way that matters here: in-band IAC
 * option negotiation. Those control bytes (0xFF …) must be stripped BEFORE the
 * stream reaches the ring buffer / agent pattern-matchers / monitor, or they
 * render as garbage and break regex matches. We do the minimal correct dance:
 * un-escape IAC IAC → 0xFF, refuse every WILL/DO we don't implement (DONT/WONT),
 * accept SGA + BINARY, skip subnegotiations, and escape outbound 0xFF.
 *
 * Decoding uses a STREAMING StringDecoder (same fix as the serial drivers) so a
 * multibyte char split across TCP segments isn't corrupted. `encoding: "latin1"`
 * (or "binary") gives lossless 1:1 byte passthrough for non-UTF-8 consoles.
 */

import net from "node:net"
import { StringDecoder } from "node:string_decoder"
import type { SerialPort, SerialOpts, Disp, Exit } from "./driver"

// Telnet commands.
const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240
// Options we accept.
const OPT_BINARY = 0
const OPT_SGA = 3

export function isTelnetPath(path: string): boolean {
  return /^telnet:\/\//i.test(path)
}

/** Parse `telnet://host:port` (port defaults to 23). */
function parseTarget(path: string): { host: string; port: number } {
  const rest = path.replace(/^telnet:\/\//i, "")
  const m = rest.match(/^(\[[^\]]+\]|[^:/]+)(?::(\d+))?/) // host or [ipv6], optional :port
  const host = (m?.[1] ?? rest).replace(/^\[|\]$/g, "")
  const port = m?.[2] ? Number(m[2]) : 23
  return { host, port }
}

export function open(path: string, opts: SerialOpts): SerialPort {
  const { host, port } = parseTarget(path)
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(e: Exit) => void>()
  const enc = opts.encoding === "latin1" || opts.encoding === "binary" ? "latin1" : "utf8"
  const decoder = new StringDecoder(enc)

  let exited = false
  const fireExit = (exitCode: number) => {
    if (exited) return
    exited = true
    const tail = decoder.end()
    if (tail) for (const fn of dataListeners) try { fn(tail) } catch {}
    for (const fn of exitListeners) try { fn({ exitCode }) } catch {}
  }

  const socket = net.createConnection({ host, port })
  socket.setKeepAlive(true, 20_000) // OS-level dead-peer detection (serial has none)
  socket.setNoDelay(true)

  // IAC state machine over the raw inbound bytes. Emits only application data.
  // "sb"/"sb_iac" discard a subnegotiation payload until IAC SE (RFC 855),
  // honoring IAC IAC escaping inside it — subnegotiation bytes NEVER reach the
  // application stream.
  let st: "data" | "iac" | "opt" | "sb" | "sb_iac" = "data"
  let cmd = 0
  const emit = (clean: Buffer) => {
    if (!clean.length) return
    const text = decoder.write(clean)
    if (text) for (const fn of dataListeners) try { fn(text) } catch {}
  }
  const reply = (a: number, b: number) => {
    try {
      socket.write(Buffer.from([IAC, a, b]))
    } catch {}
  }

  socket.on("data", (buf: Buffer) => {
    const out: number[] = []
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i]!
      switch (st) {
        case "data":
          if (c === IAC) st = "iac"
          else out.push(c)
          break
        case "iac":
          if (c === IAC) {
            out.push(IAC) // escaped literal 0xFF
            st = "data"
          } else if (c === WILL || c === WONT || c === DO || c === DONT) {
            cmd = c
            st = "opt"
          } else if (c === SB) {
            st = "sb"
          } else {
            st = "data" // NOP / other 2-byte command — ignore
          }
          break
        case "opt": {
          // Negotiation: accept SGA + BINARY, refuse everything else; ignore the
          // peer's refusals (WONT/DONT) to avoid negotiation loops.
          const accept = c === OPT_SGA || c === OPT_BINARY
          if (cmd === WILL) reply(accept ? DO : DONT, c)
          else if (cmd === DO) reply(accept ? WILL : WONT, c)
          st = "data"
          break
        }
        case "sb":
          // Discard subnegotiation payload (NEVER emit). Only IAC starts a
          // possible IAC SE / IAC IAC inside SB (RFC 855).
          if (c === IAC) st = "sb_iac"
          break
        case "sb_iac":
          if (c === SE) st = "data" // end of subnegotiation
          else st = "sb" // IAC IAC (escaped 0xFF in payload) or non-conformant — stay, discard
          break
      }
    }
    emit(Buffer.from(out))
  })

  socket.on("error", () => fireExit(1))
  socket.on("close", () => fireExit(0))
  socket.on("end", () => fireExit(0))

  return {
    onData(listener: (data: string) => void): Disp {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener: (e: Exit) => void): Disp {
      exitListeners.add(listener)
      if (exited) queueMicrotask(() => listener({ exitCode: 0 }))
      return { dispose: () => exitListeners.delete(listener) }
    },
    write(data: string) {
      // Escape any literal 0xFF in outbound data (IAC → IAC IAC).
      const bytes = Buffer.from(data, enc)
      if (bytes.includes(IAC)) {
        const esc: number[] = []
        for (const b of bytes) {
          esc.push(b)
          if (b === IAC) esc.push(IAC)
        }
        try { socket.write(Buffer.from(esc)) } catch {}
      } else {
        try { socket.write(bytes) } catch {}
      }
    },
    close() {
      try { socket.end() } catch {}
      try { socket.destroy() } catch {}
    },
  }
}
