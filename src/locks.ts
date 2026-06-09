/**
 * LockManager — advisory device lease so only ONE agent (session) controls a
 * physical prototype at a time, while any number may observe (read) it.
 *
 * Two layers, both keyed by a stable `deviceKey` (USB serialNumber, or
 * vendorId:productId, or path as a last resort — see devices.deviceKey):
 *
 *   - in-process Map   → fast path; handles multiple sessions / subagents
 *                        inside ONE opencode process (where the service's
 *                        one-session-per-path REUSE would otherwise let two
 *                        agents interleave writes on a shared session).
 *   - lockfile on disk → cross-process coordination on the same workstation,
 *                        so a second opencode process gets a friendly "locked
 *                        by session X (pid Y)" instead of a raw EBUSY, and so a
 *                        crashed owner's lease auto-expires (TTL + heartbeat).
 *
 * The lease is advisory: the OS already enforces single-process-exclusive open
 * of a device path. This adds (a) intra-process mutual exclusion and (b) human-
 * readable ownership + crash recovery.
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import path from "node:path"

export type Lease = {
  deviceKey: string
  owner: string // opencode sessionID
  pid: number
  acquiredAt: number
  heartbeat: number
  ttlMs: number
}

export class LockManager {
  private dir: string
  private mem = new Map<string, Lease>()

  constructor(base: string) {
    this.dir = path.join(base, "locks")
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // best-effort; in-process map still works without the lock dir
    }
  }

  private file(key: string): string {
    return path.join(this.dir, key.replace(/[^\w.-]/g, "_") + ".lock")
  }

  private disk(key: string): Lease | undefined {
    try {
      return JSON.parse(readFileSync(this.file(key), "utf8")) as Lease
    } catch {
      return undefined
    }
  }

  private fresh(l: Lease, now: number): boolean {
    return now - l.heartbeat < l.ttlMs
  }

  /**
   * Try to acquire (or refresh) the lease for `owner`. Returns the CURRENT
   * holder when the device is locked by a different, still-alive owner (and
   * `takeover` is not set) — i.e. acquisition FAILED. Returns undefined on
   * success (acquired / refreshed / stale-lease stolen).
   */
  acquire(key: string, owner: string, opts?: { ttlMs?: number; takeover?: boolean }): Lease | undefined {
    const now = Date.now()
    const ttlMs = opts?.ttlMs ?? 60_000
    const current = this.mem.get(key) ?? this.disk(key)
    if (current && current.owner !== owner && this.fresh(current, now) && !opts?.takeover) {
      return current // locked by a live, different owner
    }
    const lease: Lease = { deviceKey: key, owner, pid: process.pid, acquiredAt: now, heartbeat: now, ttlMs }
    this.mem.set(key, lease)
    try {
      writeFileSync(this.file(key), JSON.stringify(lease))
    } catch {
      // best-effort cross-process layer
    }
    return undefined
  }

  /** Is `owner` allowed to write to `key`? */
  check(key: string, owner: string): { ok: boolean; holder?: Lease } {
    const now = Date.now()
    const l = this.mem.get(key) ?? this.disk(key)
    if (!l || !this.fresh(l, now) || l.owner === owner) return { ok: true }
    return { ok: false, holder: l }
  }

  /** Renew the heartbeat so the lease doesn't expire while the session is open. */
  renew(key: string, owner: string): void {
    const l = this.mem.get(key)
    if (l && l.owner === owner) {
      l.heartbeat = Date.now()
      try {
        writeFileSync(this.file(key), JSON.stringify(l))
      } catch {
        // ignore
      }
    }
  }

  release(key: string, owner: string): void {
    const l = this.mem.get(key)
    if (l && l.owner === owner) {
      this.mem.delete(key)
      try {
        unlinkSync(this.file(key))
      } catch {
        // already gone
      }
    }
  }
}
