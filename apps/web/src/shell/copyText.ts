// Text in die Zwischenablage – zuverlässig auch in der Mac-Hülle. WKWebView lehnt navigator.clipboard.writeText ab, wenn
// der Klick „zu lange her“ ist (z. B. nach einem await) – darum zuerst das Tauri-Plugin, dann die Web-API, zuletzt der
// alte Weg über ein verstecktes Textfeld (execCommand). false nur, wenn alle drei scheitern.
import { desktopClipboard } from "../desktop.js";

function legacyCopy(text: string): boolean {
  const doc = globalThis.document;
  if (!doc?.body) return false;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  doc.body.appendChild(ta);
  const active = doc.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try { ok = doc.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  const desk = desktopClipboard();
  if (desk) {
    try { await desk.write(text); return true; } catch { /* weiter mit der Web-API */ }
  }
  const clip = globalThis.navigator?.clipboard;
  if (clip) {
    try { await clip.writeText(text); return true; } catch { /* weiter mit dem alten Weg */ }
  }
  return legacyCopy(text);
}
