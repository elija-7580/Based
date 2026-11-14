/*
 * dc-lite: a tiny runtime for the Based website pages.
 *
 * The pages were designed as "Design Component" artboards: plain HTML with
 * {{holes}}, <sc-for>, <sc-if>, onClick="{{fn}}" and a `class Component extends
 * DCLogic` that holds state. This file renders exactly that subset, without a
 * framework: the template is turned into fresh DOM on every state change and
 * morphed into the live DOM, so running CSS animations, focus and scroll stay put.
 *
 * Pages are prerendered at build time (scripts/build.mjs); in the browser the
 * first render "hydrates" by morphing onto the prerendered markup.
 */
(function () {
  "use strict";

  var EVENTS = { onclick: "click", onsubmit: "submit", onchange: "input", oninput: "input", onkeydown: "keydown" };

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === "function" ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next);
    if (this.__schedule) this.__schedule();
  };
  window.DCLogic = DCLogic;

  function lookup(expr, scopes) {
    expr = expr.trim();
    if (expr === "true") return true;
    if (expr === "false") return false;
    var parts = expr.split(".");
    for (var i = scopes.length - 1; i >= 0; i--) {
      var s = scopes[i];
      if (s != null && Object.prototype.hasOwnProperty.call(s, parts[0])) {
        var v = s[parts[0]];
        for (var j = 1; j < parts.length && v != null; j++) v = v[parts[j]];
        return v;
      }
    }
    return undefined;
  }

  var HOLE = /\{\{([^}]*)\}\}/g;
  var SINGLE = /^\s*\{\{([^}]*)\}\}\s*$/;

  function interpolate(text, scopes) {
    if (text.indexOf("{{") < 0) return text;
    return text.replace(HOLE, function (_, e) {
      var v = lookup(e, scopes);
      return v == null || v === false ? "" : String(v);
    });
  }

  function build(tplNode, scopes, out, doc) {
    for (var n = tplNode.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        out.appendChild(doc.createTextNode(interpolate(n.nodeValue, scopes)));
        continue;
      }
      if (n.nodeType !== 1) continue;
      var tag = n.localName;
      if (tag === "sc-for") {
        var list = lookup((n.getAttribute("list") || "").replace(/^\s*\{\{|\}\}\s*$/g, ""), scopes) || [];
        var as = n.getAttribute("as") || "item";
        for (var i = 0; i < list.length; i++) {
          var scope = {};
          scope[as] = list[i];
          scope[as + "Index"] = i;
          build(n, scopes.concat([scope]), out, doc);
        }
        continue;
      }
      if (tag === "sc-if") {
        var cond = lookup((n.getAttribute("value") || "").replace(/^\s*\{\{|\}\}\s*$/g, ""), scopes);
        if (cond) build(n, scopes, out, doc);
        continue;
      }
      var el = n.namespaceURI && n.namespaceURI !== "http://www.w3.org/1999/xhtml"
        ? doc.createElementNS(n.namespaceURI, n.localName)
        : doc.createElement(tag);
      for (var a = 0; a < n.attributes.length; a++) {
        var at = n.attributes[a];
        var name = at.name;
        if (name.indexOf("hint-placeholder") === 0) continue;
        var single = SINGLE.exec(at.value);
        if (EVENTS[name] && single) {
          var fn = lookup(single[1], scopes);
          if (typeof fn === "function") (el.__h || (el.__h = {}))[EVENTS[name]] = fn;
          continue;
        }
        if (name === "ref" && single) {
          var rf = lookup(single[1], scopes);
          if (typeof rf === "function") el.__ref = rf;
          continue;
        }
        if (name === "value" && single && (tag === "input" || tag === "textarea")) {
          var val = lookup(single[1], scopes);
          el.__value = val == null ? "" : String(val);
          el.setAttribute("value", el.__value);
          continue;
        }
        if (at.namespaceURI) el.setAttributeNS(at.namespaceURI, name, interpolate(at.value, scopes));
        else el.setAttribute(name, interpolate(at.value, scopes));
      }
      var target = tag === "template" ? el.content : el;
      build(n.content || n, scopes, target, doc);
      out.appendChild(el);
    }
  }

  function sameNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    return a.localName === b.localName && a.namespaceURI === b.namespaceURI;
  }

  function syncAttrs(live, fresh) {
    var i, at;
    for (i = live.attributes.length - 1; i >= 0; i--) {
      at = live.attributes[i];
      if (!fresh.hasAttribute(at.name)) {
        // <details open> is user state (the mobile menu); keep it.
        if (at.name === "open" && live.localName === "details") continue;
        live.removeAttribute(at.name);
      }
    }
    for (i = 0; i < fresh.attributes.length; i++) {
      at = fresh.attributes[i];
      if (live.getAttribute(at.name) !== at.value) live.setAttribute(at.name, at.value);
    }
  }

  function morph(live, fresh, refs) {
    if (live.nodeType === 1) {
      syncAttrs(live, fresh);
      live.__h = fresh.__h;
      if (fresh.__value !== undefined && live.value !== fresh.__value) live.value = fresh.__value;
      if (fresh.__ref) refs.push([fresh.__ref, live]);
    } else if (live.nodeValue !== fresh.nodeValue) {
      live.nodeValue = fresh.nodeValue;
      return;
    }
    morphChildren(live, fresh, refs);
  }

  function morphChildren(live, fresh, refs) {
    var l = live.firstChild;
    var f = fresh.firstChild;
    while (f) {
      var nextF = f.nextSibling;
      if (!l) {
        live.appendChild(f);
        collectRefs(f, refs);
      } else if (sameNode(l, f)) {
        morph(l, f, refs);
        l = l.nextSibling;
      } else {
        var nextL = l.nextSibling;
        live.replaceChild(f, l);
        collectRefs(f, refs);
        l = nextL;
      }
      f = nextF;
    }
    while (l) {
      var rm = l;
      l = l.nextSibling;
      live.removeChild(rm);
    }
  }

  function collectRefs(node, refs) {
    if (node.nodeType !== 1) return;
    if (node.__value !== undefined) node.value = node.__value;
    if (node.__ref) refs.push([node.__ref, node]);
    for (var c = node.firstChild; c; c = c.nextSibling) collectRefs(c, refs);
  }

  function dispatch(root) {
    function handle(e) {
      for (var el = e.target; el && el !== root.parentNode; el = el.parentNode) {
        if (el.__h && el.__h[e.type]) {
          el.__h[e.type].call(null, e);
          return;
        }
      }
    }
    ["click", "submit", "input", "keydown"].forEach(function (t) { root.addEventListener(t, handle); });
  }

  function readProps(meta) {
    var props = {};
    var decl = meta.props || {};
    Object.keys(decl).forEach(function (k) {
      if (k.charAt(0) !== "$" && decl[k] && "default" in decl[k]) props[k] = decl[k]["default"];
    });
    return props;
  }

  function mount(meta, root) {
    var tpl = document.getElementById(meta.template);
    var Component = meta.make(DCLogic);
    var props = readProps(meta);
    props.theme = "light"; // the site is light only (no dark mode)
    var inst = new Component(props);
    inst.props = props;
    var queued = false;
    function render() {
      queued = false;
      var vals;
      try { vals = inst.renderVals(); } catch (err) { console.error(err); return; }
      var frag = document.createDocumentFragment();
      build(tpl.content, [vals], frag, document);
      var refs = [];
      morphChildren(root, frag, refs);
      refs.forEach(function (r) { r[0](r[1]); });
    }
    inst.__schedule = function () {
      if (queued) return;
      queued = true;
      (window.requestAnimationFrame || setTimeout)(render);
    };
    render();
    dispatch(root);
    if (!window.__DC_PRERENDER && typeof inst.componentDidMount === "function") inst.componentDidMount();
    return inst;
  }

  function pick() {
    var pages = window.__dcPages || [];
    var narrow = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
    var wantsDesktop = /[?&]desktop\b/.test(location.search);
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].mobile && narrow && !wantsDesktop && !window.__DC_PRERENDER) return pages[i];
    }
    for (var j = 0; j < pages.length; j++) if (!pages[j].mobile) return pages[j];
    return pages[0];
  }

  function start() {
    var root = document.getElementById("dc-root");
    var meta = pick();
    if (!root || !meta) return;
    mount(meta, root);
    document.documentElement.setAttribute("data-dc-ready", "1");
    // Anchors in prerendered/updated markup: honour #hash after the first render.
    if (location.hash && !window.__DC_PRERENDER) {
      var t = document.getElementById(location.hash.slice(1));
      if (t) t.scrollIntoView();
    }
  }

  window.DCLite = { start: start, lookup: lookup };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
