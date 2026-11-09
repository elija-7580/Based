import Foundation

/// First web client (read-only), served by based-server at `/app` (moved from based-server into BasedBrain with BSD-34): pages through `GET /sync/v2/pull`, keeps the
/// records in the browser and renders the page tree and pages — the same data any Based client syncs
/// (docs/sync-protocol.md). A starting point for the full web / Windows / Linux client (docs/platforms.md).
///
/// BSD-35: every value from the workspace goes through `esc()` (also inside attributes), links only keep
/// http/https/mailto/based (`safeUrl`, same rule as `SafeURL` in BasedCore), the token lives in `sessionStorage`
/// unless "Keep me signed in" is ticked, and the page is served with a nonce CSP (`WebSecurity.page`).
enum WebApp {
    static let html = #"""
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Based</title>
<style>
:root { --bg:#ffffff; --side:#f7f7f5; --text:#37352f; --dim:#787774; --line:#e9e9e7; --hover:rgba(55,53,47,.06); --code:#f7f6f3; --accent:#2383e2; }
@media (prefers-color-scheme: dark) { :root { --bg:#191919; --side:#202020; --text:#d4d4d4; --dim:#9b9b9b; --line:#2f2f2f; --hover:rgba(255,255,255,.055); --code:#2a2a2a; } }
* { box-sizing: border-box; }
html, body, #root { margin:0; height:100%; background:var(--bg); color:var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
#app { display:flex; height:100%; }
aside { width:260px; flex:none; background:var(--side); border-right:1px solid var(--line); overflow:auto; padding:10px 8px; }
aside h1 { font-size:14px; margin:6px 8px 12px; font-weight:600; }
.row { display:flex; align-items:center; gap:6px; height:28px; padding:0 8px; border-radius:6px; font-size:14px; color:var(--dim); cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.row:hover { background:var(--hover); }
.row.on { background:var(--hover); color:var(--text); font-weight:500; }
.row .tw { width:16px; text-align:center; font-size:10px; flex:none; }
.kids { margin-left:14px; }
main { flex:1; overflow:auto; }
.page { max-width:708px; margin:0 auto; padding:80px 24px 160px; }
.cover { height:240px; background:linear-gradient(120deg,#a18cd1,#fbc2eb); }
.icon { font-size:64px; line-height:1; margin-bottom:8px; }
.title { font-size:40px; font-weight:700; margin:0 0 12px; line-height:1.2; }
.b { margin:2px 0; min-height:1.5em; }
h2.b { font-size:30px; margin-top:28px; } h3.b { font-size:24px; margin-top:22px; } h4.b { font-size:20px; margin-top:16px; } h5.b { font-size:17px; }
h2.b, h3.b, h4.b, h5.b { font-weight:600; line-height:1.3; margin-bottom:4px; }
ul.b, ol.b { margin:0; padding-left:24px; }
.todo { display:flex; gap:8px; align-items:flex-start; }
.todo input { margin-top:5px; accent-color:var(--accent); }
.todo.done span { color:var(--dim); text-decoration:line-through; }
blockquote.b { border-left:3px solid currentColor; padding-left:14px; margin:6px 0; }
.callout { display:flex; gap:10px; background:var(--code); border-radius:6px; padding:14px 16px; margin:6px 0; }
pre.b { background:var(--code); border-radius:6px; padding:16px; overflow:auto; font: 13.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background:var(--code); color:#eb5757; border-radius:4px; padding:0 4px; font-size:85%; }
hr.b { border:0; border-top:1px solid var(--line); margin:12px 0; }
table.db { border-collapse:collapse; width:100%; font-size:14px; } table.db th { text-align:left; font-weight:500; color:var(--dim); border-bottom:1px solid var(--line); padding:6px 8px; white-space:nowrap; }
table.db td { border-bottom:1px solid var(--line); padding:6px 8px; white-space:nowrap; max-width:260px; overflow:hidden; text-overflow:ellipsis; }
table.b { border-collapse:collapse; margin:8px 0; } table.b td { border:1px solid var(--line); padding:6px 10px; font-size:14px; }
details.b > summary { cursor:pointer; }
[contenteditable]:focus { outline:none; }
.pagelink { cursor:pointer; text-decoration:underline; text-decoration-color:var(--line); }
.muted { color:var(--dim); font-size:14px; }
#login { max-width:420px; margin:18vh auto; padding:24px; }
#login input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:15px; margin:8px 0; }
#login button { padding:9px 16px; border:0; border-radius:8px; background:var(--text); color:var(--bg); font-weight:600; cursor:pointer; }
</style>
</head>
<body>
<div id="root"></div>
<script>
// BSD-35: the token stays in this tab (sessionStorage); localStorage only after "Keep me signed in".
const Tok = {
  get() { try { return sessionStorage.getItem("based.token") || localStorage.getItem("based.token") || ""; } catch (e) { return ""; } },
  set(t, keep) {
    try { sessionStorage.setItem("based.token", t); if (keep) localStorage.setItem("based.token", t); else localStorage.removeItem("based.token"); } catch (e) {}
  },
  kept() { try { return !!localStorage.getItem("based.token"); } catch (e) { return false; } },
};
const S = { token: Tok.get(), recs: new Map(), kids: new Map(), current: null, open: new Set(), me: null };
// Shared links (/s/<secret>): the secret is the credential; it isn't stored.
if (location.pathname.startsWith("/s/")) { S.token = location.pathname.slice(3); S.link = true; }
const $ = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
// Links keep only http, https, mailto, based (and relative references); everything else becomes "#".
function safeUrl(u, img) {
  const t = String(u ?? "").trim();
  let scheme = "";
  for (const ch of t) {
    if (ch <= " " || ch === "\x7f") continue;   // browsers ignore these inside a scheme ("java\tscript:")
    if (ch === ":") {
      if (!scheme) return t;
      scheme = scheme.toLowerCase();
      if (["http", "https", "mailto", "based"].includes(scheme)) return t;
      if (img && scheme === "data" && /^data:image\//i.test(t) && !/^data:image\/svg/i.test(t)) return t;
      return "#";
    }
    if (ch === "/" || ch === "?" || ch === "#" || !/[A-Za-z0-9+.\-]/.test(ch)) return t;   // relative reference
    scheme += ch;
  }
  return t;
}

function runs(t) { if (t == null) return []; if (typeof t === "string") return [{ t }]; return t; }
function plain(t) { return runs(t).map(r => r.t || "").join(""); }
function rich(t) {
  return runs(t).map(r => {
    let h = esc(r.t || "").replace(/\n/g, "<br>");
    const m = r.m || {};
    if (r.mention && r.mention.page) { const id = r.mention.page; return `<span class="pagelink" data-open="${esc(id)}">${esc(title(id))}</span>`; }
    if (m.c) h = `<code>${h}</code>`;
    if (m.b) h = `<b>${h}</b>`; if (m.i) h = `<i>${h}</i>`; if (m.u) h = `<u>${h}</u>`; if (m.s) h = `<s>${h}</s>`;
    if (m.link) h = `<a href="${esc(safeUrl(m.link))}" target="_blank" rel="noopener noreferrer">${h}</a>`;
    return h;
  }).join("");
}
function block(id) { return S.recs.get("block:" + id); }
function title(id) { const b = block(id); return (b && plain(b.text)) || "Untitled"; }
function icon(b) { const i = b && b.props && b.props.icon; return i && typeof i.emoji === "string" ? esc([...i.emoji].slice(0, 8).join("")) : ""; }
function children(key) { return (S.kids.get(key) || []).map(block).filter(b => b && !b.trashedAt); }

function index() {
  S.kids = new Map();
  for (const [k, r] of S.recs) {
    if (!k.startsWith("block:")) continue;
    const list = S.kids.get(r.parent) || []; list.push(r.id); S.kids.set(r.parent, list);
  }
  for (const [p, list] of S.kids) {
    list.sort((a, b) => { const x = block(a), y = block(b); return x.sk < y.sk ? -1 : x.sk > y.sk ? 1 : (a < b ? -1 : 1); });
  }
}

async function api(path) {
  const r = await fetch(path, { headers: { Authorization: "Bearer " + S.token } });
  if (r.status === 401) throw new Error("Wrong token");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

S.after = 0;
// Who is this (owner / invited person / link) and which pages can they see?
async function whoami() {
  try { S.me = await api("/share/v1/me"); } catch (e) { if (/token/.test(e.message)) throw e; S.me = { kind: "owner", pages: [] }; }
  if (S.me.kind !== "owner" && S.after === 0) {
    const snap = await api("/share/v1/snapshot");
    for (const r of snap.records) S.recs.set(r.kind + ":" + r.data.id, r.data);
    S.after = snap.next; index();
  }
}
const owner = () => !S.me || S.me.kind === "owner";
// Role on a block: the role of the closest shared page above it.
function roleOf(id) {
  if (owner()) return "full";
  const roles = Object.fromEntries((S.me.pages || []).map(p => [p.id, p.role]));
  let b = block(id);
  while (b) { if (roles[b.id]) return roles[b.id]; if (!b.parent || !b.parent.startsWith("b:")) break; b = block(b.parent.slice(2)); }
  return null;
}
const canEdit = (id) => ["edit", "full"].includes(roleOf(id));

async function sync(status) {
  let after = S.after, n = 0;
  for (;;) {
    const page = await api(`/sync/v2/pull?after=${after}&limit=2000`);
    for (const r of page.records) { S.recs.set(r.kind + ":" + r.data.id, r.data); n++; }
    for (const d of page.deletions) S.recs.delete(d.kind + ":" + d.id);
    after = page.next;
    if (status) status(`Loading… ${n} records`);
    if (!page.more) break;
  }
  S.after = after;
  index();
}

// Live: wait for server changes (long poll), pull them and re-render — edits from other devices appear within ~1 s.
async function live() {
  for (;;) {
    try {
      const r = await api(`/sync/v2/wait?after=${S.after}&timeout=25`);
      if (r.seq > S.after) {
        await sync(); tree();
        const editing = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.edit;
        if (S.current && !editing) showPage(S.current, true);
      }
    } catch (e) { await new Promise(res => setTimeout(res, 5000)); }
  }
}

function login(msg) {
  const root = document.getElementById("root");
  root.innerHTML = "";
  const box = $(`<div id="login"><h2>Based</h2><p class="muted">Server token (BASED_TOKEN). It stays in this tab unless you keep it.</p>
    <input id="tok" type="password" placeholder="Token" value="${esc(S.token)}">
    <label class="muted" style="display:block;margin:4px 0 10px"><input id="keep" type="checkbox" style="width:auto;margin:0 6px 0 0" ${Tok.kept() ? "checked" : ""}>Keep me signed in on this device</label>
    <button id="go">Open workspace</button>
    <p class="muted" id="msg">${esc(msg || "")}</p></div>`);
  root.appendChild(box);
  box.querySelector("#go").onclick = async () => {
    S.token = box.querySelector("#tok").value.trim();
    try { await whoami(); await sync(t => box.querySelector("#msg").textContent = t); Tok.set(S.token, box.querySelector("#keep").checked); shell(); }
    catch (e) { box.querySelector("#msg").textContent = e.message; }
  };
}

function shell() {
  const root = document.getElementById("root");
  root.innerHTML = "";
  const app = $(`<div id="app"><aside><h1></h1><div id="tree"></div></aside><main id="main"></main></div>`);
  root.appendChild(app);
  const ws = [...S.recs.entries()].find(([k]) => k.startsWith("workspace:"));
  app.querySelector("aside h1").textContent = owner() ? ((ws && ws[1].name) || "Workspace") : "Shared with " + (S.me.kind === "link" ? "you" : S.me.name);
  tree();
  const first = owner() ? children("w").find(b => b.type === "page") : block((S.me.pages[0] || {}).id);
  showPage(location.hash.slice(1) || (ws && ws[1].homePageID) || (first && first.id));
  live();
  window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id && id !== S.current) showPage(id); });
}

function tree() {
  const el = document.getElementById("tree"); el.innerHTML = "";
  const add = (parentKey, container) => {
    for (const b of children(parentKey)) {
      if (b.type !== "page" && b.type !== "databasePage") continue;
      const sub = children("b:" + b.id).some(c => c.type === "page" || c.type === "databasePage");
      const row = $(`<div class="row${S.current === b.id ? " on" : ""}"><span class="tw">${sub ? (S.open.has(b.id) ? "▾" : "▸") : ""}</span>${icon(b) || "📄"} <span>${esc(title(b.id))}</span></div>`);
      row.querySelector(".tw").onclick = (e) => { e.stopPropagation(); S.open.has(b.id) ? S.open.delete(b.id) : S.open.add(b.id); tree(); };
      row.onclick = () => { showPage(b.id); history.pushState(null, "", "#" + b.id); };
      container.appendChild(row);
      if (sub && S.open.has(b.id)) { const k = $(`<div class="kids"></div>`); container.appendChild(k); add("b:" + b.id, k); }
    }
  };
  if (owner()) add("w", el);
  else {
    // Shared roots instead of the workspace top level.
    for (const p of S.me.pages) {
      const b = block(p.id); if (!b) continue;
      const row = $(`<div class="row${S.current === b.id ? " on" : ""}"><span class="tw"></span>${icon(b) || "📄"} <span>${esc(title(b.id))}</span><span class="muted" style="margin-left:auto;font-size:11px">${p.role === "view" || p.role === "comment" ? "view" : "edit"}</span></div>`);
      row.onclick = () => { showPage(b.id); history.pushState(null, "", "#" + b.id); };
      el.appendChild(row);
      const k = $(`<div class="kids"></div>`); el.appendChild(k); add("b:" + b.id, k);
    }
  }
}

// Renders a list of sibling blocks; consecutive numbered items count up (1., 2., 3. …).
function seq(list) {
  let n = 0;
  return list.map(b => { n = b.type === "numberedList" ? n + 1 : 0; return render(b, n); }).join("");
}

function render(b, number) {
  const k = "b:" + b.id;
  const inner = () => seq(children(k));
  switch (b.type) {
    case "heading1": return `<h2 class="b">${rich(b.text)}</h2>`;
    case "heading2": return `<h3 class="b">${rich(b.text)}</h3>`;
    case "heading3": return `<h4 class="b">${rich(b.text)}</h4>`;
    case "heading4": return `<h5 class="b">${rich(b.text)}</h5>`;
    case "bulletedList": return `<ul class="b"><li>${rich(b.text)}${inner()}</li></ul>`;
    case "numberedList": return `<ol class="b" start="${number || 1}"><li>${rich(b.text)}${inner()}</li></ol>`;
    case "todo": { const done = b.props && b.props.checked; return `<div class="b todo${done ? " done" : ""}"><input type="checkbox" disabled ${done ? "checked" : ""}><span>${rich(b.text)}</span></div>${inner()}`; }
    case "toggle": return `<details class="b"><summary>${rich(b.text)}</summary><div style="padding-left:22px">${inner()}</div></details>`;
    case "quote": return `<blockquote class="b">${rich(b.text)}${inner()}</blockquote>`;
    case "callout": return `<div class="callout"><span>${icon(b) || "💡"}</span><div>${rich(b.text)}${inner()}</div></div>`;
    case "divider": return `<hr class="b">`;
    case "code": return `<pre class="b"><code style="background:none;color:inherit;padding:0">${esc(plain(b.text))}</code></pre>`;
    case "table": return `<table class="b">${children(k).map(r => `<tr>${((r.props && r.props.cells) || []).map(c => `<td>${rich(c)}</td>`).join("")}</tr>`).join("")}</table>`;
    case "page": case "databasePage": return `<div class="b pagelink" data-open="${esc(b.id)}">${icon(b) || "📄"} ${esc(title(b.id))}</div>`;
    case "image": { const u = b.props && b.props.url; return u ? `<img class="b" src="${esc(safeUrl(u, true))}" style="max-width:100%;border-radius:4px">` : `<div class="b muted">🖼 Image</div>`; }
    case "databaseInline": return dbTable(b);
    case "meeting": return meeting(b);
    case "meetingSection": case "transcript": return "";
    case "columnList": return `<div class="b" style="display:flex;gap:24px">${children(k).map(c => `<div style="flex:1">${seq(children("b:" + c.id))}</div>`).join("")}</div>`;
    default: return `<div class="b" ${editable(b) ? `contenteditable="plaintext-only" data-edit="${esc(b.id)}"` : ""}>${rich(b.text)}</div>${inner()}`;
  }
}

// Meeting notes (read-only): summary, notes, transcript with speakers and times.
function tc(s) { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; }
function meeting(b) {
  const info = (b.props && b.props.meeting) || {};
  const names = Object.fromEntries((info.speakers || []).map(s => [s.id, s.name]));
  const kids = children("b:" + b.id);
  const section = (kind) => kids.find(c => c.type === "meetingSection" && c.props && c.props.meetingSection === kind);
  let html = `<div class="b callout" style="display:block"><div style="font-weight:600;font-size:17px">🎙 ${esc(plain(b.text) || "Meeting notes")}</div>`;
  for (const [kind, label] of [["summary", "Summary"], ["notes", "Notes"]]) {
    const sec = section(kind); const list = sec ? children("b:" + sec.id) : [];
    if (list.length) html += `<h4 class="b">${label}</h4>${seq(list)}`;
  }
  const segs = kids.filter(c => c.type === "transcript").flatMap(c => (c.props && c.props.segments) || []).filter(x => !x.p).sort((x, y) => x.s - y.s);
  if (segs.length) {
    const paras = [];
    for (const g of segs) { const last = paras[paras.length - 1]; if (last && last.sp === g.sp && g.s - last.e <= 8) { last.t += " " + g.t; last.e = g.e; } else paras.push({ sp: g.sp, s: g.s, e: g.e, t: g.t }); }
    html += `<details class="b"><summary>Transcript</summary>${paras.map(p => `<p><b>${esc(names[p.sp] || p.sp || "Unknown")}</b> <span class="muted">${tc(p.s)}</span><br>${esc(p.t)}</p>`).join("")}</details>`;
  }
  return html + `</div>`;
}

// Databases (read-only): title column + the first properties, values formatted like the apps.
const OPTION_BG = { default:"rgba(227,226,224,.5)", gray:"rgba(227,226,224,.8)", brown:"rgba(238,224,218,.9)", orange:"rgba(250,222,201,.9)",
  yellow:"rgba(253,236,200,.9)", green:"rgba(219,237,219,.9)", blue:"rgba(211,229,239,.9)", purple:"rgba(232,222,238,.9)",
  pink:"rgba(245,224,233,.9)", red:"rgba(255,226,221,.9)" };
function pill(o) { return o ? `<span style="background:${OPTION_BG[o.color] || OPTION_BG.default};color:#37352f;border-radius:3px;padding:0 6px;font-size:13px;margin-right:4px;white-space:nowrap">${esc(o.name)}</span>` : ""; }
function cell(v, p) {
  if (!v) return "";
  const [kind, payload] = Object.entries(v)[0] || [];
  const x = payload && "_0" in payload ? payload._0 : payload;
  const opt = (id) => (p.options || []).find(o => o.id === id);
  switch (kind) {
    case "text": return rich(x);
    case "number": return esc(String(x));
    case "select": case "status": return pill(opt(x));
    case "multiSelect": return (x || []).map(id => pill(opt(id))).join("");
    case "checkbox": return x ? "☑︎" : "☐";
    case "date": { const d = new Date((x.start + 978307200) * 1000); return d.toLocaleDateString(); }
    case "url": return `<a href="${esc(safeUrl(x))}" target="_blank" rel="noopener noreferrer">${esc(x)}</a>`;
    case "email": case "phone": case "place": return esc(x);
    case "relation": return (x || []).map(id => `<span class="pagelink" data-open="${esc(id)}">${esc(title(id))}</span>`).join(", ");
    case "uniqueID": return esc((p.idPrefix ? p.idPrefix + "-" : "") + x);
    default: return "";
  }
}
function dbTable(b) {
  const dbID = b.props && b.props.databaseID;
  const db = dbID && S.recs.get("database:" + dbID);
  if (!db) return `<div class="b muted">▦ Database</div>`;
  const props = (db.properties || []).filter(p => p.type !== "title").slice(0, 4);
  const rows = children("d:" + dbID);
  const name = plain(db.title) || title(b.id);
  return `<div class="b" style="margin:12px 0"><div style="font-weight:600;font-size:15px;margin-bottom:6px">${esc(name)}</div>
    <div style="overflow-x:auto"><table class="db"><tr><th>${esc((db.properties || []).find(p => p.type === "title")?.name || "Name")}</th>${props.map(p => `<th>${esc(p.name)}</th>`).join("")}</tr>
    ${rows.slice(0, 200).map(r => `<tr><td><span class="pagelink" data-open="${esc(r.id)}">${icon(r) || "📄"} ${esc(title(r.id))}</span></td>${props.map(p => `<td>${cell((r.values || {})[p.id], p)}</td>`).join("")}</tr>`).join("")}
    </table></div>${rows.length > 200 ? `<div class="muted">${rows.length - 200} more rows in the app</div>` : ""}</div>`;
}

// Editing (first step): text blocks without inline formatting are editable; saving pushes the record with a
// newer HLC stamp (last writer wins on every device).
const NODE = localStorage.getItem("based.node") || ("web" + Math.random().toString(16).slice(2, 7));
localStorage.setItem("based.node", NODE);
function editable(b) { return canEdit(b.id) && runs(b.text).every(r => !r.m && !r.mention && !r.eq); }
function nextStamp(prev) {
  const now = Date.now();
  const millis = Math.max(now, (prev && prev.millis) || 0);
  const counter = prev && prev.millis === millis ? (prev.counter || 0) + 1 : 0;
  return { millis, counter, node: NODE };
}
async function saveText(id, text) {
  const b = block(id); if (!b || plain(b.text) === text) return;
  const next = { ...b, text: text, stamp: nextStamp(b.stamp), updatedAt: (Date.now() / 1000) - 978307200, updatedBy: "web" };
  if (!text) delete next.text;
  S.recs.set("block:" + id, next);
  const r = await fetch("/sync/v2/push", { method: "POST", headers: { Authorization: "Bearer " + S.token, "Content-Type": "application/json" },
                                          body: JSON.stringify({ records: [{ kind: "block", data: next }], deletions: [] }) });
  if (r.ok) { const reply = await r.json(); for (const n of reply.newer || []) S.recs.set(n.kind + ":" + n.data.id, n.data); }
}

function showPage(id, keepScroll) {
  const b = block(id); if (!b) return;
  const main0 = document.getElementById("main"); const y = main0 ? main0.scrollTop : 0;
  S.current = id;
  let p = b; while (p && p.parent && p.parent.startsWith("b:")) { const pid = p.parent.slice(2); S.open.add(pid); p = block(pid); }
  tree();
  const main = document.getElementById("main");
  const cover = b.props && b.props.cover ? `<div class="cover"></div>` : "";
  main.innerHTML = `${cover}<div class="page">${icon(b) ? `<div class="icon">${icon(b)}</div>` : ""}<h1 class="title" ${editable(b) ? `contenteditable="plaintext-only" data-edit="${esc(id)}"` : ""}>${esc(title(id))}</h1>${b.type === "databasePage" ? dbTable(b) : ""}${seq(children("b:" + id))}</div>`;
  main.scrollTop = keepScroll ? y : 0;
  main.querySelectorAll("[data-edit]").forEach(el => {
    el.onblur = () => saveText(el.dataset.edit, el.innerText.replace(/\n$/, "")).then(tree);
    el.onkeydown = async (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      if (el.tagName === "H1") { el.blur(); return; }
      // Enter: save this line, then a new line below it (created on the server, like the apps do).
      await saveText(el.dataset.edit, el.innerText.replace(/\n$/, ""));
      const r = await fetch("/api/blocks/insert-after", { method: "POST", headers: { Authorization: "Bearer " + S.token, "Content-Type": "application/json" },
                                                          body: JSON.stringify({ after: el.dataset.edit, text: "" }) });
      if (!r.ok) return;
      const { id: newID } = await r.json();
      await sync(); showPage(S.current, true);
      const next = document.querySelector(`[data-edit="${CSS.escape(String(newID))}"]`);
      if (next) next.focus();
    };
  });
  main.querySelectorAll("[data-open]").forEach(el => el.onclick = () => { showPage(el.dataset.open); history.pushState(null, "", "#" + el.dataset.open); });
}

(async () => {
  if (!S.token) return login();
  try { await whoami(); await sync(); shell(); } catch (e) { if (S.link) { document.getElementById("root").textContent = "This link has expired or was revoked."; return; } login(e.message); }
})();
</script>
</body>
</html>
"""#
}

/// BSD-35: HTML responses with a per-response nonce Content-Security-Policy. Our own `<script>` tags get the nonce;
/// workspace content is escaped (`&lt;script`), so it never matches and an injected script can't run.
enum WebSecurity {
    static func nonce() -> String { SecureToken.make(bytes: 18) }

    /// `scriptSources`: extra script origins (published pages: MathJax/Mermaid from jsDelivr). `embeds`: allow
    /// https iframes and media (published pages show embeds, video and audio).
    static func policy(nonce: String, scriptSources: [String] = [], embeds: Bool = false) -> String {
        var p = ["default-src 'self'",
                 "script-src 'nonce-\(nonce)'" + scriptSources.map { " " + $0 }.joined(),
                 "style-src 'self' 'unsafe-inline'",
                 "img-src 'self' data: https:",
                 "connect-src 'self'",
                 "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]
        if embeds { p += ["frame-src https:", "media-src 'self' https: data:", "font-src 'self' https: data:"] }
        return p.joined(separator: "; ")
    }

    /// Adds the nonce to every `<script` tag of `html` (our own markup only; content is escaped).
    static func withNonce(_ html: String, _ nonce: String) -> String {
        html.replacingOccurrences(of: "<script", with: "<script nonce=\"\(nonce)\"")
    }

    static func page(_ html: String, status: Int = 200, scriptSources: [String] = [], embeds: Bool = false) -> HTTPServer.Response {
        let n = nonce()
        return HTTPServer.Response(status: status, headers: [
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": policy(nonce: n, scriptSources: scriptSources, embeds: embeds),
            "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex",
        ], body: Data(withNonce(html, n).utf8))
    }
}
