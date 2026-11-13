// BSD-363: „Fetch preview“ am Bookmark – Holen und Übernehmen getrennt behandeln. Wurde der Block während des Ladens
// gelöscht (oder die Seite gewechselt), endet es still, statt „Couldn’t fetch a preview“ zu melden.
import type { BookmarkMeta } from "@based/core";

export interface PreviewDeps {
  fetch: (url: string) => Promise<BookmarkMeta>;
  /** Gibt es den Block (noch)? */
  exists: () => boolean;
  apply: (meta: BookmarkMeta) => void;
  notify: (message: string) => void;
}

export type PreviewOutcome = "applied" | "empty" | "failed" | "gone";

export async function fetchBookmarkPreview(url: string, d: PreviewDeps): Promise<PreviewOutcome> {
  let meta: BookmarkMeta;
  try {
    meta = await d.fetch(url);
  } catch {
    if (!d.exists()) return "gone";
    d.notify("Couldn’t fetch a preview for this link. Check the address and your connection.");
    return "failed";
  }
  if (!d.exists()) return "gone";
  if (Object.keys(meta).length === 0) {
    d.notify("That page didn’t share a title or description.");
    return "empty";
  }
  try {
    d.apply(meta);
  } catch {
    // Block verschwand zwischen Prüfung und Schreiben (anderes Fenster, Sync) – nichts zu melden.
    return "gone";
  }
  return "applied";
}
