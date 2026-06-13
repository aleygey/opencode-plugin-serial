/**
 * opencode-plugin-serial — entry point.
 *
 * Standalone plugin (no opencode core changes). Loaded by opencode via the
 * plugin mechanism; opencode supplies the real host implementations for the
 * types vendored in ./vendor/opencode.
 *
 *   - registers the serial_* tools via the `tool` hook
 *   - stands up a self-hosted /serial REST + WebSocket server so a monitor can
 *     watch the same sessions the agent drives (port written to api.json)
 *
 * NOTE: the live TUI monitor (sidebar block, app_bottom status bar, /serial
 * full-screen view) ships as a SEPARATE module (./tui → src/tui/monitor.tsx)
 * and is loaded by opencode's TUI plugin loader, which reads `tui.json` — NOT
 * opencode.json. To get the UI you must list this plugin in BOTH configs. See
 * INSTALL.md.
 *
 * Mirrors the shape of opencode-plugin-exp: `export default { id, server }`.
 */

import type { Plugin } from "./vendor/opencode"
import { serialTools } from "./tools"
import { Serial } from "./service"
import { baseDir } from "./paths"
import { startSerialServer } from "./server"
import { registerToWinConsole, type WinConsoleClient } from "./winhost"

// Tear down all sessions (close ports, clear timers, drop subscribers) when the
// host process exits. Registered once at module scope.
let winClient: WinConsoleClient | undefined
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    try {
      winClient?.stop()
    } catch {}
    Serial.disposeAll()
  })
}

export const SerialPlugin: Plugin = async (input, options) => {
  const opts = (options ?? {}) as Record<string, unknown>
  if (opts["enabled"] === false) return {}

  // Resolve the base dir (api.json / device map / lock files live here) and
  // configure the service BEFORE anything else, so device-map matching and
  // device leases work even when the /serial server is disabled.
  const base = baseDir({
    worktree: input.worktree,
    directory: typeof opts["directory"] === "string" ? (opts["directory"] as string) : undefined,
  })
  try {
    Serial.configure({ base })
  } catch {
    // headless fallback — tools still work, just no device map / locks
  }

  // Self-hosted /serial server for monitors. A failed bind must never break the
  // tools — fall back to headless (tools still work, just no live monitor).
  if (opts["server"] !== false) {
    try {
      const server = startSerialServer({
        base,
        port: typeof opts["port"] === "number" ? (opts["port"] as number) : undefined,
      })

      // Optional: register with win-console (super-work-host) so its panel
      // (ports / sessions / leases / device map) shows up there. Opt-in via the
      // `winConsole` URL option; loopback-only per the daemon's SSRF guard.
      const winUrl = typeof opts["winConsole"] === "string" ? (opts["winConsole"] as string) : undefined
      if (winUrl && server.port) {
        try {
          winClient = registerToWinConsole({
            url: winUrl,
            token: typeof opts["winConsoleToken"] === "string" ? (opts["winConsoleToken"] as string) : undefined,
            apiBaseUrl: `http://127.0.0.1:${server.port}`,
            panelUrl: `http://127.0.0.1:${server.port}/serial/panel`,
          })
        } catch {
          // win-console not running / unreachable — panel just won't appear
        }
      }
    } catch {
      // headless fallback
    }
  }

  // Auto-open devices flagged `autoOpen` in devices.json (fire-and-forget) so
  // /serial shows them without waiting for the agent to serial_create.
  void Serial.autoOpenConfigured()

  return { tool: serialTools }
}

// opencode loads a v1 plugin from `export default { server }`. The named export
// stays for tests / direct import.
export default { id: "serial", server: SerialPlugin }
