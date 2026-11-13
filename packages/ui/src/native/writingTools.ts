// BSD-366: Nichts vom System auch beim Schreiben – macOS Writing Tools (runder Knopf neben markiertem Text), Siri-
// und Inline-Vorschläge (WebKit) sind in Based überall aus. Die Rechtschreibprüfung bleibt (eigene Einstellung).
// `writingsuggestions` vererbt sich (HTML-Standard): am Wurzelelement gesetzt, gilt es für jedes Eingabefeld und
// jedes contenteditable darunter. Felder, die es selbst wieder einschalten, stellt der Beobachter zurück.

const ATTR = "writingsuggestions";

function off(el: Element) {
  if (el.getAttribute(ATTR) !== "false") el.setAttribute(ATTR, "false");
}

/** Schaltet Writing Tools und Schreibvorschläge im Dokument aus; gibt eine Funktion zum Aufheben zurück. */
export function installNoWritingTools(doc: Document = document): () => void {
  off(doc.documentElement);
  if (doc.body) off(doc.body);
  // Nur Elemente, die ausdrücklich „true“ setzen, überschreiben die Vererbung – die werden zurückgestellt.
  const fix = (root: ParentNode) => root.querySelectorAll(`[${ATTR}]:not([${ATTR}="false"])`).forEach(off);
  fix(doc);
  if (typeof MutationObserver === "undefined") return () => undefined;
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.target instanceof Element) off(r.target);
      else r.addedNodes.forEach((n) => { if (n instanceof Element) { if (n.hasAttribute(ATTR)) off(n); fix(n); } });
    }
  });
  mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: [ATTR] });
  return () => mo.disconnect();
}
