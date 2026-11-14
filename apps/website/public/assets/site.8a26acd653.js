/*
 * Site glue for basednotes.app: sends waitlist sign-ups and roadmap ideas to the
 * small waitlist service (apps/website/server). Everything else on the page stays
 * in the browser; the personal reply after signing up is written right here and is
 * never sent anywhere.
 */
(function () {
  "use strict";

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit"
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json().catch(function () { return {}; });
    });
  }

  function honeypot(e) {
    var form = e && e.target && e.target.closest ? e.target.closest("form") : null;
    var hp = form ? form.querySelector('input[name="website"]') : null;
    return hp ? hp.value : "";
  }

  var FAILED = "Sorry, that didn't go through, so your address is not saved yet. Please try again in a minute, or write to hello@basednotes.app and I'll add you by hand.";

  window.basedSite = {
    waitlist: function (inst, e) {
      var s = inst.state;
      post("/api/waitlist", { email: s.email, name: s.name || "", role: s.role || "", website: honeypot(e) })
        .catch(function () {
          inst.setState({ reply: FAILED, replyChars: Math.min(inst.state.replyChars, FAILED.length) });
        });
    },
    idea: function (text, area, e) {
      post("/api/ideas", { text: text, area: area, website: honeypot(e) }).catch(function () { /* the idea still shows locally */ });
    }
  };
})();
