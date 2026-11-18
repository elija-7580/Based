// Woran ein „eingebackenes“ Ergebnis (HTML-Rahmen, Mermaid-Bild) merkt, dass es neu gezeichnet werden muss.
// Solche Ergebnisse lesen Schrift und Farben einmal als berechnete Werte; sie folgen den CSS-Variablen der Seite
// danach nicht mehr. Früher hörten sie nur auf `data-theme` – nach Stil Bold → Default (oder Seitenschrift
// Serif → Default) blieb darin die alte Schrift stehen, bis man hell/dunkel umschaltete oder neu lud.

/** Attribute am Wurzelelement, die Tokens ändern (appearance.ts → applyAppearance). */
export const APPEARANCE_ATTRS = ["data-theme", "data-style", "data-density", "data-marker", "data-calm"] as const;
/** Attribute der Seite, die Schrift und Schriftgröße des Inhalts ändern (PageView). */
export const PAGE_FORMAT_ATTRS = ["data-font", "data-small-text"] as const;

const read = (el: Element | null | undefined, attrs: readonly string[]) => attrs.map((a) => el?.getAttribute(a) ?? "-").join("|");

/** Die Seite (oder ein anderer Vorfahr), deren Format für `el` gilt. */
export const formatHost = (el: Element | null | undefined): Element | null => el?.closest("[data-font]") ?? null;

/** Schlüssel: ändert er sich, stimmen eingebackene Schrift oder Farben nicht mehr. */
export function appearanceKey(doc: Document = document, el?: Element | null): string {
  return read(doc.documentElement, APPEARANCE_ATTRS) + "/" + read(formatHost(el), PAGE_FORMAT_ATTRS);
}

/** Ruft `fn`, wenn sich Darstellung (Wurzel), Seitenformat (über `el`) oder Hell/Dunkel des Systems ändern. */
export function watchAppearance(fn: () => void, el?: Element | null, doc: Document = document): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const mo = new MutationObserver(fn);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: [...APPEARANCE_ATTRS] });
  const page = formatHost(el);
  if (page) mo.observe(page, { attributes: true, attributeFilter: [...PAGE_FORMAT_ATTRS] });
  const mq = doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener?.("change", fn);
  return () => {
    mo.disconnect();
    mq?.removeEventListener?.("change", fn);
  };
}
