import express from '../runtime/express.js';
import { config } from '../config.js';
import { BRIDGE_VERSION, EXTENSION_COMPATIBILITY } from '../extensionCompatibility.js';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setupPage() {
  const extensionVersion = EXTENSION_COMPATIBILITY.recommendedExtensionVersion;
  const serverUrl = escapeHtml(config.publicBaseUrl);
  const bridgeToken = escapeHtml(config.bridgeToken);
  const extensionZipUrl = `${config.publicBaseUrl}/extensions/chrome-bridge-extension.zip`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGPT Bridge Setup</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--blue:#2563eb;--ok:#15803d;--warn:#a16207;--okbg:#f0fdf4;--warnbg:#fffbeb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:920px;margin:0 auto;padding:42px 22px 64px}h1{margin:0 0 8px;font-size:34px}.lead{margin:0 0 24px;color:var(--muted)}.grid{display:grid;gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}.card h2{margin:0 0 10px;font-size:18px}.step{display:inline-grid;place-items:center;width:26px;height:26px;margin-right:8px;border-radius:8px;background:#dbeafe;color:#1d4ed8;font-size:13px}.button{display:inline-block;padding:9px 13px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);font-weight:700;text-decoration:none;cursor:pointer}.button.primary{background:var(--blue);border-color:var(--blue);color:#fff}.row{display:flex;gap:8px;margin:8px 0}.row input{flex:1;min-width:0;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.notice{margin:14px 0 0;padding:12px 14px;border-radius:12px;background:var(--warnbg);color:var(--warn);font-weight:650}.status{padding:12px 14px;border-radius:12px;background:var(--warnbg);color:var(--warn)}.status.ok{background:var(--okbg);color:var(--ok)}ol{margin:8px 0 0;padding-left:24px}li{margin:7px 0}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media(prefers-color-scheme:dark){:root{--bg:#0f0f10;--card:#18181b;--text:#f4f4f5;--muted:#a1a1aa;--line:#3f3f46;--okbg:#10251a;--warnbg:#2b2411}}
</style>
</head>
<body><main class="shell">
<h1>Connect ChatGPT Bridge</h1>
<p class="lead">This bridge stays on your PC and connects to a normal logged-in ChatGPT browser tab.</p>
<div class="grid">
<section class="card">
<h2><span class="step">1</span>Install or reload the extension</h2>
<ol>
<li>Open <code>chrome://extensions</code> and enable <b>Developer mode</b>.</li>
<li>Load <code>tools/chrome-bridge-extension</code> as an unpacked extension, or click <b>Reload</b> if it is already installed.</li>
<li>Open a normal conversation at <b>chatgpt.com</b> and <b>refresh that ChatGPT tab after the extension is loaded</b>.</li>
</ol>
<p><a class="button" href="${extensionZipUrl}">Download extension ${escapeHtml(extensionVersion)}</a></p>
</section>
<section class="card">
<h2><span class="step">2</span>Copy the local connection details</h2>
<label>Local bridge URL</label><div class="row"><input id="url" readonly value="${serverUrl}"><button class="button" onclick="copyField('url')">Copy</button></div>
<label>Bridge token</label><div class="row"><input id="token" readonly type="password" value="${bridgeToken}"><button class="button" onclick="copyField('token')">Copy</button></div>
<div class="notice">Important: the Chrome extension does <b>not</b> open a normal toolbar popup. After refreshing a ChatGPT conversation, look on the <b>right edge near the bottom</b> of the ChatGPT page for the small <b>B / Bridge</b> button. Click that in-page button and paste the URL and Bridge token there.</div>
</section>
<section class="card">
<h2><span class="step">3</span>Connect and verify</h2>
<ol>
<li>Open or return to a normal <b>chatgpt.com</b> conversation.</li>
<li>Refresh the page if the <b>B / Bridge</b> control is not visible.</li>
<li>Click the floating <b>B / Bridge</b> button on the right side of the ChatGPT page.</li>
<li>Paste the local bridge URL and <b>Bridge token</b>, then connect/save.</li>
<li>Return here. The status below updates automatically.</li>
</ol>
<div id="status" class="status">Waiting for a connected ChatGPT tab…</div>
<p><a class="button primary" href="https://chatgpt.com/" target="_blank" rel="noreferrer">Open ChatGPT</a> <a class="button" href="/diagnostics">Diagnostics</a></p>
</section>
</div>
<p style="color:var(--muted);font-size:12px">Bridge ${escapeHtml(BRIDGE_VERSION)} · Extension ${escapeHtml(extensionVersion)}</p>
</main>
<script>
async function copyField(id){const el=document.getElementById(id);await navigator.clipboard.writeText(el.value)}
async function refreshStatus(){const node=document.getElementById('status');try{const r=await fetch('/setup/status',{cache:'no-store'});const d=await r.json();if(d.activeClient){node.className='status ok';node.textContent='Connected and ready: '+(d.activeClient.title||d.activeClient.id||'ChatGPT tab');}else{node.className='status';node.textContent=d.error||'Waiting for a connected ChatGPT tab…';}}catch(e){node.className='status';node.textContent='Bridge status unavailable: '+String(e.message||e)}}
refreshStatus();setInterval(refreshStatus,3000);
</script>
</body></html>`;
}

export function createSetupGuideRouter(bridge) {
  const router = express.Router();
  router.get('/setup', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) {
        res.status(403).json({ detail: 'Setup page is only available from localhost' });
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(setupPage());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
