// Generated from Web/graph.html by Web/make-graph-template.sh — edit the HTML, then rerun the script.
enum GraphTemplate {
    static let html = ##"""
<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Based – Graph</title>
<style>
:root { --bg:#ffffff; --fg:#37352f; --muted:#787774; --line:rgba(55,53,47,.12); --panel:rgba(255,255,255,.94); --accent:#2383e2; --hover:rgba(55,53,47,.06); }
@media (prefers-color-scheme: dark) { :root { --bg:#2a2a2a; --fg:#e6e6e4; --muted:#9b9a97; --line:rgba(255,255,255,.12); --panel:rgba(32,32,32,.94); --accent:#529cca; --hover:rgba(255,255,255,.06); } }
html,body { margin:0; height:100%; overflow:hidden; background:var(--bg); color:var(--fg); font:13px -apple-system, system-ui, sans-serif; }
canvas { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:grab; }
canvas.dragging { cursor:grabbing; }
#panel { position:absolute; top:12px; left:12px; width:250px; max-height:calc(100% - 24px); overflow:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 4px 18px rgba(0,0,0,.12); padding:10px 12px; backdrop-filter:blur(12px); }
#panel.collapsed > :not(.head) { display:none; }
.head { display:flex; align-items:center; gap:6px; }
.head b { flex:1; font-size:13px; }
h4 { margin:12px 0 5px; font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
select, input[type=search] { width:100%; box-sizing:border-box; font:inherit; color:inherit; background:var(--hover); border:1px solid var(--line); border-radius:6px; padding:4px 6px; }
.seg { display:flex; gap:2px; background:var(--hover); border-radius:7px; padding:2px; }
.seg button { flex:1; border:0; background:transparent; color:inherit; font:inherit; padding:4px 0; border-radius:5px; cursor:pointer; }
.seg button.on { background:var(--bg); box-shadow:0 1px 2px rgba(0,0,0,.15); }
label.row { display:flex; align-items:center; gap:6px; padding:2px 0; cursor:pointer; }
label.row span.sw { width:10px; height:10px; border-radius:3px; flex:none; }
label.row span.n { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.list { max-height:150px; overflow:auto; }
.roles label { display:grid; grid-template-columns:62px 1fr; align-items:center; gap:6px; margin:3px 0; }
.btn { border:1px solid var(--line); background:var(--hover); color:inherit; font:inherit; border-radius:6px; padding:3px 8px; cursor:pointer; }
.btns { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
.hint { color:var(--muted); font-size:11px; margin-top:4px; line-height:1.35; }
#info { position:absolute; right:12px; top:12px; width:240px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px; box-shadow:0 4px 18px rgba(0,0,0,.12); display:none; }
#info .t { font-weight:600; font-size:14px; margin-bottom:4px; word-break:break-word; }
#info .m { color:var(--muted); font-size:12px; line-height:1.5; }
#legend { position:absolute; right:12px; bottom:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:8px 10px; max-height:40%; overflow:auto; font-size:12px; display:none; }
#legend div { display:flex; align-items:center; gap:6px; margin:2px 0; }
#legend i { width:10px; height:10px; border-radius:50%; display:inline-block; }
#stats { position:absolute; left:12px; bottom:10px; color:var(--muted); font-size:11px; pointer-events:none; }
#tip { position:absolute; pointer-events:none; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:3px 7px; font-size:12px; display:none; white-space:nowrap; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="panel">
  <div class="head"><b>Graph</b><button class="btn" id="collapse" title="Einklappen">–</button></div>
  <input type="search" id="search" placeholder="Seite suchen…" style="margin-top:8px">
  <h4>Ansicht</h4>
  <div class="seg" id="layout">
    <button data-v="network">Netzwerk</button><button data-v="tree">Baum</button><button data-v="radial">Radial</button>
  </div>
  <div class="seg" id="direction" style="margin-top:4px">
    <button data-v="down">↓ Vertikal</button><button data-v="right">→ Horizontal</button>
  </div>
  <h4>Rollen (Stammbaum)</h4>
  <div class="roles">
    <label>Elternteil<select id="role-parent"></select></label>
    <label>Kind<select id="role-child"></select></label>
    <label>Partner<select id="role-partner"></select></label>
  </div>
  <div class="hint">Ohne Rollen gilt die Seitenhierarchie (Unterseiten). Bei zweiseitigen Relations reicht „Elternteil“.</div>
  <h4>Verbindungen</h4>
  <div class="list" id="kinds"></div>
  <h4>Einfärben</h4>
  <select id="colorBy"></select>
  <h4>Größe</h4>
  <select id="sizeBy"></select>
  <h4>Sortieren (in einer Ebene)</h4>
  <select id="sortBy"></select>
  <h4>Datenbanken</h4>
  <div class="list" id="dbs"></div>
  <h4>Filter</h4>
  <label class="row"><input type="checkbox" id="hideIsolated"><span class="n">Seiten ohne Verbindung ausblenden</span></label>
  <label class="row"><span class="n">Tiefe ab Auswahl</span><select id="depth" style="width:90px"><option value="0">alle</option><option>1</option><option>2</option><option>3</option><option>4</option><option>6</option></select></label>
  <div class="btns"><button class="btn" id="fit">Einpassen</button><button class="btn" id="clearFocus">Auswahl aufheben</button><button class="btn" id="export">Als HTML exportieren</button></div>
</div>
<div id="info"></div>
<div id="legend"></div>
<div id="stats"></div>
<div id="tip"></div>
<script>/*DATA*/</script>
<script>
(function () {
'use strict';
var G = window.GRAPH || { nodes: [], edges: [], kinds: [], databases: [] };
var S = Object.assign({
  layout: 'network', direction: 'down', kinds: {}, roles: { parent: '', child: '', partner: '' },
  dbs: {}, colorBy: 'database', sizeBy: 'degree', sortBy: 'title', hideIsolated: true, depth: 0, focus: ''
}, window.SETTINGS || {});
S.roles = Object.assign({ parent: '', child: '', partner: '' }, S.roles || {});
if (window.FOCUS) { S.focus = window.FOCUS; }
var STANDALONE = !(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.graph);
function post(type, body) { try { window.webkit.messageHandlers.graph.postMessage(JSON.stringify({ type: type, body: body })); } catch (e) {} }
function save() { if (!STANDALONE) post('settings', S); }

// ---------- colours ----------
var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
var TCOL = dark
  ? { 'default': '#9b9a97', gray: '#9b9a97', brown: '#ba856f', orange: '#c77d48', yellow: '#ca9849', green: '#529e72', blue: '#5e87c9', purple: '#9d68d3', pink: '#d15796', red: '#df5452' }
  : { 'default': '#9b9a97', gray: '#9b9a97', brown: '#9f6b53', orange: '#d9730d', yellow: '#cb912f', green: '#448361', blue: '#337ea9', purple: '#9065b0', pink: '#c14c8a', red: '#d44c47' };
function tcol(name) { return TCOL[(name || 'default').replace('Background', '')] || TCOL['default']; }
var PALETTE = ['#2383e2', '#d9730d', '#448361', '#9065b0', '#d44c47', '#cb912f', '#c14c8a', '#337ea9', '#9f6b53', '#0f9d9a', '#7d8b2d', '#5b5bd6'];
function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }
function ramp(t) { // 0 → blue, 1 → red (through violet)
  t = Math.max(0, Math.min(1, t));
  var a = [35, 131, 226], b = [212, 76, 71];
  return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' + Math.round(a[2] + (b[2] - a[2]) * t) + ')';
}
var NODE_DEFAULT = dark ? '#8a8a87' : '#9b9a97';
var EDGE_BASE = dark ? 'rgba(255,255,255,' : 'rgba(55,53,47,';

// ---------- indices ----------
var byId = {}, kindById = {}, dbById = {}, propIndex = {};
var nodes = [], edges = [];
function index() {
  byId = {}; kindById = {}; dbById = {}; propIndex = {};
  G.kinds.forEach(function (k) { kindById[k.id] = k; if (S.kinds[k.id] === undefined) { S.kinds[k.id] = true; } });
  G.databases.forEach(function (d) {
    dbById[d.id] = d;
    d.props.forEach(function (p) {
      var opts = {}; p.options.forEach(function (o) { opts[o.id] = o; });
      propIndex[d.id + ':' + p.id] = { db: d, prop: p, opts: opts };
    });
  });
  var old = {};
  nodes.forEach(function (n) { old[n.id] = n; });
  nodes = G.nodes.map(function (n) {
    var o = old[n.id];
    var m = { id: n.id, t: n.t, i: n.i, db: n.db, v: n.v || {}, e: n.e, x: o ? o.x : (Math.random() - .5) * 800, y: o ? o.y : (Math.random() - .5) * 800, vx: 0, vy: 0, tx: 0, ty: 0 };
    byId[n.id] = m; return m;
  });
  edges = G.edges.filter(function (e) { return byId[e.s] && byId[e.t]; });
}

// ---------- visibility, roles, closeness ----------
var vis = [], visIds = {}, visEdges = [], adj = {}, deg = {}, dist = {}, kin = {};
var parentsOf = {}, childrenOf = {}, partnersOf = {};
function edgeKindVisible(k) { return S.kinds[k] !== false; }
function dbVisible(n) { var key = n.db || '_pages'; return S.dbs[key] !== false; }

function buildRoles(nodeSet) {
  parentsOf = {}; childrenOf = {}; partnersOf = {};
  var useRoles = S.roles.parent || S.roles.child;
  function link(p, c) {
    if (p === c || !nodeSet[p] || !nodeSet[c]) { return; }
    (parentsOf[c] = parentsOf[c] || {})[p] = 1; (childrenOf[p] = childrenOf[p] || {})[c] = 1;
  }
  edges.forEach(function (e) {
    if (useRoles) {
      if (e.k === S.roles.parent) { link(e.t, e.s); }           // row s lists t as its parent
      else if (e.k === S.roles.child) { link(e.s, e.t); }       // row s lists t as its child
      else if (S.roles.parent && kindById[S.roles.parent] && kindById[S.roles.parent].inverse === e.k) { link(e.s, e.t); } // synced "children" side
    } else if (e.k === 'child') { link(e.s, e.t); }
    if (S.roles.partner && e.k === S.roles.partner && e.s !== e.t && nodeSet[e.s] && nodeSet[e.t]) {
      (partnersOf[e.s] = partnersOf[e.s] || {})[e.t] = 1; (partnersOf[e.t] = partnersOf[e.t] || {})[e.s] = 1;
    }
  });
}

// Coefficient of relationship to the focus: Σ over lowest common ancestors (½)^(n1+n2) (no inbreeding term).
function ancestors(id) {
  var out = {}, q = [[id, 0]], guard = 0;
  while (q.length && guard++ < 20000) {
    var c = q.shift(), ps = parentsOf[c[0]];
    if (!ps || c[1] >= 14) { continue; }
    for (var p in ps) { (out[p] = out[p] || []).push(c[1] + 1); q.push([p, c[1] + 1]); }
  }
  return out;
}
function computeKinship() {
  kin = {};
  if (!S.focus || !(S.roles.parent || S.roles.child)) { return; }
  var fa = ancestors(S.focus); fa[S.focus] = [0];
  vis.forEach(function (n) {
    if (n.id === S.focus) { kin[n.id] = 1; return; }
    var xa = ancestors(n.id); xa[n.id] = [0];
    var common = []; for (var a in xa) { if (fa[a]) { common.push(a); } }
    if (!common.length) { return; }
    var cs = {}; common.forEach(function (c) { cs[c] = 1; });
    var r = 0;
    common.forEach(function (c) {
      // only lowest common ancestors: skip c if one of its descendants is also common
      var ch = childrenOf[c], lowest = true;
      if (ch) { for (var k in ch) { if (cs[k]) { lowest = false; break; } } }
      if (!lowest) { return; }
      fa[c].forEach(function (d1) { xa[c].forEach(function (d2) { r += Math.pow(.5, d1 + d2); }); });
    });
    if (r > 0) { kin[n.id] = Math.min(1, r); }
  });
}

function recompute() {
  var nodeSet = {};
  nodes.forEach(function (n) { if (dbVisible(n)) { nodeSet[n.id] = 1; } });
  buildRoles(nodeSet);
  adj = {}; deg = {}; visEdges = [];
  var seen = {};
  edges.forEach(function (e) {
    if (!nodeSet[e.s] || !nodeSet[e.t] || !edgeKindVisible(e.k)) { return; }
    var k = kindById[e.k], group = k && k.inverse && k.inverse < e.k ? k.inverse : e.k; // a two-way relation is one line
    var key = (e.s < e.t ? e.s + '|' + e.t : e.t + '|' + e.s) + '|' + group;
    if (seen[key]) { return; } seen[key] = 1;
    visEdges.push(e);
    (adj[e.s] = adj[e.s] || []).push(e.t); (adj[e.t] = adj[e.t] || []).push(e.s);
    deg[e.s] = (deg[e.s] || 0) + 1; deg[e.t] = (deg[e.t] || 0) + 1;
  });
  // BFS distance from the focus over visible connections (also used for the depth filter and closeness colour).
  dist = {};
  if (S.focus && nodeSet[S.focus]) {
    dist[S.focus] = 0; var q = [S.focus];
    for (var qi = 0; qi < q.length; qi++) {
      var c = q[qi], nb = adj[c] || [];
      for (var j = 0; j < nb.length; j++) { if (dist[nb[j]] === undefined) { dist[nb[j]] = dist[c] + 1; q.push(nb[j]); } }
    }
  }
  var depth = +S.depth || 0;
  vis = nodes.filter(function (n) {
    if (!nodeSet[n.id]) { return false; }
    if (S.hideIsolated && !deg[n.id] && n.id !== S.focus) { return false; }
    if (depth && S.focus && nodeSet[S.focus] && (dist[n.id] === undefined || dist[n.id] > depth)) { return false; }
    return true;
  });
  var visSet = {}; vis.forEach(function (n) { visSet[n.id] = 1; });
  visIds = visSet;
  visEdges = visEdges.filter(function (e) { return visSet[e.s] && visSet[e.t]; });
  computeKinship();
  applyStyle();
  layout();
}

// ---------- colour / size / sort ----------
function valueOf(n, spec) { // spec "prop:<db>:<prop>"
  var parts = spec.split(':'); if (n.db !== parts[1]) { return undefined; } return n.v[parts[2]];
}
var legend = [];
function applyStyle() {
  legend = [];
  var cb = S.colorBy, maxDeg = 1;
  vis.forEach(function (n) { maxDeg = Math.max(maxDeg, deg[n.id] || 0); });
  var nums = null;
  if (cb === 'age' || cb.indexOf('prop:') === 0) {
    var vals = vis.map(function (n) { return cb === 'age' ? n.e : valueOf(n, cb); }).filter(function (v) { return typeof v === 'number'; });
    if (vals.length) { nums = [Math.min.apply(null, vals), Math.max.apply(null, vals)]; }
  }
  var pi = cb.indexOf('prop:') === 0 ? propIndex[cb.slice(5)] : null;
  var usedDb = {}, usedOpt = {};
  vis.forEach(function (n) {
    var col = NODE_DEFAULT;
    if (cb === 'database') {
      if (n.db) { col = PALETTE[hash(n.db) % PALETTE.length]; usedDb[n.db] = col; } else { usedDb['_pages'] = NODE_DEFAULT; }
    } else if (cb === 'closeness') {
      if (S.focus) {
        if (kin[n.id] !== undefined) { col = ramp(1 - Math.log2(1 / kin[n.id]) / 6); }
        else if (dist[n.id] !== undefined) { col = ramp(Math.max(0, 1 - dist[n.id] / 5) * .85); }
      }
    } else if (cb === 'age' || (pi && nums && (pi.prop.type === 'number' || pi.prop.type === 'date' || pi.prop.type === 'uniqueID' || pi.prop.type === 'checkbox'))) {
      var v = cb === 'age' ? n.e : valueOf(n, cb);
      if (typeof v === 'number' && nums) { col = ramp(nums[1] > nums[0] ? (v - nums[0]) / (nums[1] - nums[0]) : .5); }
    } else if (pi) {
      var o = pi.opts[valueOf(n, cb)];
      if (o) { col = tcol(o.color); usedOpt[o.id] = o; }
    }
    n.col = col;
    var r = 5;
    if (S.sizeBy === 'degree') { r = 3.5 + Math.sqrt((deg[n.id] || 0) / maxDeg) * 11; }
    else if (S.sizeBy.indexOf('prop:') === 0) { var sv = valueOf(n, S.sizeBy); r = typeof sv === 'number' ? 4 + Math.min(14, Math.sqrt(Math.abs(sv))) : 3.5; }
    n.r = r;
  });
  if (cb === 'database') {
    for (var d in usedDb) { legend.push([usedDb[d], d === '_pages' ? 'Seiten (ohne Datenbank)' : (dbById[d] ? dbById[d].name : 'Datenbank')]); }
  } else if (pi && !nums) {
    pi.prop.options.forEach(function (o) { if (usedOpt[o.id]) { legend.push([tcol(o.color), o.name]); } });
  } else if (cb === 'closeness') {
    legend = S.focus ? [[ramp(1), 'Sehr eng'], [ramp(.5), 'Mittel'], [ramp(.1), 'Entfernt'], [NODE_DEFAULT, 'Keine Verbindung']] : [[NODE_DEFAULT, 'Seite auswählen, um Nähe zu sehen']];
  } else if (nums) {
    var fmt = function (v) { return (cb === 'age' || (pi && pi.prop.type === 'date')) ? new Date(v * 1000).toLocaleDateString() : String(Math.round(v * 100) / 100); };
    legend = [[ramp(0), fmt(nums[0])], [ramp(1), fmt(nums[1])]];
  }
  renderLegend();
}
function sortKey(n) {
  if (S.sortBy === 'edited') { return -n.e; }
  if (S.sortBy.indexOf('prop:') === 0) {
    var v = valueOf(n, S.sortBy), pi = propIndex[S.sortBy.slice(5)];
    if (pi && pi.prop.options.length && typeof v === 'string') { var i = pi.prop.options.findIndex(function (o) { return o.id === v; }); return i < 0 ? 1e9 : i; }
    return v === undefined ? 1e15 : v;
  }
  return (n.t || '').toLowerCase();
}
function cmp(a, b) { var x = sortKey(a), y = sortKey(b); return x < y ? -1 : x > y ? 1 : 0; }

// ---------- layouts ----------
var simRunning = false, alpha = 0;
var firstLayout = true;
function layout() {
  var first = firstLayout; firstLayout = false;
  if (S.layout === 'network') {
    if (first) { // settle before the first frame so the graph opens calm and fitted
      alpha = 1; var t0 = Date.now();
      while (alpha > 0.05 && Date.now() - t0 < 700) { simStep(); }
      fit();
    }
    startSim(); return;
  }
  simRunning = false;
  if (S.layout === 'tree') { treeLayout(); } else { radialLayout(); }
  if (first) { vis.forEach(function (n) { n.x = n.tx; n.y = n.ty; }); fit(); return; }
  animateTo();
}

// Layered (Sugiyama-style) layout: generations from the parent relation, partners side by side, children
// ordered under their parents, then a few sweeps pulling each unit towards its parents / children.
function generations() {
  var visSet = {}; vis.forEach(function (n) { visSet[n.id] = 1; });
  var gen = {}, state = {};
  function g(id) {
    if (gen[id] !== undefined) { return gen[id]; }
    if (state[id]) { return 0; } state[id] = 1;
    var best = 0, ps = parentsOf[id];
    if (ps) { for (var p in ps) { if (visSet[p]) { best = Math.max(best, g(p) + 1); } } }
    gen[id] = best; return best;
  }
  vis.forEach(function (n) { g(n.id); });
  for (var round = 0; round < 6; round++) {  // partners share a generation; their children sit below both
    var changed = false;
    vis.forEach(function (n) {
      var pa = partnersOf[n.id];
      if (pa) { for (var p in pa) { if (visSet[p] && gen[p] > gen[n.id]) { gen[n.id] = gen[p]; changed = true; } } }
      var ps = parentsOf[n.id];
      if (ps) { for (var q in ps) { if (visSet[q] && gen[q] + 1 > gen[n.id]) { gen[n.id] = gen[q] + 1; changed = true; } } }
    });
    if (!changed) { break; }
  }
  return gen;
}
var units = []; // for drawing family connectors
function treeLayout() {
  var gen = generations();
  var layers = [];
  vis.forEach(function (n) { (layers[gen[n.id]] = layers[gen[n.id]] || []).push(n); });
  var GAPX = 46, GAPY = 120, pos = {};
  units = [];
  layers.forEach(function (layer, li) {
    if (!layer) { return; }
    // group partners into units
    var unitOf = {}, list = [];
    layer.sort(cmp);
    layer.forEach(function (n) {
      if (unitOf[n.id]) { return; }
      var u = { members: [n], layer: li }; unitOf[n.id] = u; list.push(u);
      var stack = [n.id];
      while (stack.length) {
        var c = stack.pop(), pa = partnersOf[c];
        if (!pa) { continue; }
        for (var p in pa) { var pn = byId[p]; if (pn && !unitOf[p] && gen[p] === li && layer.indexOf(pn) >= 0) { unitOf[p] = u; u.members.push(pn); stack.push(p); } }
      }
    });
    // order by barycenter of parents (layer above), ties by the sort key
    list.forEach(function (u, i) {
      var sum = 0, cnt = 0;
      u.members.forEach(function (m) { var ps = parentsOf[m.id]; if (ps) { for (var p in ps) { if (pos[p] !== undefined) { sum += pos[p]; cnt++; } } } });
      u.bary = cnt ? sum / cnt : null; u.idx = i;
    });
    var withB = list.filter(function (u) { return u.bary !== null; }).sort(function (a, b) { return a.bary - b.bary || a.idx - b.idx; });
    var without = list.filter(function (u) { return u.bary === null; });
    list = withB.concat(without);
    var x = 0;
    list.forEach(function (u) {
      u.w = u.members.length * GAPX;
      var want = u.bary !== null ? u.bary - (u.w - GAPX) / 2 : x;
      u.x = Math.max(x, want);
      u.members.forEach(function (m, k) { pos[m.id] = u.x + k * GAPX; });
      x = u.x + u.w + (u.bary === null ? 0 : 10);
    });
    units[li] = list;
  });
  // upward sweeps: centre parents over their children where there is room
  for (var sweep = 0; sweep < 3; sweep++) {
    for (var li = units.length - 2; li >= 0; li--) {
      var list = units[li]; if (!list) { continue; }
      list.forEach(function (u) {
        var sum = 0, cnt = 0;
        u.members.forEach(function (m) { var ch = childrenOf[m.id]; if (ch) { for (var c in ch) { if (pos[c] !== undefined && gen[c] === li + 1) { sum += pos[c]; cnt++; } } } });
        if (cnt) { u.want = sum / cnt - (u.w - GAPX) / 2; } else { u.want = u.x; }
      });
      // place left to right without overlap, as close to want as possible
      var minX = -Infinity;
      list.forEach(function (u) { u.x = Math.max(minX, u.want); minX = u.x + u.w; });
      list.forEach(function (u) { u.members.forEach(function (m, k) { pos[m.id] = u.x + k * GAPX; }); });
    }
  }
  // centre each layer and set targets
  var widest = 0;
  units.forEach(function (list) { if (list && list.length) { var l = list[list.length - 1]; widest = Math.max(widest, l.x + l.w - list[0].x); } });
  vis.forEach(function (n) {
    var a = pos[n.id] - widest / 2, b = gen[n.id] * GAPY;
    if (S.direction === 'right') { n.tx = b * 1.6; n.ty = a; } else { n.tx = a; n.ty = b; }
  });
}
function radialLayout() {
  // rings: distance from the focus, or generations when nothing is selected
  var ring = {};
  if (S.focus && dist[S.focus] !== undefined) { vis.forEach(function (n) { ring[n.id] = dist[n.id] === undefined ? null : dist[n.id]; }); }
  else { var gen = generations(); vis.forEach(function (n) { ring[n.id] = gen[n.id]; }); }
  var rings = [], outer = [];
  vis.forEach(function (n) { var r = ring[n.id]; if (r === null || r === undefined) { outer.push(n); } else { (rings[r] = rings[r] || []).push(n); } });
  if (outer.length) { rings.push(outer); }
  var angle = {};
  rings.forEach(function (list, ri) {
    if (!list) { return; }
    list.forEach(function (n, i) {
      var sum = 0, cnt = 0, nb = adj[n.id] || [];
      nb.forEach(function (m) { if (angle[m] !== undefined) { sum += angle[m]; cnt++; } });
      n._b = cnt ? sum / cnt : 1e9 + i;
    });
    list.sort(function (a, b) { return a._b - b._b || cmp(a, b); });
    var R = ri === 0 && list.length === 1 ? 0 : 140 + ri * 150 + Math.max(0, list.length * 14 / (2 * Math.PI) - 140 - ri * 150) * (ri ? 1 : 0);
    R = Math.max(R, list.length * 14 / (2 * Math.PI));
    list.forEach(function (n, i) {
      var a = (i / list.length) * Math.PI * 2;
      angle[n.id] = a; n.tx = Math.cos(a) * R; n.ty = Math.sin(a) * R;
    });
  });
  units = [];
}
var anim = 0;
function animateTo() {
  vis.forEach(function (n) { n.sx = n.x; n.sy = n.y; });
  anim = 1; var t0 = performance.now();
  function step(t) {
    var k = Math.min(1, Math.max(0, t - t0) / 450), e = 1 - Math.pow(1 - k, 3);
    vis.forEach(function (n) { n.x = n.sx + (n.tx - n.sx) * e; n.y = n.sy + (n.ty - n.sy) * e; });
    draw();
    if (k < 1) { requestAnimationFrame(step); } else { anim = 0; if (pendingFit) { fit(); } }
  }
  requestAnimationFrame(step);
}

// Force-directed network (Barnes–Hut repulsion, springs along visible edges, weak gravity).
function startSim() { alpha = 1; if (!simRunning) { simRunning = true; requestAnimationFrame(tick); } }
function tick() {
  if (!simRunning || S.layout !== 'network') { simRunning = false; return; }
  var t0 = performance.now(), iters = 0;
  do { simStep(); iters++; } while (alpha > 0.02 && performance.now() - t0 < 12 && iters < 4);
  draw();
  if (pendingFit && alpha < 0.3) { fit(); }
  if (alpha > 0.02 || dragNode) { requestAnimationFrame(tick); } else { simRunning = false; if (pendingFit) { fit(); } }
}
function simStep() {
  var n = vis.length; if (!n) { alpha = 0; return; }
  // quadtree
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < n; i++) { var p = vis[i]; if (p.x < minX) { minX = p.x; } if (p.y < minY) { minY = p.y; } if (p.x > maxX) { maxX = p.x; } if (p.y > maxY) { maxY = p.y; } }
  var size = Math.max(maxX - minX, maxY - minY) + 1;
  var root = { x0: minX, y0: minY, s: size, m: 0, cx: 0, cy: 0, kids: null, leaf: null };
  function insert(q, p, depth) {
    q.cx = (q.cx * q.m + p.x) / (q.m + 1); q.cy = (q.cy * q.m + p.y) / (q.m + 1); q.m++;
    if (!q.kids && !q.leaf && q.m === 1) { q.leaf = p; return; }
    if (depth > 24) { return; }
    if (!q.kids) {
      var h = q.s / 2; q.kids = [null, null, null, null];
      var old = q.leaf; q.leaf = null;
      if (old) { place(q, old, depth); }
    }
    place(q, p, depth);
  }
  function place(q, p, depth) {
    var h = q.s / 2, ix = p.x >= q.x0 + h ? 1 : 0, iy = p.y >= q.y0 + h ? 1 : 0, k = iy * 2 + ix;
    if (!q.kids[k]) { q.kids[k] = { x0: q.x0 + ix * h, y0: q.y0 + iy * h, s: h, m: 0, cx: 0, cy: 0, kids: null, leaf: null }; }
    insert(q.kids[k], p, depth + 1);
  }
  for (i = 0; i < n; i++) { insert(root, vis[i], 0); }
  var REP = 900 * alpha, THETA2 = 0.81;
  function repel(q, p) {
    if (!q || !q.m) { return; }
    var dx = q.cx - p.x, dy = q.cy - p.y, d2 = dx * dx + dy * dy + 0.01;
    if ((q.leaf && q.leaf !== p && !q.kids) || (q.kids && (q.s * q.s) / d2 < THETA2)) {
      if (q.leaf === p) { return; }
      var f = REP * q.m / d2; p.vx -= dx * f; p.vy -= dy * f; return;
    }
    if (q.kids) { for (var k = 0; k < 4; k++) { repel(q.kids[k], p); } }
  }
  for (i = 0; i < n; i++) { repel(root, vis[i]); }
  var SPRING = 0.06 * alpha, LEN = 60;
  for (i = 0; i < visEdges.length; i++) {
    var e = visEdges[i], a = byId[e.s], b = byId[e.t];
    var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - LEN) * SPRING / d;
    var da = deg[e.s] || 1, db = deg[e.t] || 1;
    a.vx += dx * f / Math.sqrt(da); a.vy += dy * f / Math.sqrt(da); b.vx -= dx * f / Math.sqrt(db); b.vy -= dy * f / Math.sqrt(db);
  }
  var GRAV = 0.004 * alpha;
  for (i = 0; i < n; i++) {
    var q = vis[i];
    q.vx -= q.x * GRAV; q.vy -= q.y * GRAV;
    if (q === dragNode) { q.vx = q.vy = 0; continue; }
    var sp = Math.sqrt(q.vx * q.vx + q.vy * q.vy); if (sp > 40) { q.vx *= 40 / sp; q.vy *= 40 / sp; }
    q.x += q.vx; q.y += q.vy; q.vx *= 0.55; q.vy *= 0.55;
  }
  alpha *= 0.985;
}

// ---------- rendering ----------
var cv = document.getElementById('c'), ctx = cv.getContext('2d');
var W = 0, H = 0, DPR = 1, view = { s: 1, x: 0, y: 0 }, hover = null, dragNode = null, pendingFit = true, matches = null;
function resize() {
  DPR = window.devicePixelRatio || 1; W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR; draw();
}
function toScreen(x, y) { return [x * view.s + view.x, y * view.s + view.y]; }
function toWorld(x, y) { return [(x - view.x) / view.s, (y - view.y) / view.s]; }
function fit() {
  pendingFit = false; if (!vis.length) { return; }
  var a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  vis.forEach(function (n) { a = Math.min(a, n.x); b = Math.min(b, n.y); c = Math.max(c, n.x); d = Math.max(d, n.y); });
  var panel = document.getElementById('panel'), left = panel.classList.contains('collapsed') || W < 700 ? 0 : panel.offsetWidth + 12;
  var pad = 50, aw = W - left - pad * 2, s = Math.min(aw / Math.max(1, c - a), (H - pad * 2) / Math.max(1, d - b));
  view.s = Math.max(0.02, Math.min(2, s)); view.x = left + pad + aw / 2 - (a + c) / 2 * view.s; view.y = H / 2 - (b + d) / 2 * view.s;
  draw();
}
function kindColor(k) {
  if (k === 'child') { return EDGE_BASE + '0.28)'; }
  if (k === 'mention') { return dark ? 'rgba(157,104,211,0.45)' : 'rgba(144,101,176,0.4)'; }
  if (k === S.roles.partner) { return dark ? 'rgba(209,87,150,0.8)' : 'rgba(193,76,138,0.75)'; }
  return PALETTE[(hash(k) + 3) % PALETTE.length];
}
function draw() {
  if (!W) { return; }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.translate(view.x, view.y); ctx.scale(view.s, view.s);
  var hl = hover || (S.focus && byId[S.focus] ? byId[S.focus] : null), hlSet = null;
  if (hl) { hlSet = {}; hlSet[hl.id] = 1; (adj[hl.id] || []).forEach(function (m) { hlSet[m] = 1; }); }
  if (matches) { hlSet = matches; hl = null; }
  var lw = 1 / view.s;
  var DIM = (S.layout !== 'network' || S.colorBy === 'closeness') ? 0.4 : 0.16;
  // edges grouped by kind
  var groups = {};
  visEdges.forEach(function (e) { (groups[e.k] = groups[e.k] || []).push(e); });
  var tree = S.layout === 'tree';
  var roleKinds = {}; if (tree) { roleKinds[S.roles.parent || 'child'] = 1; if (S.roles.child) { roleKinds[S.roles.child] = 1; } if (S.roles.parent && kindById[S.roles.parent] && kindById[S.roles.parent].inverse) { roleKinds[kindById[S.roles.parent].inverse] = 1; } }
  if (tree) { drawFamilies(roleKinds, hlSet, hl, lw, DIM); }
  for (var k in groups) {
    if (tree && roleKinds[k]) { continue; }
    var list = groups[k], col = kindColor(k);
    var elbow = false;
    ctx.strokeStyle = col; ctx.lineWidth = (k === S.roles.partner ? 2.2 : (k.indexOf('rel:') === 0 ? 1.4 : 1)) * lw;
    ctx.globalAlpha = hlSet ? DIM * 0.7 : 1;
    ctx.beginPath(); pathEdges(list, elbow, null); ctx.stroke();
    if (hlSet) { ctx.globalAlpha = 1; ctx.beginPath(); pathEdges(list, elbow, hlSet, hl); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  // nodes
  for (var i = 0; i < vis.length; i++) {
    var n = vis[i], dim = hlSet && !hlSet[n.id];
    ctx.globalAlpha = dim ? DIM : 1;
    ctx.fillStyle = n.col || NODE_DEFAULT;
    ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(n.r || 5, 1.8 / view.s), 0, Math.PI * 2); ctx.fill();
    if (n.id === S.focus) { ctx.lineWidth = 2.5 * lw; ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent'); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  // labels: zoomed in, or highlighted
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  var fg = getComputedStyle(document.body).getPropertyValue('--fg'), bg = getComputedStyle(document.body).getPropertyValue('--bg');
  var showAll = view.s > 0.75 || vis.length < 60;
  var drawn = 0;
  for (i = 0; i < vis.length && drawn < 1500; i++) {
    n = vis[i];
    var on = hlSet ? hlSet[n.id] : showAll;
    if (!on && !(view.s > 0.35 && (n.r || 5) * view.s > 7)) { continue; }
    var p = toScreen(n.x, n.y); if (p[0] < -100 || p[0] > W + 100 || p[1] < -40 || p[1] > H + 40) { continue; }
    var label = (n.i ? n.i + ' ' : '') + (n.t.length > 34 ? n.t.slice(0, 33) + '…' : n.t);
    ctx.globalAlpha = hlSet && !hlSet[n.id] ? 0.25 : 0.95;
    ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.strokeText(label, p[0], p[1] + (n.r || 5) * view.s + 3);
    ctx.fillStyle = fg; ctx.fillText(label, p[0], p[1] + (n.r || 5) * view.s + 3); drawn++;
  }
  ctx.globalAlpha = 1;
  document.getElementById('stats').textContent = vis.length + ' Seiten · ' + visEdges.length + ' Verbindungen';
}
// Family-tree connectors: one line from the parents (the middle of a couple) down to a bar over all their
// children, like genealogy apps draw a "family" (two partners + their children).
function drawFamilies(roleKinds, hlSet, hl, lw, DIM) {
  var fam = {};
  vis.forEach(function (c) {
    var ps = parentsOf[c.id]; if (!ps) { return; }
    var list = Object.keys(ps).filter(function (p) { return byId[p] && byId[p].tx !== undefined && visIds[p]; }).sort();
    if (!list.length) { return; }
    var key = list.join('|'); (fam[key] = fam[key] || { parents: list, kids: [] }).kids.push(c);
  });
  var horiz = S.direction === 'right';
  ctx.lineWidth = 1.3 * lw;
  for (var key in fam) {
    var f = fam[key], ps = f.parents.map(function (p) { return byId[p]; });
    var on = !hlSet || (hl ? (f.parents.indexOf(hl.id) >= 0 || f.kids.some(function (k) { return k.id === hl.id; })) : f.kids.some(function (k) { return hlSet[k.id]; }));
    ctx.globalAlpha = on ? 1 : DIM * 0.7;
    ctx.strokeStyle = on && hlSet ? (dark ? 'rgba(255,255,255,0.75)' : 'rgba(55,53,47,0.7)') : EDGE_BASE + '0.35)';
    ctx.beginPath();
    var mx = 0, my = 0; ps.forEach(function (p) { mx += p.x; my += p.y; }); mx /= ps.length; my /= ps.length;
    if (!horiz) {
      var kidY = Math.min.apply(null, f.kids.map(function (k) { return k.y; })), bar = my + (kidY - my) * 0.55;
      var xs = f.kids.map(function (k) { return k.x; }).concat([mx]);
      ps.forEach(function (p) { if (ps.length > 1) { ctx.moveTo(p.x, p.y); ctx.lineTo(mx, my); } });
      ctx.moveTo(mx, my); ctx.lineTo(mx, bar);
      ctx.moveTo(Math.min.apply(null, xs), bar); ctx.lineTo(Math.max.apply(null, xs), bar);
      f.kids.forEach(function (k) { ctx.moveTo(k.x, bar); ctx.lineTo(k.x, k.y); });
    } else {
      var kidX = Math.min.apply(null, f.kids.map(function (k) { return k.x; })), barx = mx + (kidX - mx) * 0.55;
      var ys = f.kids.map(function (k) { return k.y; }).concat([my]);
      ps.forEach(function (p) { if (ps.length > 1) { ctx.moveTo(p.x, p.y); ctx.lineTo(mx, my); } });
      ctx.moveTo(mx, my); ctx.lineTo(barx, my);
      ctx.moveTo(barx, Math.min.apply(null, ys)); ctx.lineTo(barx, Math.max.apply(null, ys));
      f.kids.forEach(function (k) { ctx.moveTo(barx, k.y); ctx.lineTo(k.x, k.y); });
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function pathEdges(list, elbow, only, hl) {
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (only) { if (!(only[e.s] && only[e.t])) { continue; } if (hl && e.s !== hl.id && e.t !== hl.id) { continue; } }
    var a = byId[e.s], b = byId[e.t];
    if (elbow) {
      // parent above child: draw  ┐ shape
      var top = a.y <= b.y ? a : b, bot = top === a ? b : a;
      if (S.direction === 'right') { var l = a.x <= b.x ? a : b, r = l === a ? b : a, mx = (l.x + r.x) / 2; ctx.moveTo(l.x, l.y); ctx.lineTo(mx, l.y); ctx.lineTo(mx, r.y); ctx.lineTo(r.x, r.y); }
      else { var my = (top.y + bot.y) / 2; ctx.moveTo(top.x, top.y); ctx.lineTo(top.x, my); ctx.lineTo(bot.x, my); ctx.lineTo(bot.x, bot.y); }
    } else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  }
}

// ---------- interaction ----------
function nodeAt(sx, sy) {
  var w = toWorld(sx, sy), best = null, bd = Infinity;
  for (var i = 0; i < vis.length; i++) {
    var n = vis[i], dx = n.x - w[0], dy = n.y - w[1], d = dx * dx + dy * dy, r = Math.max((n.r || 5), 6 / view.s);
    if (d < r * r && d < bd) { bd = d; best = n; }
  }
  return best;
}
var down = null, moved = false;
cv.addEventListener('mousedown', function (ev) {
  down = { x: ev.offsetX, y: ev.offsetY, vx: view.x, vy: view.y }; moved = false;
  var n = nodeAt(ev.offsetX, ev.offsetY);
  if (n && S.layout === 'network') { dragNode = n; startSim(); alpha = Math.max(alpha, 0.3); }
  cv.classList.add('dragging');
});
window.addEventListener('mousemove', function (ev) {
  var r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (down) {
    if (Math.abs(x - down.x) + Math.abs(y - down.y) > 3) { moved = true; }
    if (dragNode) { var w = toWorld(x, y); dragNode.x = w[0]; dragNode.y = w[1]; alpha = Math.max(alpha, 0.2); if (!simRunning) { startSim(); } draw(); }
    else { view.x = down.vx + (x - down.x); view.y = down.vy + (y - down.y); draw(); }
    return;
  }
  var n = nodeAt(x, y);
  if (n !== hover) { hover = n; draw(); }
  var tip = document.getElementById('tip');
  if (n) {
    var extra = [];
    if (kin[n.id] !== undefined && S.focus && n.id !== S.focus) { extra.push('Verwandtschaft ' + Math.round(kin[n.id] * 1000) / 10 + ' %'); }
    if (dist[n.id] !== undefined && S.focus && n.id !== S.focus) { extra.push('Abstand ' + dist[n.id]); }
    tip.textContent = (n.i ? n.i + ' ' : '') + n.t + (extra.length ? ' · ' + extra.join(' · ') : '');
    tip.style.display = 'block'; tip.style.left = (x + 14) + 'px'; tip.style.top = (y + 10) + 'px';
    cv.style.cursor = 'pointer';
  } else { tip.style.display = 'none'; cv.style.cursor = ''; }
});
window.addEventListener('mouseup', function (ev) {
  if (!down) { return; }
  cv.classList.remove('dragging');
  var wasDrag = moved; down = null; dragNode = null;
  if (wasDrag) { return; }
  var r = cv.getBoundingClientRect(), n = nodeAt(ev.clientX - r.left, ev.clientY - r.top);
  if (n && (ev.metaKey || ev.ctrlKey)) { post('open', { id: n.id, newTab: true }); return; }
  setFocus(n ? n.id : '');
});
cv.addEventListener('dblclick', function (ev) { var n = nodeAt(ev.offsetX, ev.offsetY); if (n) { post('open', { id: n.id, newTab: false }); } });
cv.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  // pinch (WebKit sends it as ctrl + wheel) or ⌘ + scroll zooms; scrolling pans
  if (ev.ctrlKey || ev.metaKey) { zoomAt(ev.offsetX, ev.offsetY, Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.01))); }
  else { view.x -= ev.deltaX; view.y -= ev.deltaY; draw(); }
}, { passive: false });
function zoomAt(x, y, f) {
  var ns = Math.max(0.02, Math.min(6, view.s * f)); f = ns / view.s;
  view.x = x - (x - view.x) * f; view.y = y - (y - view.y) * f; view.s = ns; draw();
}
var gs = 1;
window.addEventListener('gesturestart', function (e) { e.preventDefault(); gs = 1; });
window.addEventListener('gesturechange', function (e) { e.preventDefault(); zoomAt(W / 2, H / 2, e.scale / gs); gs = e.scale; });

function setFocus(id) {
  S.focus = id || ''; save();
  var needsLayout = (+S.depth > 0) || S.layout === 'radial' || S.colorBy === 'closeness';
  if (needsLayout) { recompute(); } else { computeKinship(); applyStyle(); draw(); }
  renderInfo();
}
function renderInfo() {
  var box = document.getElementById('info'), n = S.focus && byId[S.focus];
  if (!n) { box.style.display = 'none'; return; }
  var meta = [];
  if (n.db && dbById[n.db]) { meta.push('Datenbank: ' + esc(dbById[n.db].name)); }
  meta.push((deg[n.id] || 0) + ' Verbindungen');
  var ps = Object.keys(parentsOf[n.id] || {}).map(nameOf), cs = Object.keys(childrenOf[n.id] || {}).map(nameOf), pa = Object.keys(partnersOf[n.id] || {}).map(nameOf);
  if (ps.length) { meta.push('Eltern: ' + ps.join(', ')); }
  if (pa.length) { meta.push('Partner: ' + pa.join(', ')); }
  if (cs.length) { meta.push('Kinder: ' + cs.slice(0, 12).join(', ') + (cs.length > 12 ? ' …' : '')); }
  box.innerHTML = '<div class="t">' + esc((n.i ? n.i + ' ' : '') + n.t) + '</div><div class="m">' + meta.join('<br>') + '</div>' +
    (STANDALONE ? '' : '<div class="btns"><button class="btn" id="openBtn">Öffnen</button><button class="btn" id="tabBtn">In neuem Tab</button></div>');
  box.style.display = 'block';
  var ob = document.getElementById('openBtn'); if (ob) { ob.onclick = function () { post('open', { id: n.id, newTab: false }); }; }
  var tb = document.getElementById('tabBtn'); if (tb) { tb.onclick = function () { post('open', { id: n.id, newTab: true }); }; }
}
function nameOf(id) { return esc(byId[id] ? byId[id].t : '?'); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function renderLegend() {
  var el = document.getElementById('legend');
  if (!legend.length) { el.style.display = 'none'; return; }
  el.innerHTML = legend.map(function (l) { return '<div><i style="background:' + l[0] + '"></i>' + esc(l[1]) + '</div>'; }).join('');
  el.style.display = 'block';
}

// ---------- panel ----------
function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }
function propOptions(current, types, first) {
  var h = first;
  G.databases.forEach(function (d) {
    var ps = d.props.filter(function (p) { return types.indexOf(p.type) >= 0; });
    if (!ps.length) { return; }
    h += '<optgroup label="' + esc(d.name) + '">';
    ps.forEach(function (p) { var v = 'prop:' + d.id + ':' + p.id; h += opt(v, p.name, current === v); });
    h += '</optgroup>';
  });
  return h;
}
function buildPanel() {
  document.querySelectorAll('#layout button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === S.layout); });
  document.querySelectorAll('#direction button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === S.direction); });
  document.getElementById('direction').style.display = S.layout === 'tree' ? 'flex' : 'none';
  var rels = G.kinds.filter(function (k) { return k.id.indexOf('rel:') === 0; });
  ['parent', 'child', 'partner'].forEach(function (r) {
    var h = opt('', '—', !S.roles[r]);
    rels.forEach(function (k) { h += opt(k.id, k.name, S.roles[r] === k.id); });
    document.getElementById('role-' + r).innerHTML = h;
  });
  document.getElementById('kinds').innerHTML = G.kinds.map(function (k) {
    return '<label class="row"><input type="checkbox" data-k="' + esc(k.id) + '"' + (S.kinds[k.id] !== false ? ' checked' : '') + '><span class="sw" style="background:' + kindColor(k.id) + '"></span><span class="n" title="' + esc(k.name) + '">' + esc(k.name) + '</span></label>';
  }).join('');
  var dbs = [{ id: '_pages', name: 'Seiten (ohne Datenbank)' }].concat(G.databases.filter(function (d) { return nodes.some(function (n) { return n.db === d.id; }); }));
  document.getElementById('dbs').innerHTML = dbs.map(function (d) {
    return '<label class="row"><input type="checkbox" data-db="' + esc(d.id) + '"' + (S.dbs[d.id] !== false ? ' checked' : '') + '><span class="n" title="' + esc(d.name) + '">' + esc(d.name) + '</span></label>';
  }).join('');
  var colorTypes = ['select', 'status', 'multiSelect', 'number', 'date', 'checkbox', 'person', 'uniqueID'];
  document.getElementById('colorBy').innerHTML = propOptions(S.colorBy, colorTypes,
    opt('none', 'Keine', S.colorBy === 'none') + opt('database', 'Datenbank', S.colorBy === 'database') + opt('closeness', 'Nähe zur Auswahl', S.colorBy === 'closeness') + opt('age', 'Zuletzt bearbeitet', S.colorBy === 'age'));
  document.getElementById('sizeBy').innerHTML = propOptions(S.sizeBy, ['number', 'uniqueID'],
    opt('degree', 'Anzahl Verbindungen', S.sizeBy === 'degree') + opt('none', 'Gleich groß', S.sizeBy === 'none'));
  document.getElementById('sortBy').innerHTML = propOptions(S.sortBy, ['select', 'status', 'number', 'date', 'uniqueID', 'checkbox'],
    opt('title', 'Titel', S.sortBy === 'title') + opt('edited', 'Zuletzt bearbeitet', S.sortBy === 'edited'));
  document.getElementById('hideIsolated').checked = !!S.hideIsolated;
  document.getElementById('depth').value = String(S.depth || 0);
  document.getElementById('export').style.display = STANDALONE || window.NO_EXPORT ? 'none' : '';
}
function wire() {
  document.querySelectorAll('#layout button').forEach(function (b) { b.onclick = function () { S.layout = b.dataset.v; pendingFit = true; save(); buildPanel(); recompute(); }; });
  document.querySelectorAll('#direction button').forEach(function (b) { b.onclick = function () { S.direction = b.dataset.v; pendingFit = true; save(); buildPanel(); recompute(); }; });
  ['parent', 'child', 'partner'].forEach(function (r) {
    document.getElementById('role-' + r).onchange = function (e) {
      S.roles[r] = e.target.value;
      if (e.target.value) { S.kinds[e.target.value] = true; }
      if (r !== 'partner' && (S.roles.parent || S.roles.child) && S.layout === 'network') { S.layout = 'tree'; pendingFit = true; }
      save(); buildPanel(); recompute(); renderInfo();
    };
  });
  document.getElementById('kinds').onchange = function (e) { var k = e.target.dataset.k; if (k) { S.kinds[k] = e.target.checked; save(); recompute(); } };
  document.getElementById('dbs').onchange = function (e) { var d = e.target.dataset.db; if (d) { S.dbs[d] = e.target.checked; pendingFit = true; save(); recompute(); } };
  document.getElementById('colorBy').onchange = function (e) { S.colorBy = e.target.value; save(); applyStyle(); draw(); };
  document.getElementById('sizeBy').onchange = function (e) { S.sizeBy = e.target.value; save(); applyStyle(); draw(); };
  document.getElementById('sortBy').onchange = function (e) { S.sortBy = e.target.value; save(); if (S.layout !== 'network') { layout(); } };
  document.getElementById('hideIsolated').onchange = function (e) { S.hideIsolated = e.target.checked; pendingFit = true; save(); recompute(); };
  document.getElementById('depth').onchange = function (e) { S.depth = +e.target.value; pendingFit = true; save(); recompute(); };
  document.getElementById('fit').onclick = fit;
  document.getElementById('clearFocus').onclick = function () { setFocus(''); };
  document.getElementById('export').onclick = function () { post('export', S); };
  document.getElementById('collapse').onclick = function () { var p = document.getElementById('panel'); p.classList.toggle('collapsed'); this.textContent = p.classList.contains('collapsed') ? '+' : '–'; };
  document.getElementById('search').oninput = function (e) {
    var q = e.target.value.trim().toLowerCase();
    if (!q) { matches = null; draw(); return; }
    matches = {}; var first = null;
    vis.forEach(function (n) { if (n.t.toLowerCase().indexOf(q) >= 0) { matches[n.id] = 1; if (!first) { first = n; } } });
    if (first) { view.x = W / 2 - first.x * view.s; view.y = H / 2 - first.y * view.s; }
    draw();
  };
  document.getElementById('search').onkeydown = function (e) {
    if (e.key === 'Enter' && matches) { var id = Object.keys(matches)[0]; if (id) { setFocus(id); } }
    if (e.key === 'Escape') { e.target.value = ''; matches = null; draw(); }
  };
  window.addEventListener('resize', resize);
}

// Live update from the app (keeps positions of pages that stay).
window.updateGraph = function (g) { G = g; index(); buildPanel(); recompute(); renderInfo(); };
window.focusPage = function (id) { setFocus(id); var n = byId[id]; if (n) { view.x = W / 2 - n.x * view.s; view.y = H / 2 - n.y * view.s; draw(); } };

index(); buildPanel(); wire(); resize(); recompute(); renderInfo();
})();
</script>
</body></html>
"""##
}
