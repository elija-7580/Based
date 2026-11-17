// ⌘A wie in Notion: Es werden nur die Blöcke der Seite ausgewählt – nie Titel, Metazeile, Seitenleiste oder sonst
// etwas von der Oberfläche. In einem Eingabefeld markiert ⌘A dessen Text (wie überall); im Seitentitel wählt ein
// zweites ⌘A die Blöcke. Wo es keine Seite gibt (Home, Einstellungen), passiert nichts, statt alles blau zu färben.
export const SELECT_ALL_BLOCKS = "based:select-all-blocks";

const isEditable = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

/** Was ⌘A an dieser Stelle tun soll. */
export function selectAllTarget(target: Element | null, doc: Document): "native" | "blocks" | "nothing" {
  // Dialoge, Menüs und Auswahllisten regeln ihre Tasten selbst; der Block-Editor auch (Text, dann alle Blöcke).
  if (target?.closest("[role='dialog'], [role='menu'], [role='listbox'], [data-testid='block-editor']")) return "native";
  if (isEditable(target)) {
    const field = target as HTMLInputElement | HTMLTextAreaElement;
    const title = target.closest(".page-head") !== null && target.tagName === "TEXTAREA";
    // Titel schon ganz markiert (oder leer): das zweite ⌘A nimmt die Blöcke.
    if (title && field.selectionStart === 0 && field.selectionEnd === field.value.length && doc.querySelector(".page-body [data-testid='block-editor']")) return "blocks";
    return "native";
  }
  return doc.querySelector(".page-body [data-testid='block-editor']") ? "blocks" : "nothing";
}

export function installSelectAll(win: Window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.key.toLowerCase() !== "a" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const doc = win.document;
    const what = selectAllTarget(e.target instanceof Element ? e.target : null, doc);
    if (what === "native") return;
    e.preventDefault();
    if (what !== "blocks") return;
    win.getSelection()?.removeAllRanges();
    doc.querySelector(".page-body [data-testid='block-editor']")?.dispatchEvent(new CustomEvent(SELECT_ALL_BLOCKS));
  };
  win.addEventListener("keydown", onKey);
  return () => win.removeEventListener("keydown", onKey);
}
