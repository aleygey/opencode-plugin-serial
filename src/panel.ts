/**
 * win-console panel page — served at GET /serial/panel and embedded by
 * super-work-host as an iframe (registered via the ExternalManifest panel.url).
 *
 * Self-contained HTML + vanilla JS, no build step, no external assets. It talks
 * to THIS plugin's own /serial REST server (same origin, since the iframe is
 * loaded from http://127.0.0.1:<port>/serial/panel):
 *   - GET  /serial/ports    annotated ports (path / device name / model / in-use)
 *   - GET  /serial          open sessions (with owner = current driver)
 *   - GET  /serial/leases   device leases (owner sessionID, pid, stale?)
 *   - GET  /serial/devices  the devices.json device map
 *   - PUT  /serial/devices  overwrite devices.json  { devices: [...] }
 *   - DELETE /serial/leases/:deviceKey   force-release a stale/abandoned lease
 *
 * Read-only tables (ports / sessions+leases) auto-refresh every 2s; the device
 * map is editable as JSON (robust for the nested structure) with Save / Reload.
 * Theme adapts to prefers-color-scheme so it reads in either win-console theme.
 */

export function panelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Serial / 串口</title>
<style>
  :root { color-scheme: light dark; --fg:#1c1c1c; --muted:#6b7280; --bg:#ffffff; --panel:#f5f5f7; --border:#e2e2e6; --ok:#16a34a; --warn:#d97706; --err:#dc2626; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6e6e6; --muted:#9aa0a6; --bg:#16181d; --panel:#1f2229; --border:#2c2f37; --border:#2c2f37; } }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--fg); background:var(--bg); padding:12px; }
  h2 { font-size:13px; margin:16px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  table { width:100%; border-collapse:collapse; margin-bottom:4px; }
  th,td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--border); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px; }
  th { color:var(--muted); font-weight:600; }
  tr:hover td { background:var(--panel); }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .ok{background:var(--ok)} .warn{background:var(--warn)} .err{background:var(--err)} .muted{background:var(--muted)}
  .pill { font-size:11px; padding:1px 6px; border:1px solid var(--border); border-radius:999px; color:var(--muted); }
  button { font:inherit; padding:4px 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.danger:hover { border-color:var(--err); color:var(--err); }
  textarea { width:100%; min-height:220px; font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:8px; resize:vertical; }
  .row { display:flex; gap:8px; align-items:center; margin:6px 0; flex-wrap:wrap; }
  .status { color:var(--muted); font-size:12px; }
  .err-text { color:var(--err); }
  .ok-text { color:var(--ok); }
  .warn-text { color:var(--warn); }
  .empty { color:var(--muted); padding:6px 8px; }
</style>
</head>
<body>
  <div class="row"><strong>Serial / 串口</strong><span class="pill" id="conn">connecting…</span></div>

  <h2>Ports（物理串口）</h2>
  <table id="ports"><thead><tr><th>path</th><th>device</th><th>model</th><th>vid:pid</th><th>serial#</th><th>state</th></tr></thead><tbody><tr><td class="empty" colspan="6">…</td></tr></tbody></table>

  <h2>Sessions & leases（会话 / 谁在开车）</h2>
  <table id="sessions"><thead><tr><th>title</th><th>path</th><th>baud</th><th>status</th><th>driver (owner)</th><th></th></tr></thead><tbody><tr><td class="empty" colspan="6">…</td></tr></tbody></table>

  <h2>Device map（devices.json，可编辑）</h2>
  <div class="row">
    <button id="reload">Reload</button>
    <button id="save">Save</button>
    <button id="scaffold" title="生成当前所有口的起始条目">Scaffold from ports</button>
    <span class="status" id="devstatus"></span>
  </div>
  <textarea id="devices" spellcheck="false"></textarea>

<script>
const $ = (s) => document.querySelector(s)
const esc = (v) => (v == null ? "" : String(v)).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]))
async function jget(u){ const r = await fetch(u); if(!r.ok) throw new Error(u+" "+r.status); return r.json() }

function dotFor(status){ return status==="connected"?"ok":status==="error"?"err":"muted" }

async function refresh(){
  try {
    const [ports, sessions, leases] = await Promise.all([ jget("/serial/ports"), jget("/serial"), jget("/serial/leases") ])
    $("#conn").textContent = "connected · " + new Date().toLocaleTimeString()
    $("#conn").className = "pill"
    // ports
    const pb = $("#ports tbody")
    pb.innerHTML = ports.length ? ports.map(p =>
      "<tr><td>"+esc(p.path)+"</td><td>"+esc(p.deviceName||"")+"</td><td>"+esc(p.model||"")+"</td><td>"+
      esc([p.vendorId,p.productId].filter(Boolean).join(":"))+"</td><td>"+esc(p.serialNumber||"")+"</td><td>"+
      (p.inUse?'<span class="pill">in use</span>':'<span class="pill">free</span>')+"</td></tr>"
    ).join("") : '<tr><td class="empty" colspan="6">no ports</td></tr>'
    // sessions + leases (match lease by owner)
    const sb = $("#sessions tbody")
    sb.innerHTML = sessions.length ? sessions.map(s => {
      const lease = leases.find(l => l.owner && l.owner === s.owner)
      const stale = lease && lease.stale
      const driver = s.owner ? ('agent '+String(s.owner).slice(0,12)+(stale?' <span class="pill warn-text">stale</span>':'')) : '<span class="muted">— (free)</span>'
      const kick = lease ? '<button class="danger" data-key="'+esc(lease.deviceKey)+'">force release</button>' : ''
      return "<tr><td><span class='dot "+dotFor(s.status)+"'></span>"+esc(s.title)+"</td><td>"+esc(s.path)+"</td><td>"+
        esc(s.baudRate)+"</td><td>"+esc(s.status)+"</td><td>"+driver+"</td><td>"+kick+"</td></tr>"
    }).join("") : '<tr><td class="empty" colspan="6">no open sessions — ask the agent to serial_create, or set autoOpen in the device map</td></tr>'
    sb.querySelectorAll("button[data-key]").forEach(btn => btn.onclick = async () => {
      if(!confirm("Force-release this device lease? (Advisory — the current agent re-acquires on its next write unless another agent grabs it first.)")) return
      try { const r = await fetch("/serial/leases/"+encodeURIComponent(btn.dataset.key), { method:"DELETE" }); if(!r.ok) throw new Error("HTTP "+r.status) }
      catch(e){ /* surfaced via the disconnected pill on next refresh */ }
      finally { refresh() }
    })
  } catch (e) {
    $("#conn").textContent = "disconnected"
    $("#conn").className = "pill err-text"
  }
}

let devLoaded = false
async function loadDevices(){
  try {
    const d = await jget("/serial/devices")
    $("#devices").value = JSON.stringify({ devices: d }, null, 2)
    $("#devstatus").textContent = (d.length||0)+" device(s) loaded"
    $("#devstatus").className = "status"
    devLoaded = true
  } catch (e) { $("#devstatus").textContent = "load failed: "+e.message; $("#devstatus").className="status err-text" }
}
$("#reload").onclick = loadDevices
$("#save").onclick = async () => {
  let parsed
  try { parsed = JSON.parse($("#devices").value) } catch (e) { $("#devstatus").textContent = "invalid JSON: "+e.message; $("#devstatus").className="status err-text"; return }
  const list = Array.isArray(parsed) ? parsed : parsed.devices
  if (!Array.isArray(list)) { $("#devstatus").textContent = 'expected { "devices": [ ... ] }'; $("#devstatus").className="status err-text"; return }
  const r = await fetch("/serial/devices", { method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({ devices: list }) })
  const j = await r.json().catch(()=>({}))
  $("#devstatus").textContent = j.ok ? ("saved "+list.length+" device(s) → "+(j.from||"")) : ("save failed"+(j.from?" ("+j.from+")":""))
  $("#devstatus").className = j.ok ? "status ok-text" : "status err-text"
}
$("#scaffold").onclick = async () => {
  try {
    const ports = await jget("/serial/ports")
    const existing = (() => { try { const p = JSON.parse($("#devices").value); return Array.isArray(p)?p:(p.devices||[]) } catch { return [] } })()
    const have = new Set(existing.map(d => d && d.match && d.match.path).filter(Boolean))
    let n = existing.length
    for (const p of ports) {
      if (have.has(p.path)) continue
      existing.push({ name: "proto-"+String.fromCharCode(65+(n%26)), model: p.model||p.manufacturer||"UNKNOWN",
        match: p.serialNumber ? { serialNumber:p.serialNumber, path:p.path } : { path:p.path },
        baudRate: p.suggestedBaud||115200, eol:"crlf", autoOpen:false })
      n++
    }
    $("#devices").value = JSON.stringify({ devices: existing }, null, 2)
    $("#devstatus").textContent = "scaffolded — review then Save"
    $("#devstatus").className = "status"
  } catch (e) { $("#devstatus").textContent = "scaffold failed: "+e.message; $("#devstatus").className="status err-text" }
}

loadDevices()
refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`
}
