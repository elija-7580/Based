// BSD-104 (TS-Port von Swift Store/OrphanRescue.swift, BSD-437): Blöcke, deren Elternteil nach einem Sync fehlt (z. B. die
// Elternseite wurde auf einem Gerät endgültig gelöscht, während ein anderes Gerät ein Kind später bearbeitete: das
// neuere Kind gewinnt gegen den älteren Tombstone, das Elternteil nicht). So ein Block ist im Store, aber nirgends
// erreichbar. `rescueOrphans` macht ihn im Papierkorb sichtbar: Seiten (und Zeilen ohne Datenbank) kommen nach oben
// und in den Papierkorb; andere Blöcke in eine Sammelseite „Recovered blocks“, die selbst im Papierkorb liegt.
// Wiederherstellen bringt sie zurück. Nichts wird gelöscht.
import type { RecordKeyString, WorkspaceStore } from "./store.js";
import type { WireRecord } from "../model/records.js";
import { isPageLike, sortKeys } from "./pages.js";

/** Feste ID der Sammelseite: Geräte, die dieselben Waisen retten, landen bei einer Seite (Last-Writer-Wins). */
export const RECOVERED_BLOCKS_PAGE_ID = "recovered-blocks";

/** Blöcke unter `candidates`, deren Elternblock bzw. Datenbank fehlt (Blöcke darin kommen mit, sind nicht gelistet). */
export function orphanedBlocks(store: WorkspaceStore, candidates: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const b = store.blocks.get(id);
    if (!b || b.parent === "w") continue;
    if (b.parent.startsWith("b:") ? !store.blocks.has(b.parent.slice(2)) : !store.databases.has(b.parent.slice(2))) out.push(id);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Kandidaten nach einem Remote-Stapel: die angekommenen Blöcke und die Kinder angekommener Löschungen. */
export function orphanCandidates(store: WorkspaceStore, records: readonly WireRecord[], deletions: readonly RecordKeyString[]): string[] {
  const ids: string[] = [];
  for (const r of records) if (r.kind === "block") ids.push(r.data.id);
  for (const k of deletions) {
    const i = k.indexOf(":");
    const kind = k.slice(0, i), id = k.slice(i + 1);
    if (kind === "block") ids.push(...store.children("b:" + id));
    else if (kind === "database") ids.push(...store.children("d:" + id));
  }
  return ids;
}

/**
 * Waisen unter `candidates` in den Papierkorb (siehe oben). Eine Transaktion, kein Undo, als lokale Änderung
 * gespeichert (andere Geräte bekommen denselben, sichtbaren Stand). Gibt die geretteten Block-IDs zurück.
 */
export function rescueOrphans(store: WorkspaceStore, candidates: Iterable<string>, now = store.now()): string[] {
  const orphans = orphanedBlocks(store, candidates);
  if (orphans.length === 0 || store.isReadOnly) return [];
  const pages = orphans.filter((id) => isPageLike(store.blocks.get(id)));
  const loose = orphans.filter((id) => !isPageLike(store.blocks.get(id)));
  store.transact("Recover orphaned blocks", (tx) => {
    const topKeys = sortKeys(store, "w", { kind: "end" }, pages.length + (loose.length > 0 && !tx.block(RECOVERED_BLOCKS_PAGE_ID) ? 1 : 0));
    pages.forEach((id, i) => {
      tx.update(id, (b) => {
        b.parent = "w";
        b.sk = topKeys[i]!;
        if (b.props?.teamspace !== undefined) {
          delete b.props.teamspace;
          if (Object.keys(b.props).length === 0) delete b.props;
        }
        if (b.trashedAt === undefined) b.trashedAt = now;
      });
    });
    if (loose.length === 0) return;
    const holder = RECOVERED_BLOCKS_PAGE_ID;
    // Eine vorhandene Sammelseite bleibt, wo sie ist (im Papierkorb oder wohin der Nutzer sie geholt hat).
    if (!tx.block(holder)) {
      tx.put({ kind: "block", data: { id: holder, type: "page", parent: "w", sk: topKeys[pages.length]!, text: "Recovered blocks", createdAt: now, updatedAt: now,
        ...(store.userID != null ? { createdBy: store.userID } : {}), trashedAt: now } });
    }
    const keys = sortKeys(store, "b:" + holder, { kind: "end" }, loose.length);
    loose.forEach((id, i) => tx.update(id, (b) => { b.parent = "b:" + holder; b.sk = keys[i]!; }));
  }, { undoable: false });
  return orphans;
}
