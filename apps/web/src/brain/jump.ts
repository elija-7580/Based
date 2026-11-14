// Zitat-Sprung (BSD-61): Seite öffnen, auf den Block warten, hinscrollen und kurz markieren. Markiert wird mit
// einer Fläche über dem Block (außerhalb des Editors) – Attribute am Editor-DOM würde ProseMirror sofort
// zurücksetzen.
import { routeToHash } from "../shell/router.js";

export const CITE_FLASH_MS = 2400;

export function jumpToBlock(pageID: string, blockID?: string, win: Window = window) {
  const hash = "#" + routeToHash({ name: "page", id: pageID });
  if (win.location.hash !== hash) win.location.hash = hash;
  if (!blockID) return;
  const doc = win.document;
  const started = Date.now();
  const tick = () => {
    // BSD-407 Teil 3: Block-Editor (`.bx2-block`) oder alter Editor (`.bn-block-outer`)
    const q = CSS.escape(blockID);
    const el = doc.querySelector<HTMLElement>(`.bx2-block[data-block-id="${q}"], .bn-block-outer[data-id="${q}"]`);
    if (!el) {
      if (Date.now() - started < 5000) win.setTimeout(tick, 80);
      return;
    }
    const reduce = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    doc.querySelector(".brain-cite-flash")?.remove();
    const flash = doc.createElement("div");
    flash.className = "brain-cite-flash";
    flash.dataset.testid = "cite-flash";
    flash.dataset.block = blockID;
    flash.setAttribute("aria-hidden", "true");
    doc.body.appendChild(flash);
    // Der Block bewegt sich beim Scrollen: die Fläche folgt ihm, bis sie verschwindet.
    const follow = () => {
      if (!flash.isConnected) return;
      const r = el.getBoundingClientRect();
      flash.style.top = `${r.top}px`;
      flash.style.left = `${r.left}px`;
      flash.style.width = `${r.width}px`;
      flash.style.height = `${r.height}px`;
      win.requestAnimationFrame(follow);
    };
    follow();
    win.setTimeout(() => flash.remove(), CITE_FLASH_MS);
  };
  tick();
}
