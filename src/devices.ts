/**
 * Device map — a human-curated table mapping a physical USB-serial adapter to
 * the prototype it is wired to, so the agent sees "proto-A (RK3568) on COM3"
 * instead of an anonymous FTDI/CP210x/CH340.
 *
 * Source of truth is DATA, not code: `<base>/devices.json` (base =
 * <worktree>/.opencode/serial by default). Edit that file; the plugin reloads
 * it on configure() and via serial_devices({action:"reload"}).
 *
 * Matching precedence (most → least stable): serialNumber > pnpId >
 * vendorId+productId > path. serialNumber is the only identifier stable across
 * a USB re-enumeration (a board reboot can change the COM/tty path).
 *
 * Example devices.json:
 * {
 *   "devices": [
 *     { "name": "proto-A", "model": "RK3568 EVB",
 *       "match": { "serialNumber": "0001", "vendorId": "1a86", "productId": "7523" },
 *       "baudRate": 1500000,
 *       "prompt": { "breakSeq": "", "readyRe": "=> |# " },
 *       "notes": "uboot break = ctrl-C" },
 *     { "name": "proto-B", "model": "ESP32-S3",
 *       "match": { "vendorId": "303a", "productId": "1001" },
 *       "baudRate": 115200,
 *       "prompt": { "readyRe": "ets |rst:0x" } }
 *   ]
 * }
 */

import { readFileSync } from "node:fs"
import path from "node:path"

export type DeviceMatch = {
  serialNumber?: string
  vendorId?: string
  productId?: string
  pnpId?: string
  path?: string
}

export type Device = {
  name: string
  model?: string
  match: DeviceMatch
  baudRate?: number
  prompt?: { breakSeq?: string; readyRe?: string }
  notes?: string
}

export type PortLike = {
  path: string
  serialNumber?: string
  vendorId?: string
  productId?: string
  pnpId?: string
  manufacturer?: string
}

let devices: Device[] = []
let loadedFrom: string | undefined

export function load(base: string): void {
  loadedFrom = path.join(base, "devices.json")
  try {
    const raw = JSON.parse(readFileSync(loadedFrom, "utf8")) as { devices?: Device[] }
    devices = Array.isArray(raw.devices) ? raw.devices : []
  } catch {
    devices = []
  }
}

export function reload(): { count: number; from?: string } {
  if (loadedFrom) {
    try {
      const raw = JSON.parse(readFileSync(loadedFrom, "utf8")) as { devices?: Device[] }
      devices = Array.isArray(raw.devices) ? raw.devices : []
    } catch {
      devices = []
    }
  }
  return { count: devices.length, from: loadedFrom }
}

export function all(): Device[] {
  return devices
}

const eqi = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function match(port: PortLike): Device | undefined {
  for (const d of devices) if (d.match.serialNumber && eqi(d.match.serialNumber, port.serialNumber)) return d
  for (const d of devices) if (d.match.pnpId && eqi(d.match.pnpId, port.pnpId)) return d
  for (const d of devices)
    if (d.match.vendorId && d.match.productId && eqi(d.match.vendorId, port.vendorId) && eqi(d.match.productId, port.productId))
      return d
  for (const d of devices) if (d.match.path && d.match.path === port.path) return d
  return undefined
}

/** Stable lock key for a port — the same physical adapter across reboots. */
export function deviceKey(port: PortLike): string {
  if (port.serialNumber) return `sn:${port.serialNumber}`
  if (port.vendorId && port.productId) return `vp:${port.vendorId}:${port.productId}`
  if (port.pnpId) return `pnp:${port.pnpId}`
  return `path:${port.path}`
}

/** Build a starter devices.json from the currently attached ports. */
export function scaffold(ports: PortLike[]): { devices: Device[] } {
  return {
    devices: ports.map((p, i) => ({
      name: `proto-${String.fromCharCode(65 + (i % 26))}`,
      model: p.manufacturer ?? "UNKNOWN",
      match: p.serialNumber
        ? { serialNumber: p.serialNumber }
        : p.vendorId && p.productId
          ? { vendorId: p.vendorId, productId: p.productId }
          : { path: p.path },
      baudRate: 115200,
      notes: `auto-scaffolded from ${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ""}`,
    })),
  }
}
