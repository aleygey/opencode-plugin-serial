import * as sp from "serialport"
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
  return {
    onData(listener) {
      port.on("data", (buf: Buffer) => listener(buf.toString("utf-8")))
      return { dispose: () => port.removeListener("data", listener) }
    },
    onExit(listener) {
      port.on("close", () => listener({ exitCode: 0 }))
      return { dispose: () => port.removeListener("close", listener) }
    },
    write(data) {
      port.write(data)
    },
    close() {
      port.close()
    },
  }
}
