// Opt-in visit statistics with our own Matomo (same server, no cookies, Do Not Track respected).
// Nothing is loaded or sent until the visitor clicks "Allow". The choice stays in localStorage.
(function () {
  "use strict";
  if (window.__DC_PRERENDER) return;

  var KEY = "based-analytics-consent";
  var SITE_ID = "3";
  var loaded = false;

  function store(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } }
  function stored() { try { return localStorage.getItem(KEY); } catch { return null; } }

  function track() {
    var q = (window._paq = window._paq || []);
    if (!loaded) {
      q.push(["disableCookies"]);
      q.push(["setDoNotTrack", true]);
      q.push(["setTrackerUrl", "/matomo.php"]);
      q.push(["setSiteId", SITE_ID]);
    }
    q.push(["setCustomUrl", location.origin + location.pathname]);
    q.push(["trackPageView"]);
    if (loaded) return;
    var s = document.createElement("script");
    s.async = true;
    s.src = "/matomo.js";
    document.head.appendChild(s);
    loaded = true;
  }

  function button(text, primary, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.style.cssText = "font:inherit;padding:7px 14px;border-radius:999px;cursor:pointer;border:1px solid " +
      (primary ? "#141414;background:#141414;color:#fff" : "#c9c9c4;background:#fff;color:#141414");
    b.addEventListener("click", fn);
    return b;
  }

  function render() {
    var old = document.getElementById("bsd-consent");
    if (old) old.remove();
    var box = document.createElement("aside");
    box.id = "bsd-consent";
    box.setAttribute("aria-label", "Privacy settings");
    var base = "position:fixed;z-index:10000;font:14px/1.5 'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,sans-serif;color:#141414;";
    if (stored()) {
      box.style.cssText = base + "left:12px;bottom:12px;";
      var s = button("Privacy settings", false, function () { store(null); render(); });
      s.style.fontSize = "12px";
      s.style.padding = "4px 10px";
      s.style.opacity = ".7";
      box.appendChild(s);
    } else {
      box.style.cssText = base + "right:16px;bottom:16px;width:min(440px,calc(100vw - 32px));padding:16px;background:#fff;" +
        "border:1px solid #e2e2dd;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.12);";
      var p = document.createElement("p");
      p.style.margin = "0 0 12px";
      p.innerHTML = 'May we count your visit? Anonymous statistics with Matomo on our own server in Germany. No cookies, nothing shared. <a href="/privacy#analytics" style="color:inherit">Details</a>';
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
      row.appendChild(button("Allow", true, function () { store("accepted"); track(); render(); }));
      row.appendChild(button("No thanks", false, function () { store("declined"); render(); }));
      box.appendChild(p);
      box.appendChild(row);
    }
    document.body.appendChild(box);
  }

  function start() {
    if (stored() === "accepted") track();
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
