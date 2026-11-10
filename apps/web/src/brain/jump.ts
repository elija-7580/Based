// Zitat-Sprung (BSD-61): Seite öffnen, auf den Block warten, hinscrollen und kurz markieren.
import { routeToHash } from "../shell/router.js";

export const CITE_FLASH_MS = 2400;

export function jumpToBlock(pageID: string, blockID?: string, win: Window = window) {
  const hash = "#" + routeToHash({ name: "page", id: pageID });
  if (win.location.hash !== hash) win.location.hash = hash;
  if (!blockID) return;
  const started = Date.now();
  const tick = () => {
    const el = win.document.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(blockID)}"]`);
    if (el) {
      const reduce = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      el.classList.add("brain-cite-target");
      el.setAttribute("data-cite-target", "");
      win.setTimeout(() => {
        el.classList.remove("brain-cite-target");
        el.removeAttribute("data-cite-target");
      }, CITE_FLASH_MS);
      return;
    }
    if (Date.now() - started < 5000) win.setTimeout(tick, 80);
  };
  tick();
}
