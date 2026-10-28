import qrcode from "qrcode-generator";
import { randomId } from "../shared/bytes";
import { SERVER_VERSION } from "../shared/protocol/version";

// Server-rendered setup pages. No external assets; inline script guarded by a CSP nonce.

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1f1f1f;--muted:#666;--card:#fff;--line:#e4e4e2;--accent:#6e56cf;--ok:#2f7d46;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ececec;--muted:#a0a0a0;--card:#1f1f1f;--line:#333;--accent:#9e8cf0;--ok:#5fbf7a;--warn:#f0a35e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:620px;margin:0 auto;padding:40px 16px}h1{font-size:1.6rem;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:18px}
label{display:block;font-weight:600;margin:14px 0 6px}input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button,.btn{display:inline-block;margin-top:18px;padding:10px 18px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.code{font:600 1.35rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;padding:12px;border:1px dashed var(--line);border-radius:8px;text-align:center;user-select:all;word-break:break-all}
.qr{display:flex;justify-content:center;margin:12px 0}.qr svg{width:220px;height:220px;background:#fff;padding:8px;border-radius:8px}
.err{color:#d93036;margin-top:12px}.muted{color:var(--muted);font-size:.92rem}.warn{color:var(--warn)}ol{padding-left:20px}
`;

function page(title: string, body: string, nonce: string, script = ""): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
		},
	});
}

export function qrSvg(text: string): string {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function claimPage(secretKind: "passphrase" | "log-code"): Response {
	const nonce = randomId(12);
	const secretHelp =
		secretKind === "passphrase"
			? "Enter the setup passphrase you chose when you deployed this server."
			: `No setup passphrase was set, so a one-time claim code was written to this Worker's logs. Open the Cloudflare dashboard → Workers → <em>relay-flare</em> → Logs (or run <code>wrangler tail</code>) and copy the code.`;
	const body = `<h1>Claim your Relay Flare server</h1><p class="sub">This makes you the owner. It can only be done once.</p>
<div class="card" id="form-card"><form id="claim">
<label for="secret">${secretKind === "passphrase" ? "Setup passphrase" : "Claim code"}</label><input id="secret" autocomplete="off" required>
<p class="muted">${secretHelp}</p>
<label for="owner">Your name</label><input id="owner" autocomplete="name" maxlength="60" required>
<p class="muted">Collaborators see this name next to your cursor.</p>
<button type="submit">Claim server</button><p class="err" id="err" hidden></p></form></div>
<div id="done" hidden></div>`;
	const script = `
const form=document.getElementById('claim'),err=document.getElementById('err');
form.addEventListener('submit',async e=>{e.preventDefault();err.hidden=true;
const r=await fetch('/v1/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:document.getElementById('secret').value,ownerName:document.getElementById('owner').value})});
const j=await r.json().catch(()=>({message:'Unexpected response'}));
if(!r.ok){err.textContent=j.message||'Claim failed';err.hidden=false;return}
document.getElementById('form-card').hidden=true;const d=document.getElementById('done');d.hidden=false;d.innerHTML=j.html;});`;
	return page("Claim Relay Flare", body, nonce, script);
}

/** Fragment shown after a successful claim (inserted by the claim page script). */
export function claimResultHtml(origin: string, pairingCode: string, recoveryCode: string): string {
	const pairUrl = `${origin}/pair#code=${encodeURIComponent(pairingCode)}`;
	const obsidianUrl = obsidianPairLink(origin, pairingCode);
	return `<div class="card"><h2>Connect your first device</h2>
<ol><li>Install <strong>Relay Flare</strong> in Obsidian (Settings → Community plugins).</li>
<li>On this computer: <a class="btn" href="${escapeHtml(obsidianUrl)}">Open in Obsidian</a></li>
<li>On a phone or tablet: scan this code with the camera.</li></ol>
<div class="qr">${qrSvg(pairUrl)}</div>
<p class="muted">Or paste this server address and pairing code into the plugin's settings. The code works once and expires in 10 minutes.</p>
<p class="code">${escapeHtml(origin)}</p><p class="code">${escapeHtml(pairingCode)}</p></div>
<div class="card"><h2>Save your recovery code</h2><p class="warn">Shown only once. If you lose every paired device, this code lets you pair a new one as the owner.</p>
<p class="code">${escapeHtml(recoveryCode)}</p></div>`;
}

export function obsidianPairLink(origin: string, code: string): string {
	return `obsidian://relay-flare?action=pair&server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
}

export function pairPage(origin: string): Response {
	const nonce = randomId(12);
	const body = `<h1>Pair a device</h1><p class="sub">Relay Flare server at ${escapeHtml(origin)}</p>
<div class="card"><p>Install <strong>Relay Flare</strong> in Obsidian on this device, then:</p>
<a class="btn" id="open" href="#">Open in Obsidian</a>
<p class="muted">If nothing happens, open the plugin settings and enter the server address and this pairing code:</p>
<p class="code">${escapeHtml(origin)}</p><p class="code" id="code"></p></div>`;
	const script = `const p=new URLSearchParams(location.hash.slice(1)),c=p.get('code')||'';document.getElementById('code').textContent=c;
document.getElementById('open').href='obsidian://relay-flare?action=pair&server='+encodeURIComponent(location.origin)+'&code='+encodeURIComponent(c);history.replaceState(null,'',location.pathname);`;
	return page("Pair a device", body, nonce, script);
}

export function statusPage(origin: string, attachments: boolean): Response {
	const nonce = randomId(12);
	const body = `<h1>Relay Flare</h1><p class="sub">This server is claimed and running (version ${SERVER_VERSION}).</p>
<div class="card"><p>Server address for the plugin:</p><p class="code">${escapeHtml(origin)}</p>
<p>Attachments (R2): <strong>${attachments ? "enabled" : "not configured"}</strong></p>
${attachments ? "" : `<p class="muted">Text sync works without R2. To sync images, PDFs and other attachments, add an R2 bucket binding named <code>BLOBS</code> (see the project's operations guide), then redeploy.</p>`}
<p class="muted">The server owner and anyone with admin access can read the content stored here.</p></div>`;
	return page("Relay Flare", body, nonce);
}
