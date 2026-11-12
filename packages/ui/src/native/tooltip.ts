// Based-Tooltip statt der Systemblase: jedes `title` im Dokument (auch aus fremden Bausteinen) wandert nach
// `data-tip`; der zugängliche Name bzw. die Beschreibung bleiben über aria-label/aria-description erhalten.
import { place, tipPlan } from "./logic.js";

const SHOW_MS = 450;
/** Kurz nach einem Tooltip erscheint der nächste sofort (Leiste mit vielen Knöpfen). */
const WARM_MS = 400;

function convert(el: Element) {
  const title = el.getAttribute("title");
  if (title === null) return;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const plan = tipPlan({
    title, tag: el.localName, hasLabel: el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"),
    hasText: (el.textContent ?? "").trim() !== "" || el.querySelector("[aria-label], img[alt]:not([alt='']), svg title") !== null,
    isField: field, hasFieldLabel: field && (el.labels?.length ?? 0) > 0,
  });
  if (!plan) { if (el.localName !== "iframe") el.removeAttribute("title"); return; }
  el.removeAttribute("title");
  el.setAttribute("data-tip", plan.tip);
  if (plan.label) el.setAttribute("aria-label", plan.label);
  else if (plan.description && plan.description !== el.getAttribute("aria-label")) el.setAttribute("aria-description", plan.description);
}

function convertTree(root: Node) {
  if (!(root instanceof Element)) return;
  // SVG-Elemente zeigen kein title-Attribut als Blase (dort gibt es <title>-Kinder) – nur HTML.
  if (root instanceof HTMLElement && root.hasAttribute("title")) convert(root);
  for (const el of root.querySelectorAll<HTMLElement>("[title]")) if (el instanceof HTMLElement) convert(el);
}

export function installTooltips(doc: Document = document): () => void {
  const body = doc.body;
  convertTree(body);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") { if (r.target instanceof HTMLElement && r.target.hasAttribute("title")) convert(r.target); }
      else for (const n of r.addedNodes) convertTree(n);
    }
  });
  observer.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

  let tip: HTMLElement | undefined;
  let owner: Element | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHidden = 0;

  const hide = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (tip) { tip.remove(); tip = undefined; lastHidden = Date.now(); }
    owner = undefined;
  };
  const show = (el: Element) => {
    const text = el.getAttribute("data-tip");
    if (!text || !el.isConnected) return;
    tip = doc.createElement("div");
    tip.className = "nf-tip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = text;
    const modal = (() => { try { const m = doc.querySelectorAll<HTMLElement>("dialog:modal"); return m[m.length - 1]; } catch { return undefined; } })();
    (el.closest<HTMLElement>("dialog[open], [popover]") ?? modal ?? body).appendChild(tip);
    try { tip.setAttribute("popover", "manual"); tip.showPopover(); } catch { tip.removeAttribute("popover"); }
    const r = el.getBoundingClientRect();
    const view = doc.defaultView!;
    const at = place({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      { width: tip.offsetWidth, height: tip.offsetHeight }, { width: view.innerWidth, height: view.innerHeight }, { gap: 6, center: true });
    tip.style.left = `${at.left}px`;
    tip.style.top = `${at.top}px`;
  };
  const arm = (el: Element, immediate: boolean) => {
    if (owner === el) return;
    hide();
    owner = el;
    const wait = immediate || Date.now() - lastHidden < WARM_MS ? 0 : SHOW_MS;
    timer = setTimeout(() => { timer = undefined; if (owner === el) show(el); }, wait);
  };
  const onOver = (e: Event) => {
    const el = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
    if (el) arm(el, false); else hide();
  };
  const onFocus = (e: Event) => {
    const el = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
    let visible = false;
    try { visible = el?.matches(":focus-visible") ?? false; } catch { /* alt */ }
    if (el && visible) arm(el, true);
  };
  const events: [string, EventListener, boolean][] = [
    ["mouseover", onOver, false], ["focusin", onFocus, false], ["focusout", hide, false], ["mousedown", hide, true], ["keydown", hide, true],
    ["scroll", hide, true], ["wheel", hide, true], ["contextmenu", hide, true],
  ];
  for (const [type, fn, capture] of events) doc.addEventListener(type, fn, { capture, passive: true });
  doc.documentElement.addEventListener("mouseleave", hide);
  doc.defaultView?.addEventListener("blur", hide);
  return () => {
    observer.disconnect();
    hide();
    for (const [type, fn, capture] of events) doc.removeEventListener(type, fn, { capture });
    doc.documentElement.removeEventListener("mouseleave", hide);
    doc.defaultView?.removeEventListener("blur", hide);
  };
}
