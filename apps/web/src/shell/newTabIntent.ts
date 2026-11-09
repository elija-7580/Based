// ⌘-Klick / Strg-Klick / Mittelklick öffnet eine Seite in einem neuen Tab – ohne dass jede Komponente (Seitenleiste,
// Breadcrumb, Home, Editor-Links, Datenbank-Zeilen) Modifikatoren durchreichen muss: Ein Listener in der Capture-Phase
// merkt sich für die Dauer des Klicks, dass ein neuer Tab gewünscht ist; `openPage` in der Shell fragt das ab.
// Mittelklick löst im Browser kein `click` aus, nur `auxclick`: Auf Seiten-Verweisen (Liste unten) wird daraus ein
// Klick mit gedrückter Strg-Taste – nie auf beliebigen Knöpfen, damit ein Mittelklick nichts löscht oder anlegt.

const PAGE_LINKS = [
  '[role="treeitem"]',
  ".crumb-link",
  "button.row",
  ".link-button",
  ".qf-item",
  '[role="option"]',
  ".bx-pagelink",
  ".bx-mention",
  ".dbui-card-open",
  ".dbui-relation",
  "[data-page-link]",
].join(",");

let intent = false;
let installed = false;

/** Wurde die laufende Aktion mit ⌘/Strg oder der mittleren Taste ausgelöst? */
export function wantsNewTab(): boolean {
  return intent;
}

function mark() {
  intent = true;
  // bis die Handler dieses Ereignisses gelaufen sind
  setTimeout(() => (intent = false), 0);
}

export function installNewTabIntent(win: Window = window): () => void {
  if (installed) return () => undefined;
  installed = true;
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) mark();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) mark();
  };
  const onDown = (e: MouseEvent) => {
    // Linux: Mittelklick fügt sonst ein / scrollt automatisch
    if (e.button === 1 && e.target instanceof Element && e.target.closest(PAGE_LINKS)) e.preventDefault();
  };
  const onAux = (e: MouseEvent) => {
    if (e.button !== 1 || !(e.target instanceof Element)) return;
    const link = e.target.closest(PAGE_LINKS);
    if (!link || link.closest('[role="tablist"]')) return;
    // Knöpfe in einer Zeile (Aktionen, Aufklappen) nicht auslösen: nur die Zeile selbst bzw. den Verweis
    const button = e.target.closest("button");
    if (button && button !== link && link.contains(button)) return;
    e.preventDefault();
    (e.target as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, clientX: e.clientX, clientY: e.clientY }));
  };
  win.addEventListener("click", onClick, true);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("mousedown", onDown, true);
  win.addEventListener("auxclick", onAux, true);
  return () => {
    installed = false;
    win.removeEventListener("click", onClick, true);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("mousedown", onDown, true);
    win.removeEventListener("auxclick", onAux, true);
  };
}
