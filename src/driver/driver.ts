/**
 * Platform-agnostic serial port interface.
 *
 * Both the node driver (`driver.node.ts`, direct serialport) and the bun
 * driver (`driver.bun.ts`, node sidecar over stdio JSON-RPC) implement this
 * exact shape, so the Serial service never has to care which one is active.
 * Resolved at runtime via the `#serial-driver` import condition.
 */

export type Disp = { dispose(): void }

export type Exit = { exitCode: number }

export type PortInfo = {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  vendorId?: string
  productId?: string
}

export type SerialOpts = {
  baudRate: number
  dataBits?: number
  stopBits?: number
  parity?: "none" | "even" | "odd" | "mark" | "space"
  flowControl?: boolean
  /** Inbound byte decoding. "utf8" (default) decodes streaming so multibyte
   *  chars split across chunks aren't corrupted; "latin1" / "binary" map every
   *  byte 1:1 and never emit replacement chars (for non-UTF-8 / binary consoles). */
  encoding?: "utf8" | "latin1" | "binary"
}

export type SerialPort = {
  onData(listener: (data: string) => void): Disp
  onExit(listener: (event: Exit) => void): Disp
  write(data: string): void
  close(): void
}
