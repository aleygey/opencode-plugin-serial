/**
 * Self-hosted /serial server — REST + WebSocket, served by Bun.serve.
 *
 * Ports the in-core `server/routes/instance/serial.ts` (9 endpoints + the
 * `/serial/:id/connect` WebSocket) onto a tiny standalone Hono app, so the
 * plugin needs no `routes` hook and changes nothing in opencode core. A
 * monitor (TUI panel or web view) reads `api.json` to find the port, then
 * attaches to `/serial/:id/connect?cursor=N` to watch the same byte stream the
 * agent drives — with ring-buffer replay from `cursor`.
 */

import { Hono } from "hono"
import { mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Serial } from "./service"
import { SerialID } from "./schema"
import { apiInfoFile } from "./paths"

export type SerialServer = { port: number; stop(): void }

type WsData = {
  id: string
  cursor?: number
  handler?: { onMessage: (m: string | ArrayBuffer) => void; onClose: () => void }
}

export function startSerialServer(opts: { base: string; port?: number }): SerialServer {
  const app = new Hono()

  app.get("/serial", async (c) => c.json(await Serial.list()))
  app.get("/serial/ports", async (c) => c.json(await Serial.listPorts()))
  app.post("/serial", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await Serial.create(Serial.CreateInput.parse(body)))
  })
  app.get("/serial/:id", async (c) => {
    const info = await Serial.get(SerialID.zod.parse(c.req.param("id")))
    if (!info) return c.json({ error: "Session not found" }, 404)
    return c.json(info)
  })
  app.put("/serial/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await Serial.update(SerialID.zod.parse(c.req.param("id")), Serial.UpdateInput.parse(body)))
  })
  app.delete("/serial/:id", async (c) => {
    await Serial.remove(SerialID.zod.parse(c.req.param("id")))
    return c.json(true)
  })
  app.post("/serial/:id/write", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { data?: string }
    await Serial.write(SerialID.zod.parse(c.req.param("id")), String(body.data ?? ""))
    return c.json(true)
  })

  const server = Bun.serve<WsData>({
    port: opts.port ?? 0, // 0 → OS picks a free port
    fetch(req, srv) {
      const url = new URL(req.url)
      const m = url.pathname.match(/^\/serial\/([^/]+)\/connect$/)
      if (m && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        const cursorRaw = url.searchParams.get("cursor")
        let cursor: number | undefined
        if (cursorRaw != null) {
          const n = Number(cursorRaw)
          if (Number.isSafeInteger(n) && n >= -1) cursor = n
        }
        const ok = srv.upgrade(req, { data: { id: m[1]!, cursor } })
        return ok ? undefined : new Response("upgrade failed", { status: 400 })
      }
      return app.fetch(req)
    },
    websocket: {
      async open(ws) {
        try {
          const id = SerialID.zod.parse(ws.data.id)
          const handler = await Serial.connect(id, ws as unknown as Serial.Socket, ws.data.cursor)
          if (!handler) {
            ws.close()
            return
          }
          ws.data.handler = handler
        } catch {
          ws.close()
        }
      },
      message(ws, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message as Uint8Array)
        ws.data.handler?.onMessage(text)
      },
      close(ws) {
        ws.data.handler?.onClose()
      },
    },
  })

  // Discovery files (best-effort). The monitor reads api.json to find the port.
  // We write it BOTH under the server's base (worktree-local) AND under a
  // home-global location, because the TUI process's cwd often differs from the
  // server's worktree — the home copy makes discovery work regardless of cwd
  // (and regardless of platform: os.homedir() is correct on Windows where
  // process.env.HOME is unset). See monitor.tsx readServerBase().
  const payload = JSON.stringify({ url: `http://127.0.0.1:${server.port}`, port: server.port, pid: process.pid }, null, 2)
  const targets = [opts.base, path.join(os.homedir(), ".opencode", "serial")]
  for (const dir of targets) {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(apiInfoFile(dir), payload)
    } catch {
      // best-effort — the server still runs without the discovery file
    }
  }

  return { port: server.port ?? 0, stop: () => server.stop(true) }
}
