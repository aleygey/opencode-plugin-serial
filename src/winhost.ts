/**
 * win-console (super-work-host) registration client.
 *
 * Registers this serial plugin as an EXTERNAL capability so its panel shows up
 * in the win-console (an iframe) and stays alive via heartbeat. The protocol
 * (super-work-host docs/plugin-platform.md):
 *   POST <url>/capabilities/register   { ...ExternalManifest }  -> { ok, token }
 *   POST <url>/capabilities/heartbeat  { id, token }            (keeps TTL warm)
 *   POST <url>/capabilities/unregister { id, token }            (on shutdown)
 * apiBaseUrl / panel.url MUST be loopback (127.0.0.1) — the daemon validates it.
 *
 * Best-effort and OPT-IN: only runs when a winConsole URL is configured. Any
 * failure is swallowed and retried on the next heartbeat tick; it never affects
 * the serial tools or the /serial server.
 */

export type WinConsoleOpts = {
  url: string
  token?: string
  apiBaseUrl: string
  panelUrl: string
}

export type WinConsoleClient = { stop(): void }

export function registerToWinConsole(o: WinConsoleOpts): WinConsoleClient {
  const base = o.url.replace(/\/$/, "")
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (o.token) headers["x-winhost-token"] = o.token

  const manifest = {
    id: "serial",
    title: "Serial / 串口",
    icon: "🔌",
    description: "Serial & telnet device monitor — ports, sessions, leases, and the device map",
    apiBaseUrl: o.apiBaseUrl,
    panel: { url: o.panelUrl, height: 520 },
    ttlSeconds: 60,
  }

  let token: string | undefined
  let stopped = false

  const register = async () => {
    try {
      const r = await fetch(`${base}/capabilities/register`, { method: "POST", headers, body: JSON.stringify(manifest) })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; token?: string }
      if (j.ok && typeof j.token === "string") token = j.token
    } catch {
      // daemon not up / unreachable — retried next tick
    }
  }

  const heartbeat = async () => {
    if (stopped) return
    if (!token) {
      await register()
      return
    }
    try {
      const r = await fetch(`${base}/capabilities/heartbeat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: manifest.id, token }),
      })
      if (!r.ok) token = undefined // expired / restarted daemon → re-register next tick
    } catch {
      // transient — keep token and retry
    }
  }

  void register()
  const timer = setInterval(() => void heartbeat(), 30_000)
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      if (token) {
        // Fire-and-forget; a rejected fetch (daemon already down) must not
        // become an unhandled rejection — the try/catch only guards a sync
        // throw, so attach a .catch too. TTL reaps it server-side regardless.
        try {
          void fetch(`${base}/capabilities/unregister`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: manifest.id, token }),
          }).catch(() => {})
        } catch {
          // best-effort
        }
      }
    },
  }
}
