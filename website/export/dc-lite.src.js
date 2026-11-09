/* dc-lite: tiny runtime for the Based website pages (templates with {{holes}}, sc-for, sc-if, Component class).
   DOM updates via morphdom (MIT, bundled below). */
(function () {
  'use strict';
  class DCLogic {
    constructor(p) { this.props = p || {}; this.state = {}; }
    setState(s) { Object.assign(this.state, typeof s === 'function' ? s(this.state) : s); if (this.__rr) this.__rr(); }
  }
  window.DCLogic = DCLogic;
  const fnCache = new Map();
  function ev(expr, scope) {
    let f = fnCache.get(expr);
    if (!f) { try { f = new Function('s', 'with(s){return (' + expr + ')}'); } catch (e) { f = () => ''; } fnCache.set(expr, f); }
    try { return f(scope); } catch (e) { return ''; }
  }
  function interp(str, scope, raw) {
    const m = str.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
    if (raw && m) return ev(m[1], scope);
    return str.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => { const v = ev(e, scope); return v == null || typeof v === 'object' || typeof v === 'function' ? '' : String(v); });
  }
  const EVT = { onclick: 'click', onsubmit: 'submit', onchange: 'change', oninput: 'change', onkeydown: 'keydown' };
  function build(tpl, vals) {
    const handlers = []; const refs = [];
    function proc(node, scope, out) {
      if (node.nodeType === 3) { out.appendChild(document.createTextNode(interp(node.textContent, scope))); return; }
      if (node.nodeType !== 1) return;
      const tag = node.localName;
      if (tag === 'sc-for') {
        const list = interp(node.getAttribute('list'), scope, true); const as = node.getAttribute('as');
        (Array.isArray(list) ? list : []).forEach((it) => { const sc = Object.create(scope); sc[as] = it; node.childNodes.forEach((c) => proc(c, sc, out)); });
        return;
      }
      if (tag === 'sc-if') { if (interp(node.getAttribute('value'), scope, true)) node.childNodes.forEach((c) => proc(c, scope, out)); return; }
      const el = document.createElementNS(node.namespaceURI, tag);
      let h = null;
      for (const a of node.attributes) {
        const n = a.name.toLowerCase();
        if (n.startsWith('hint-')) continue;
        if (EVT[n]) { const fn = interp(a.value, scope, true); if (typeof fn === 'function') { h = h || {}; h[EVT[n]] = fn; } continue; }
        if (n === 'ref') { const fn = interp(a.value, scope, true); if (typeof fn === 'function') { el.setAttribute('data-ref', refs.length); refs.push(fn); } continue; }
        let v = interp(a.value, scope, true);
        if (v === false || v == null) continue;
        if (v === true) v = '';
        el.setAttribute(a.name === 'data-dc-src' ? 'src' : a.name, typeof v === 'object' || typeof v === 'function' ? '' : String(v));
      }
      if (h) { el.setAttribute('data-on', handlers.length); handlers.push(h); }
      node.childNodes.forEach((c) => proc(c, scope, el));
      out.appendChild(el);
    }
    const root = document.createElement('div');
    const scope = Object.assign(Object.create(null), vals);
    tpl.forEach((c) => proc(c, scope, root));
    return { root, handlers, refs };
  }
  function start() {
    const x = document.querySelector('x-dc'); if (!x) return;
    const helmet = x.querySelector('helmet');
    if (helmet) { [...helmet.childNodes].forEach((n) => document.head.appendChild(n)); helmet.remove(); }
    const sc = document.querySelector('script[data-dc-script]');
    const props = {};
    try { const d = JSON.parse(sc.dataset.props || '{}'); for (const k in d) props[k] = d[k].default; } catch (e) {}
    const C = new Function('DCLogic', sc.textContent + ';return Component')(DCLogic);
    const inst = new C(props);
    const tpl = [...x.childNodes];
    const host = document.createElement('div'); host.id = 'dc-root';
    x.replaceWith(host);
    let handlers = []; let pending = false; let first = true;
    function render() {
      pending = false;
      const out = build(tpl, inst.renderVals());
      handlers = out.handlers;
      if (first) { host.replaceChildren(...out.root.childNodes); first = false; }
      else morphdom(host, out.root, { childrenOnly: true, onBeforeElUpdated: (from, to) => !from.isEqualNode(to) });
      host.querySelectorAll('[data-ref]').forEach((el) => { const fn = out.refs[+el.getAttribute('data-ref')]; if (fn) fn(el); });
    }
    inst.__rr = () => { if (!pending) { pending = true; requestAnimationFrame(render); } };
    ['click', 'submit', 'input', 'change', 'keydown'].forEach((type) => host.addEventListener(type, (e) => {
      const name = type === 'input' ? 'change' : type;
      for (let el = e.target; el && el !== host; el = el.parentElement) {
        const k = el.getAttribute && el.getAttribute('data-on');
        if (k != null) { const fn = handlers[+k] && handlers[+k][name]; if (fn) { fn(e); return; } }
      }
    }));
    render();
    if (inst.componentDidMount) inst.componentDidMount();
    window.addEventListener('pagehide', () => { if (inst.componentWillUnmount) inst.componentWillUnmount(); });
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
