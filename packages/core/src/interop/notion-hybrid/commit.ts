// BSD-317: die Store-Seite des Hybrid-Imports. Alles hier ist synchron, idempotent und läuft dort, wo der Store lebt
// (in der App: im Store-Worker). Drei Schritte:
//   1. `commitHybridStructure` – Baum, Datenbanken, Ansichten, Zeilenwerte. Jede Seite merkt sich, woher ihr Inhalt
//      kommt (`importPending`: "zip" | "api"), Notions Bearbeitungszeit und Notions Elternteil.
//   2. `hybridPending` – was noch Inhalt braucht, zuletzt bearbeitete Seiten zuerst. Die Markierung steht an den
//      Seiten selbst: nach einem Neustart ist die Warteschlange einfach wieder da, ohne zweites Buch.
//   3. `commitHybridContent` – Inhalt einer Seite einsetzen und die Markierung löschen. Zweimal dasselbe schreiben
//      ändert nichts (gleiche IDs); eine Seite ohne Markierung wird übersprungen.
// Regeln (Entscheidungen BSD-317): was in Based geändert wurde, gewinnt; nichts wird gelöscht, weil es in Notion fehlt.
import { ZERO_STAMP } from "../../hlc.js";
import type { Block, DatabaseView } from "../../model/records.js";
import { FIRST_KEY, keyBetween } from "../../sortkeys.js";
import { keyOf, type Tx, type WorkspaceStore } from "../../store/store.js";
import { cleanBlock, commitImport, emptyReport, ImportBuilder, type ImportBuilderWire, type ImportReport } from "../builder.js";
import { changedSinceImport, contentFingerprint, derivedID, IMPORT_FINGERPRINT_KEY, importFingerprint } from "../importids.js";
import { SHALLOW_SOURCE_KEY, SHALLOW_TITLE_KEY } from "../notion-html.js";
import type { HybridPageContent } from "./content.js";
import { HYBRID_EDITED_KEY, HYBRID_PARENT_KEY, HYBRID_PENDING_KEY, type HybridDeviation, type HybridPageMeta, type HybridSource, type HybridStructure, type HybridStructureStats } from "./structure.js";

type Extra = Record<string, unknown>;
const extra = (b: Block, key: string): unknown => (b as Extra)[key];
const plain = (t: Block["text"]): string => (typeof t === "string" ? t : (t ?? []).map((r) => r.t ?? "").join(""));
const live = (b: Block | undefined): b is Block => b !== undefined && b.trashedAt === undefined;
const isDBBlock = (b: Block) => b.type === "databasePage" || b.type === "databaseInline";

/** Wartet diese Seite noch auf ihren Inhalt? (Die Oberfläche sperrt sie so lange.) */
export function importPendingSource(b: Block | undefined): HybridSource | undefined {
  const v = b === undefined ? undefined : extra(b, HYBRID_PENDING_KEY);
  return v === "zip" || v === "api" ? v : undefined;
}

// MARK: Struktur

export interface HybridStructureWire {
  builder: ImportBuilderWire;
  zipOnly: ImportBuilderWire | undefined;
  metas: HybridPageMeta[];
  full: boolean;
  deviations: HybridDeviation[];
  stats: HybridStructureStats;
}

export const hybridStructureToWire = (s: HybridStructure): HybridStructureWire =>
  ({ builder: s.builder.toWire(), zipOnly: s.zipOnly?.toWire(), metas: s.metas, full: s.full, deviations: s.deviations, stats: s.stats });

export interface HybridStructureResult {
  report: ImportReport;
  /** Seiten, die jetzt auf Inhalt warten. */
  pending: number;
  deviations: HybridDeviation[];
}

/** Schreibt die Struktur. Vorhandenes bleibt an seinem Platz, außer Notion hat es verschoben. */
export function commitHybridStructure(store: WorkspaceStore, wire: HybridStructureWire, parent = "w"): HybridStructureResult {
  const deviations = [...wire.deviations];
  const metas = new Map(wire.metas.map((m) => [m.id, m]));

  // In Based gelöschte Seiten bleiben gelöscht (mit allem darunter).
  const containerOf = new Map(wire.builder.databases.map((d) => ["d:" + d.id, d.blockID]));
  const dropped = new Set<string>();
  const blocks = wire.builder.blocks.filter((b) => {
    const up = b.parent.startsWith("b:") ? b.parent.slice(2) : containerOf.get(b.parent);
    const existing = store.blocks.get(b.id);
    if ((existing !== undefined && existing.trashedAt !== undefined) || (up !== undefined && dropped.has(up))) { dropped.add(b.id); return false; }
    return true;
  });
  const builder = ImportBuilder.fromWire({
    ...wire.builder, blocks, roots: wire.builder.roots.filter((r) => !dropped.has(r)),
    databases: wire.builder.databases.filter((d) => !dropped.has(d.blockID)), views: wire.builder.views.filter((v) => !dropped.has(v.blockID)),
  }, { now: () => store.now() });

  const ends = new Map<string, string | undefined>();
  const end = (p: string): string => {
    let k = ends.has(p) ? ends.get(p) : (() => { const kids = store.children(p); return kids.length ? store.blocks.get(kids[kids.length - 1]!)?.sk : undefined; })();
    k = keyBetween(k, undefined);
    ends.set(p, k);
    return k;
  };
  const inStore = (p: string) => p === "w" || (p.startsWith("b:") ? live(store.blocks.get(p.slice(2))) : store.databases.has(p.slice(2)));
  const known = (p: string) => inStore(p) || (p.startsWith("b:") ? builder.contains(p.slice(2)) : builder.database(p.slice(2)) !== undefined);
  const unroot = (id: string) => { const i = builder.roots.indexOf(id); if (i >= 0) builder.roots.splice(i, 1); };
  const roots = new Set(builder.roots);
  const localOnly: string[] = [];

  for (const b of builder.blocks) {
    const m = metas.get(b.id);
    if (m === undefined) continue;
    const existing = store.blocks.get(b.id);
    if (live(existing)) {
      const before = extra(existing, HYBRID_PARENT_KEY);
      if (typeof before === "string" && before !== m.parent && known(m.parent)) {
        // In Notion verschoben.
        unroot(b.id);
        b.parent = m.parent;
        b.sk = end(m.parent);
      } else {
        unroot(b.id);
        b.parent = existing.parent;
        b.sk = existing.sk;
      }
      // Format kennt nur der Export (Schrift, volle Breite …) – die API-Fassung darf es nicht löschen.
      const fmt = existing.props?.format;
      if (fmt !== undefined) b.props = { ...(b.props ?? {}), format: { ...fmt, ...(b.props?.format ?? {}) } };
      if (changedSinceImport(existing)) localOnly.push(b.id);
    } else if (roots.has(b.id)) {
      if (m.parent !== "w" && inStore(m.parent)) {
        unroot(b.id);
        b.parent = m.parent;
        b.sk = end(m.parent);
      }
    } else if (inStore(b.parent) && store.children(b.parent).length > 0) {
      b.sk = end(b.parent);
    }
    const x = b as Extra;
    x[HYBRID_PARENT_KEY] = m.parent;
    if (m.edited !== undefined) x[HYBRID_EDITED_KEY] = m.edited;
    if (m.kind === "page" && m.source !== undefined) {
      const loaded = live(existing) && importPendingSource(existing) === undefined && extra(existing, HYBRID_EDITED_KEY) !== undefined;
      const unchanged = loaded && extra(existing!, HYBRID_EDITED_KEY) === m.edited;
      if (!unchanged) x[HYBRID_PENDING_KEY] = m.source;
    }
  }

  const report = builder.isEmpty ? emptyReport() : commitImport(store, builder, parent, "Import from Notion");
  if (builder.isEmpty) report.warnings.push(...builder.report().warnings);

  // Seiten, deren Titel/Eigenschaften in Based geändert wurden, lässt `commitImport` unangetastet (BSD-32). Die
  // Markierungen brauchen sie trotzdem, sonst würde ihr Inhalt nie nachgeladen.
  if (localOnly.length > 0) {
    store.transact("Import from Notion", (tx) => {
      tx.preserveTimestamps = true;
      for (const id of localOnly) {
        const src = builder.block(id) as Extra | undefined;
        if (!src) continue;
        tx.update(id, (b) => {
          const x = b as Extra;
          for (const k of [HYBRID_PARENT_KEY, HYBRID_EDITED_KEY, HYBRID_PENDING_KEY]) if (src[k] !== undefined) x[k] = src[k];
        });
      }
    }, { undoable: false });
  }

  // Nur im ZIP: wie ein gewöhnlicher ZIP-Import, an die Elternseite gehängt.
  if (wire.zipOnly) {
    const z = ImportBuilder.fromWire(wire.zipOnly, { now: () => store.now() });
    for (const b of z.blocks) {
      const m = metas.get(b.id);
      const existing = store.blocks.get(b.id);
      if (live(existing)) { b.parent = existing.parent; b.sk = existing.sk; }
      else if (m?.kind === "zipOnly" && inStore(b.parent)) b.sk = end(b.parent);
    }
    const r = commitImport(store, z, parent, "Import from Notion");
    report.pages += r.pages; report.databases += r.databases; report.rows += r.rows;
    report.keptLocalChanges += r.keptLocalChanges; report.keptLocalAdditions += r.keptLocalAdditions;
    report.warnings.push(...r.warnings.filter((w) => !report.warnings.includes(w)));
    report.rootIDs.push(...r.rootIDs);
  }

  // Voller Lauf: was Based aus Notion kennt, Notion aber nicht mehr zeigt. Bleibt – nur gemeldet.
  if (wire.full) {
    for (const b of store.blocks.values()) {
      if (!live(b) || metas.has(b.id) || extra(b, HYBRID_PARENT_KEY) === undefined) continue;
      if (b.type !== "page" && !isDBBlock(b)) continue;
      deviations.push({ kind: "deletedInNotion", id: b.id, title: plain(b.text) || "Untitled" });
    }
  }
  let pending = 0;
  for (const b of store.blocks.values()) if (live(b) && importPendingSource(b) !== undefined) pending += 1;
  return { report, pending, deviations };
}

// MARK: Warteschlange

export interface HybridPendingPage { id: string; source: HybridSource; updatedAt: number; title: string }

/** Seiten ohne Inhalt, zuletzt bearbeitete zuerst. */
export function hybridPending(store: WorkspaceStore): HybridPendingPage[] {
  const out: HybridPendingPage[] = [];
  for (const b of store.blocks.values()) {
    const source = importPendingSource(b);
    if (source === undefined || !live(b)) continue;
    out.push({ id: b.id, source, updatedAt: b.updatedAt, title: plain(b.text) });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
}

// MARK: Inhalt

export interface HybridContentResult {
  /** Seiten, deren Inhalt geschrieben wurde. */
  pages: number;
  blocks: number;
  /** Seiten, die übersprungen wurden (schon geladen, gelöscht). */
  skipped: number;
  /** Aus dem ZIP nicht lesbar – jetzt für die API vorgemerkt. */
  retryViaApi: string[];
  deviations: HybridDeviation[];
  warnings: string[];
}

const isStubType = (b: Block) => b.type === "page" || isDBBlock(b);

/** Setzt den Inhalt mehrerer Seiten in einem Schritt ein (nicht im Rückgängig-Verlauf: es läuft im Hintergrund). */
export function commitHybridContent(store: WorkspaceStore, batch: readonly HybridPageContent[]): HybridContentResult {
  const res: HybridContentResult = { pages: 0, blocks: 0, skipped: 0, retryViaApi: [], deviations: [], warnings: [] };
  if (batch.length === 0) return res;
  store.transact("Import from Notion", (tx) => {
    tx.preserveTimestamps = true;
    for (const c of batch) writeContent(store, tx, c, res);
  }, { undoable: false });
  return res;
}

function writeContent(store: WorkspaceStore, tx: Tx, c: HybridPageContent, res: HybridContentResult) {
  const P = c.pageID;
  const page = store.blocks.get(P);
  if (!live(page) || importPendingSource(page) === undefined) { res.skipped += 1; return; }
  const title = plain(page.text) || "Untitled";
  if (c.failed !== undefined) {
    res.deviations.push({ kind: "unreadable", id: P, title, detail: c.failed });
    if (c.source === "zip") {
      tx.update(P, (b) => { (b as Extra)[HYBRID_PENDING_KEY] = "api"; });
      res.retryViaApi.push(P);
    } else if (c.gone) {
      tx.update(P, (b) => { delete (b as Extra)[HYBRID_PENDING_KEY]; });
    }
    return;
  }

  // Bestand unter der Seite: Inhalt (wird ersetzt) und Struktur (Unterseiten, Datenbanken – bleiben, werden platziert).
  const region: string[] = [];
  const structural = new Set<string>();
  let conflict = false;
  const stack = [...store.children("b:" + P)];
  while (stack.length) {
    const id = stack.pop()!;
    const b = store.blocks.get(id);
    if (!b) continue;
    if (b.type === "page" || b.type === "databasePage" || (b.type === "databaseInline" && extra(b, HYBRID_PARENT_KEY) !== undefined)) { structural.add(id); continue; }
    region.push(id);
    if (importFingerprint(b) === undefined || changedSinceImport(b)) conflict = true;
    stack.push(...store.children("b:" + id));
  }
  if (conflict) {
    // In Notion und in Based geändert: Based gewinnt, die Seite bleibt unangetastet.
    res.deviations.push({ kind: "conflict", id: P, title });
    tx.update(P, (b) => { delete (b as Extra)[HYBRID_PENDING_KEY]; });
    res.skipped += 1;
    return;
  }

  const incoming = c.builder.blocks.filter((b) => b.id !== P);
  const keep = new Set(incoming.filter((b) => !isStubType(b)).map((b) => b.id));
  for (const id of region) {
    if (keep.has(id)) continue;
    const b = store.blocks.get(id);
    if (b?.type === "databaseInline") for (const v of store.views.values()) if (v.blockID === id) tx.remove(keyOf("view", v.id));
    tx.remove(keyOf("block", id));
  }

  const now = store.now();
  const referenced = new Set<string>();
  const dbTitle = (b: Block) => plain(b.text) || plain(store.databases.get(b.props?.databaseID ?? "")?.title);
  const matchStub = (b: Block): string | undefined => {
    if (structural.has(b.id) && !referenced.has(b.id)) return b.id;
    if (b.type !== "databaseInline") return undefined;
    const src = extra(b, SHALLOW_SOURCE_KEY);
    if (typeof src === "string" && structural.has(src) && !referenced.has(src)) return src;
    const t = extra(b, SHALLOW_TITLE_KEY);
    if (typeof t !== "string" || t === "") return undefined;
    for (const id of structural) {
      const s = store.blocks.get(id);
      if (s && isDBBlock(s) && !referenced.has(id) && dbTitle(s) === t) return id;
    }
    return undefined;
  };
  let lastTop: string | undefined;
  let links = 0;
  for (const src of incoming) {
    if (src.parent === "b:" + P && (lastTop === undefined || src.sk > lastTop)) lastTop = src.sk;
    if (!isStubType(src)) {
      const b = structuredClone(src);
      if (b.createdBy === undefined && store.userID !== null) b.createdBy = store.userID;
      if (b.updatedBy === undefined && b.createdBy !== undefined) b.updatedBy = b.createdBy;
      cleanBlock(b);
      (b as Extra)[IMPORT_FINGERPRINT_KEY] = contentFingerprint(b);
      tx.put({ kind: "block", data: b });
      res.blocks += 1;
      continue;
    }
    const target = matchStub(src);
    if (target !== undefined) {
      referenced.add(target);
      tx.update(target, (b) => { b.parent = src.parent; b.sk = src.sk; });
      continue;
    }
    // Kein eigenes Kind dieser Seite: ein Verweis auf etwas, das woanders liegt.
    const elsewhere = [src.id, extra(src, SHALLOW_SOURCE_KEY)].find((id): id is string => typeof id === "string" && live(store.blocks.get(id)));
    const other = elsewhere !== undefined ? store.blocks.get(elsewhere) : undefined;
    const dbID = other && isDBBlock(other) ? other.props?.databaseID : undefined;
    links += 1;
    if (src.type === "databaseInline" && other && dbID !== undefined && store.databases.has(dbID)) {
      // Verknüpfte Ansicht einer Datenbank, die woanders liegt.
      const id = structural.has(src.id) || store.blocks.has(src.id) ? derivedID(P, "linked", src.id, String(links)) : src.id;
      const vid = derivedID(id, "view");
      const view: DatabaseView = { id: vid, databaseID: dbID, blockID: id, name: "Table", type: "table", sortKey: FIRST_KEY, createdAt: now, updatedAt: now, stamp: { ...ZERO_STAMP } };
      tx.put({ kind: "view", data: view });
      const b: Block = { id, type: "databaseInline", parent: src.parent, sk: src.sk, props: { databaseID: dbID, viewIDs: [vid] }, createdAt: now, updatedAt: now };
      if (store.userID !== null) { b.createdBy = store.userID; b.updatedBy = store.userID; }
      (b as Extra)[IMPORT_FINGERPRINT_KEY] = contentFingerprint(b);
      tx.put({ kind: "block", data: b });
      res.blocks += 1;
    } else if (other) {
      const b: Block = { id: derivedID(P, "link", other.id, String(links)), type: "linkToPage", parent: src.parent, sk: src.sk, props: { linkTarget: other.id }, createdAt: now, updatedAt: now };
      if (store.userID !== null) { b.createdBy = store.userID; b.updatedBy = store.userID; }
      (b as Extra)[IMPORT_FINGERPRINT_KEY] = contentFingerprint(b);
      tx.put({ kind: "block", data: b });
      res.blocks += 1;
    } else {
      const t = extra(src, SHALLOW_TITLE_KEY);
      res.deviations.push({ kind: "unmatchedDatabase", id: P, title, detail: typeof t === "string" ? t : src.type === "page" ? "sub-page" : "database" });
    }
  }
  // Unterseiten und Datenbanken, die der Inhalt nicht nennt: ans Ende der Seite.
  const rest = [...structural].filter((id) => !referenced.has(id)).sort((a, b) => {
    const x = store.blocks.get(a)!, y = store.blocks.get(b)!;
    return x.sk < y.sk ? -1 : x.sk > y.sk ? 1 : a < b ? -1 : 1;
  });
  for (const id of rest) {
    lastTop = keyBetween(lastTop, undefined);
    const k = lastTop;
    tx.update(id, (b) => { b.parent = "b:" + P; b.sk = k; });
  }

  const zipTitle = c.title?.trim();
  if (c.source === "zip" && zipTitle !== undefined && zipTitle !== "" && zipTitle !== plain(page.text).trim() && !changedSinceImport(page)) {
    res.deviations.push({ kind: "titleDiffers", id: P, title, detail: zipTitle });
  }
  tx.update(P, (b) => {
    const x = b as Extra;
    delete x[HYBRID_PENDING_KEY];
    const local = importFingerprint(b) !== undefined && changedSinceImport(b);
    if (c.format !== undefined && !local) {
      b.props = { ...(b.props ?? {}), format: { ...c.format, ...(b.props?.format ?? {}) } };
      if (importFingerprint(b) !== undefined) x[IMPORT_FINGERPRINT_KEY] = contentFingerprint(b);
    }
  });
  res.warnings.push(...c.warnings);
  res.pages += 1;
}
