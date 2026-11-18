// BSD-522: Herkunft beim Schreiben pflegen (Regeln in model/provenance.ts). Läuft am Ende jeder lokalen Transaktion
// (`WorkspaceStore.transact`, nicht für Sync, Importe mit fertigen Stempeln und abgeleitete Y-Änderungen) und ändert
// nur, was sich dadurch ändert – für den Menschen am Gerät meist gar nichts (kein Feld pro Block).
import { authorID, checkOriginChange, contentChanged, originAfterEdit, type Actor, type Author } from "../model/provenance.js";
import type { Block } from "../model/records.js";
import type { RecordKeyString, Tx, WorkspaceStore } from "./store.js";

// Ohne Laufzeit-Import aus store.ts (der Store ruft diese Datei auf).
const blockKey = (id: string) => `block:${id}` as RecordKeyString;

const isPage = (b: Block | undefined) => b?.type === "page" || b?.type === "databasePage";

/** Nächste Seite über einem Block (der Block selbst, wenn er eine Seite ist). */
function pageOf(store: WorkspaceStore, b: Block): Block | undefined {
  const seen = new Set<string>();
  let cur: Block | undefined = b;
  while (cur && !seen.has(cur.id)) {
    if (isPage(cur)) return cur;
    seen.add(cur.id);
    cur = cur.parent.startsWith("b:") ? store.blocks.get(cur.parent.slice(2)) : undefined;
  }
  return undefined;
}

/** Autor in `workspace.authors` eintragen, falls er fehlt oder sich Name/Modell geändert haben. */
function registerAuthor(store: WorkspaceStore, tx: Tx, id: string, a: Author) {
  const ws = store.workspace;
  const known = ws.authors?.[id];
  if (known && known.kind === a.kind && known.name === a.name && known.model === a.model) return;
  const entry: { kind: string; name: string; model?: string; [k: string]: unknown } = { kind: a.kind, name: a.name, ...(a.model ? { model: a.model } : {}) };
  tx.put({ kind: "workspace", data: { ...ws, authors: { ...(ws.authors ?? {}), [id]: entry } } });
}

/** Wendet die Regeln auf alle in `tx` geänderten Blöcke an. */
export function applyProvenance(store: WorkspaceStore, tx: Tx, actor: Actor): void {
  const agentLike = actor !== undefined && actor.kind !== "user";
  const id = agentLike ? authorID(actor) : undefined;
  const pages = new Map<string, boolean>(); // Seite → in dieser Transaktion angelegt
  let touchedAny = false;
  for (const key of [...tx.order]) {
    if (!key.startsWith("block:")) continue;
    const rid = key.slice(6);
    const cur = store.blocks.get(rid);
    if (!cur) continue;
    const prev = tx.before.get(key);
    const before = prev?.kind === "block" ? prev.data : undefined;
    if (!contentChanged(before, cur)) continue;
    touchedAny = true;
    if (id !== undefined) {
      if (cur.author !== id) tx.update(rid, (b) => { b.author = id; });
    } else if (cur.author !== undefined) {
      tx.update(rid, (b) => { delete b.author; });
    }
    const page = pageOf(store, cur);
    if (page && !pages.has(page.id)) {
      const pk = blockKey(page.id);
      pages.set(page.id, tx.before.has(pk) && tx.before.get(pk) === undefined);
    }
  }
  if (!touchedAny) return;
  if (id !== undefined) registerAuthor(store, tx, id, actor!);
  for (const [pid, created] of pages) {
    const page = store.blocks.get(pid);
    if (!page) continue;
    const next = originAfterEdit(page.origin, actor, created);
    if (next !== page.origin) tx.update(pid, (b) => { if (next === undefined) delete b.origin; else b.origin = next; });
  }
}

/** Herkunft einer Seite ausdrücklich setzen (`undefined` = unbekannt). Regeln: `checkOriginChange`. */
export function setPageOrigin(store: WorkspaceStore, pageID: string, origin: string | undefined, actor: Actor = store.actor): void {
  checkOriginChange(origin, actor);
  const page = store.blocks.get(pageID);
  if (!isPage(page)) throw new Error(`No page ${pageID}`);
  store.transact("Set page origin", (tx) => tx.update(pageID, (b) => { if (origin === undefined) delete b.origin; else b.origin = origin; }));
}
