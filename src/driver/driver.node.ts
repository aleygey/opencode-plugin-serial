import * as sp from "serialport"
import { StringDecoder } from "node:string_decoder"
import { isTelnetPath, open as openTelnet } from "./telnet"
import type { SerialPort, PortInfo, SerialOpts } from "./driver"

export type { Disp, Exit, PortInfo, SerialOpts, SerialPort } from "./driver"

export async function listPorts(): Promise<PortInfo[]> {
  try {
    return await sp.SerialPort.list()
  } catch {
    return []
  }
}

export function open(path: string, opts: SerialOpts): SerialPort {
  // telnet:// targets are TCP, not a physical port — handled by the net.Socket
  // driver (no serialport, no NAPI).
  if (isTelnetPath(path)) return openTelnet(path, opts)

  // STREAMING decoder: holds an incomplete trailing multibyte sequence across
  // chunks so a UTF-8 char split at a chunk boundary isn't turned into
  // replacement glyphs (the "◆◆ mid-word" corruption). latin1/binary = 1:1.
  const decoder = new StringDecoder(opts.encoding === "latin1" || opts.encoding === "binary" ? "latin1" : "utf8")
  const dataListeners = new Set<(d: string) => void>()
  const exitListeners = new Set<(e: { exitCode: number }) => void>()

  const port = new sp.SerialPort({
    path,
    baudRate: opts.baudRate,
    dataBits: opts.dataBits ?? 8,
    stopBits: opts.stopBits ?? 1,
    parity: opts.parity ?? "none",
    rtscts: opts.flowControl ?? false,
    autoOpen: false,
  })
  port.open()

  // Decode ONCE per chunk (decoder is stateful), then fan out to all listeners.
  port.on("data", (buf: Buffer) => {
    const text = decoder.write(buf)
    if (text) for (const fn of dataListeners) try { fn(text) } catch {}
  })
  // MUST listen for 'error': a serialport is a Node stream, and an 'error' with
  // no listener (USB surprise-removal, I/O error) throws uncaught and CRASHES
  // the host process. Surface it as a non-fatal exit instead.
  port.on("error", () => {
    for (const fn of exitListeners) try { fn({ exitCode: 1 }) } catch {}
  })
  port.on("close", () => {
    const tail = decoder.end() // flush any buffered partial multibyte char
    if (tail) for (const fn of dataListeners) try { fn(tail) } catch {}
    for (const fn of exitListeners) try { fn({ exitCode: 0 }) } catch {}
  })

  return {
    onData(listener) {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener) {
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    },
    write(data) {
      port.write(data)
    },
    close() {
      try {
        port.close()
      } catch {
        // ignore
      }
    },
  }
}
