// Sammelt einen importierten Teilbaum (Blöcke, Datenbanken, Ansichten, Dateien) und schreibt ihn in einer
// Transaktion (`commitImport`). Port von Swift Interop/ImportBuilder.swift und NotionImport.swift (`ImportReport`).
// Records behalten ihre Quell-IDs: ein zweiter Import derselben Seite aktualisiert sie an Ort und Stelle; was in Based
// seitdem geändert oder hinzugefügt wurde, bleibt (Reimport-Schutz, BSD-32).
import type { Block, BlockProps, Database, DatabaseView, PropertyValue, RichText } from "../model/records.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { keyOf, type Tx, type WorkspaceStore } from "../store/store.js";
import { changedSinceImport, contentFingerprint, IMPORT_FINGERPRINT_KEY, importFingerprint } from "./importids.js";

export type AssetRef = NonNullable<BlockProps["asset"]>;
type FileValue = { name: string; asset?: AssetRef; url?: string };

export interface ImportReport {
  pages: number;
  databases: number;
  rows: number;
  assets: number;
  warnings: string[];
  rootIDs: string[];
  /** BSD-32 (Reimport): in Based geänderte Blöcke, die so bleiben. */
  keptLocalChanges: number;
  /** BSD-32 (Reimport): in Based hinzugefügte Blöcke unter importierten Seiten, die bleiben. */
  keptLocalAdditions: number;
}

export const emptyReport = (): ImportReport => ({ pages: 0, databases: 0, rows: 0, assets: 0, warnings: [], rootIDs: [], keptLocalChanges: 0, keptLocalAdditions: 0 });

/** Wohin importierte Dateien kommen (Swift `AssetStore`). Synchron, damit der Import in einem Worker durchläuft; die
 * Shell speichert die gesammelten Bytes danach (z. B. OPFS/IndexedDB). */
export interface AssetSink {
  importData(data: Uint8Array, name: string, mime: string | undefined): AssetRef;
}

/** Sammelt Dateien im Speicher (ID wie Swift `FileAssetStore`: zufällige UUID). */
export class MemoryAssetSink implements AssetSink {
  readonly files = new Map<string, { ref: AssetRef; data: Uint8Array }>();
  constructor(private readonly makeID: (data: Uint8Array, name: string) => string = () => globalThis.crypto.randomUUID().toLowerCase()) {}
  importData(data: Uint8Array, name: string, mime: string | undefined): AssetRef {
    const n = name === "" ? "file" : name;
    const ref: AssetRef = { id: this.makeID(data, n), name: n, size: data.length };
    const m = mime ?? mimeFor(extensionOf(n));
    if (m !== undefined) ref.mime = m;
    this.files.set(ref.id, { ref, data });
    return ref;
  }
}

/** Eine Datei, die der Speicher nicht annimmt; die Meldung steht im Import-Bericht. */
export class AssetRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetRejected";
  }
}

/** Größenlimit je Datei beim Import (100 MB). */
export const DEFAULT_MAX_ASSET_BYTES = 100 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Lässt nur Dateien bis `maxBytes` durch; größere werden abgelehnt (`AssetRejected`) und in `skipped` gemerkt. */
export class LimitedAssetSink implements AssetSink {
  readonly skipped: { name: string; size: number }[] = [];
  constructor(private readonly inner: AssetSink, readonly maxBytes: number = DEFAULT_MAX_ASSET_BYTES) {}
  importData(data: Uint8Array, name: string, mime: string | undefined): AssetRef {
    if (data.length > this.maxBytes) {
      this.skipped.push({ name, size: data.length });
      throw new AssetRejected(`Skipped “${name}” (${formatBytes(data.length)}): larger than the ${formatBytes(this.maxBytes)} limit for attached files`);
    }
    return this.inner.importData(data, name, mime);
  }
}

/** Sieht ein `src`/`href` wie eine Datei aus dem Export aus (relativer Pfad mit Endung)? Für „fehlt“-Warnungen. */
export function looksLikeLocalFile(src: string): boolean {
  if (src === "" || src.startsWith("#") || src.startsWith("data:") || src.startsWith("mailto:") || src.includes("://") || /^[a-z][a-z0-9+.-]*:/i.test(src)) return false;
  const path = src.split(/[?#]/)[0]!;
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}

const extensionOf = (name: string) => { const i = name.lastIndexOf("."); return i <= 0 ? "" : name.slice(i + 1); };

/** MIME-Typ einer Endung (Swift `FileAssetStore.mime(for:)`). */
export function mimeFor(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    case "svg": return "image/svg+xml";
    case "pdf": return "application/pdf";
    case "mp4": case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "mp3": return "audio/mpeg";
    case "m4a": return "audio/mp4";
    case "wav": return "audio/wav";
    case "txt": case "md": return "text/plain";
    case "csv": return "text/csv";
    case "zip": return "application/zip";
    default: return undefined;
  }
}

/** Swift `RecordIDs.make()`. */
export const makeRecordID = () => globalThis.crypto.randomUUID().toLowerCase();

const swiftNow = () => (Date.now() - 978_307_200_000) / 1000;

function isEmptyRichText(t: RichText | undefined): boolean {
  return t === undefined || (typeof t === "string" ? t.length === 0 : t.every((r) => !r.t));
}

/** Entfernt leere Felder so, wie Swift sie beim Kodieren weglässt (Text, Eigenschaften, Werte, `undefined`). */
export function cleanBlock(b: Block): Block {
  if (isEmptyRichText(b.text)) delete b.text;
  if (b.props) {
    for (const k of Object.keys(b.props)) if ((b.props as Record<string, unknown>)[k] === undefined) delete (b.props as Record<string, unknown>)[k];
    if (Object.keys(b.props).length === 0) delete b.props;
  }
  if (b.values) {
    for (const k of Object.keys(b.values)) if (b.values[k] === undefined) delete b.values[k];
    if (Object.keys(b.values).length === 0) delete b.values;
  }
  for (const k of ["createdBy", "updatedBy", "trashedAt"] as const) if (b[k] === undefined) delete b[k];
  return b;
}

export interface NewBlock {
  id: string;
  type: string;
  parent: string;
  sk?: string | undefined;
  text?: RichText | undefined;
  props?: BlockProps | undefined;
  values?: Record<string, PropertyValue> | undefined;
  createdAt?: number | undefined;
  createdBy?: string | null | undefined;
}

/** Ein Block wie Swift `Block(id:type:parent:sortKey:text:props:values:createdAt:createdBy:)`. */
export function makeBlock(x: NewBlock, now: number): Block {
  const createdAt = x.createdAt ?? now;
  const b: Block = { id: x.id, type: x.type as Block["type"], parent: x.parent, sk: x.sk ?? "", createdAt, updatedAt: createdAt };
  if (x.text !== undefined) b.text = x.text;
  if (x.props !== undefined) b.props = { ...x.props };
  if (x.values !== undefined) b.values = { ...x.values };
  if (x.createdBy != null) { b.createdBy = x.createdBy; b.updatedBy = x.createdBy; }
  return cleanBlock(b);
}

interface Pending { name: string; mime: string | undefined; data?: Uint8Array; load?: () => Uint8Array | undefined }

/** `ImportBuilder` als reine Daten (`toWire`/`fromWire`). */
export interface ImportBuilderWire {
  blocks: Block[];
  databases: Database[];
  views: DatabaseView[];
  roots: string[];
  complete: string[];
  warnings: string[];
  notes: string[];
  pendingAssets: [string, Pending][];
  storedAssets: number;
  createdBy: string | null;
}

export interface ImportBuilderOptions {
  createdBy?: string | null | undefined;
  /** Zeit für neue Blöcke (Swift-Datum); Standard: jetzt. */
  now?: (() => number) | undefined;
}

export class ImportBuilder {
  readonly blocks: Block[] = [];
  private readonly index = new Map<string, number>();
  readonly databases: Database[] = [];
  private readonly dbIndex = new Map<string, number>();
  readonly views: DatabaseView[] = [];
  private readonly viewIndex = new Map<string, number>();
  /** Einträge der obersten Ebene in Reihenfolge; ihr Elternteil bestimmt `commitImport`. */
  readonly roots: string[] = [];
  warnings: string[] = [];
  notes: string[] = [];
  /** Container, deren ganzer Inhalt Teil dieses Imports ist (beim Reimport wird Veraltetes entfernt). */
  readonly complete = new Set<string>();
  private readonly lastKey = new Map<string, string>();
  /** Platzhalter-Asset-ID → Datei, die `resolveAssets` in den Asset-Speicher kopiert. */
  readonly pendingAssets = new Map<string, Pending>();
  private readonly assetByPath = new Map<string, AssetRef>();
  storedAssets = 0;
  createdBy: string | null;
  readonly now: () => number;

  constructor(opts: ImportBuilderOptions = {}) {
    this.createdBy = opts.createdBy === undefined ? "me" : opts.createdBy;
    this.now = opts.now ?? swiftNow;
  }

  get isEmpty() { return this.blocks.length === 0 && this.databases.length === 0; }

  // MARK: Blöcke

  contains(id: string) { return this.index.has(id); }
  block(id: string): Block | undefined { const i = this.index.get(id); return i === undefined ? undefined : this.blocks[i]; }

  update(id: string, f: (b: Block) => void) {
    const i = this.index.get(id);
    if (i === undefined) return;
    f(this.blocks[i]!);
    cleanBlock(this.blocks[i]!);
  }

  private nextKey(parent: string): string {
    const k = keyBetween(this.lastKey.get(parent), undefined);
    this.lastKey.set(parent, k);
    return k;
  }

  /** Fügt einen Block nach seinen Geschwistern an; `root`-Blöcke platziert `commitImport`. Gleiche ID ersetzt die frühere Kopie an ihrem Platz. */
  add(block: Block, root = false): string {
    const b = cleanBlock({ ...block });
    if (b.createdBy === undefined) {
      if (this.createdBy !== null) b.createdBy = this.createdBy;
      const ub = b.updatedBy ?? this.createdBy;
      if (ub !== null && ub !== undefined) b.updatedBy = ub; else delete b.updatedBy;
    }
    const i = this.index.get(b.id);
    if (i !== undefined) {
      if (b.parent === this.blocks[i]!.parent || root) b.sk = this.blocks[i]!.sk;
      else if (b.sk === "") b.sk = this.nextKey(b.parent);
      this.blocks[i] = b;
      return b.id;
    }
    if (root) {
      if (!this.roots.includes(b.id)) this.roots.push(b.id);
      if (b.sk === "") b.sk = "a0";
    } else if (b.sk === "") b.sk = this.nextKey(b.parent);
    this.index.set(b.id, this.blocks.length);
    this.blocks.push(b);
    return b.id;
  }

  /** Neuen Block vom Typ `type` unter `parent` anhängen. */
  append(type: string, parent: string, opts: { id?: string | undefined; text?: RichText | undefined; props?: BlockProps | undefined; values?: Record<string, PropertyValue> | undefined; createdAt?: number | undefined } = {}): string {
    const b = makeBlock({ id: opts.id ?? makeRecordID(), type, parent, sk: "", text: opts.text, props: opts.props, values: opts.values,
      createdAt: opts.createdAt, createdBy: this.createdBy }, this.now());
    return this.add(b);
  }

  /** Einen Container (Seite, Block, Datenbank) als vollständig importiert markieren (`b:<id>`, `d:<id>`). */
  markComplete(parent: string) { this.complete.add(parent); }

  /** Verschiebt einen Block ans Ende eines anderen Elternteils. */
  reparent(id: string, parent: string) {
    const i = this.index.get(id);
    if (i === undefined) return;
    const b = this.blocks[i]!;
    b.parent = parent;
    b.sk = this.nextKey(parent);
    const r = this.roots.indexOf(id);
    if (r >= 0) this.roots.splice(r, 1);
  }

  // MARK: Datenbanken und Ansichten

  database(id: string): Database | undefined { const i = this.dbIndex.get(id); return i === undefined ? undefined : this.databases[i]; }

  addDatabase(d: Database) {
    const i = this.dbIndex.get(d.id);
    if (i !== undefined) { this.databases[i] = d; return; }
    this.dbIndex.set(d.id, this.databases.length);
    this.databases.push(d);
  }

  updateDatabase(id: string, f: (d: Database) => void) {
    const i = this.dbIndex.get(id);
    if (i !== undefined) f(this.databases[i]!);
  }

  view(id: string): DatabaseView | undefined { const i = this.viewIndex.get(id); return i === undefined ? undefined : this.views[i]; }

  addView(v: DatabaseView) {
    const i = this.viewIndex.get(v.id);
    if (i !== undefined) { this.views[i] = v; return; }
    this.viewIndex.set(v.id, this.views.length);
    this.views.push(v);
  }

  // MARK: Dateien

  /** Platzhalter für eine Datei (`key`: Pfad, damit dieselbe Datei nur einmal kopiert wird). */
  asset(key: string, data: Uint8Array, name: string, mime?: string): AssetRef {
    const known = this.assetByPath.get(key);
    if (known) return known;
    const ref: AssetRef = { id: "pending-" + makeRecordID(), name, size: data.length };
    const m = mime ?? mimeFor(extensionOf(name));
    if (m !== undefined) ref.mime = m;
    this.pendingAssets.set(ref.id, { name, mime: m, data });
    this.assetByPath.set(key, ref);
    return ref;
  }

  /** BSD-254: wie `asset`, aber die Bytes werden erst in `resolveAssets` gelesen. */
  assetLazy(key: string, size: number, load: () => Uint8Array | undefined, name: string, mime?: string): AssetRef {
    const known = this.assetByPath.get(key);
    if (known) return known;
    const ref: AssetRef = { id: "pending-" + makeRecordID(), name, size };
    const m = mime ?? mimeFor(extensionOf(name));
    if (m !== undefined) ref.mime = m;
    this.pendingAssets.set(ref.id, { name, mime: m, load });
    this.assetByPath.set(key, ref);
    return ref;
  }

  /** Kopiert die Dateien in den Asset-Speicher und ersetzt alle Platzhalter. Ohne Speicher entfallen die Verweise. */
  resolveAssets(sink: AssetSink | undefined): number {
    if (this.pendingAssets.size === 0) return 0;
    const map = new Map<string, AssetRef>();
    if (sink) {
      for (const [id, f] of this.pendingAssets) {
        try {
          const data = f.data ?? f.load?.();
          if (data === undefined) throw new Error("unreadable");
          map.set(id, sink.importData(data, f.name, f.mime));
        } catch (e) {
          this.warnings.push(e instanceof AssetRejected ? e.message : `Couldn't copy file ${f.name}`);
        }
      }
    }
    const fix = (a: AssetRef | undefined) => (a === undefined || !a.id.startsWith("pending-") ? a : map.get(a.id));
    for (const b of this.blocks) {
      const p = b.props;
      if (p) {
        if (p.asset && p.asset.id.startsWith("pending-")) {
          const r = fix(p.asset);
          if (r) p.asset = r; else delete p.asset;
        }
        const icon = p.icon as { asset?: AssetRef } | string | undefined;
        if (icon && typeof icon === "object" && icon.asset) {
          const r = fix(icon.asset);
          if (r) p.icon = { asset: r }; else delete p.icon;
        }
        const cover = p.cover as { asset?: { _0: AssetRef } } | undefined;
        if (cover && cover.asset) {
          const r = fix(cover.asset._0);
          if (r) p.cover = { asset: { _0: r } }; else delete p.cover;
        }
      }
      for (const [k, v] of Object.entries(b.values ?? {})) {
        const files = (v as { files?: { _0: FileValue[] } }).files?._0;
        if (files && files.some((f) => f.asset?.id.startsWith("pending-"))) {
          b.values![k] = { files: { _0: files.map((f) => {
            if (!f.asset?.id.startsWith("pending-")) return f;
            const r = map.get(f.asset.id);
            const out: FileValue = { name: f.name };
            if (r) out.asset = r;
            if (f.url !== undefined) out.url = f.url;
            return out;
          }) } } as PropertyValue;
        }
      }
      cleanBlock(b);
    }
    this.pendingAssets.clear();
    this.assetByPath.clear();
    this.storedAssets += map.size;
    return map.size;
  }

  // MARK: Zwischen Workern

  /** Strukturiert klonbarer Stand (z. B. Vorbereitung in einem Import-Worker, Schreiben im Store-Worker). */
  toWire(): ImportBuilderWire {
    return {
      blocks: this.blocks, databases: this.databases, views: this.views, roots: this.roots, complete: [...this.complete],
      warnings: this.warnings, notes: this.notes, pendingAssets: [...this.pendingAssets].map(([id, f]): [string, Pending] => [id, { name: f.name, mime: f.mime, data: f.data ?? f.load?.() ?? new Uint8Array(0) }]), storedAssets: this.storedAssets, createdBy: this.createdBy,
    };
  }

  /** Gegenstück zu `toWire` (Reihenfolge, Wurzeln und Platzhalter-Dateien bleiben). */
  static fromWire(w: ImportBuilderWire, opts: ImportBuilderOptions = {}): ImportBuilder {
    const b = new ImportBuilder({ ...opts, createdBy: w.createdBy });
    for (const x of w.blocks) { b.index.set(x.id, b.blocks.length); b.blocks.push(x); }
    for (const d of w.databases) { b.dbIndex.set(d.id, b.databases.length); b.databases.push(d); }
    for (const v of w.views) { b.viewIndex.set(v.id, b.views.length); b.views.push(v); }
    b.roots.push(...w.roots);
    for (const c of w.complete) b.complete.add(c);
    b.warnings = [...w.warnings];
    b.notes = [...w.notes];
    for (const [id, p] of w.pendingAssets) b.pendingAssets.set(id, p);
    b.storedAssets = w.storedAssets;
    return b;
  }

  // MARK: Bericht

  report(): ImportReport {
    const r = emptyReport();
    const dbIDs = new Set(this.databases.map((d) => d.id));
    for (const b of this.blocks) {
      if (b.type !== "page") continue;
      if (b.parent.startsWith("d:") && dbIDs.has(b.parent.slice(2))) r.rows += 1; else r.pages += 1;
    }
    r.databases = this.databases.length;
    r.warnings = [...this.notes, ...this.warnings];
    r.rootIDs = [...this.roots];
    return r;
  }
}

// MARK: Schreiben (Swift `WorkspaceStore.commitImport`)

const isPageLike = (b: Block) => b.type === "page" || b.type === "databasePage";

function ownsDatabase(store: WorkspaceStore, b: Block): boolean {
  const db = b.props?.databaseID;
  return db !== undefined && store.databases.get(db)?.blockID === b.id;
}

/** Seite oder eigene Datenbank (kommt in den Papierkorb statt gelöscht zu werden). */
function isTrashable(store: WorkspaceStore, b: Block): boolean {
  return isPageLike(b) || ((b.type === "databaseInline" || b.type === "databasePage") && ownsDatabase(store, b));
}

function parentExists(store: WorkspaceStore, p: string): boolean {
  if (p === "w") return true;
  if (p.startsWith("b:")) { const b = store.blocks.get(p.slice(2)); return b !== undefined && b.trashedAt === undefined; }
  return store.databases.has(p.slice(2));
}

function viewIDsForBlock(store: WorkspaceStore, id: string): string[] {
  return [...store.views.values()].filter((v) => v.blockID === id).map((v) => v.id);
}

function containingPage(store: WorkspaceStore, id: string): string | undefined {
  let cur = store.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (isPageLike(cur)) return cur.id;
    if (!cur.parent.startsWith("b:")) return undefined;
    cur = store.blocks.get(cur.parent.slice(2));
  }
  return undefined;
}

/** Block mit Inhalt löschen (Ansichten und eigene Datenbanken mit). */
function removeSubtree(store: WorkspaceStore, id: string, tx: Tx) {
  for (const d of [id, ...store.descendants(id)]) {
    const b = store.blocks.get(d);
    if (b) {
      for (const v of viewIDsForBlock(store, d)) tx.remove(keyOf("view", v));
      const db = b.props?.databaseID;
      if (db !== undefined && store.databases.get(db)?.blockID === d) tx.remove(keyOf("database", db));
    }
    tx.remove(keyOf("block", d));
  }
}

/** Block mit Inhalt löschen, darin liegende Seiten und Datenbanken aber in den Papierkorb retten (BSD-99). */
function removeSubtreeKeepingPages(store: WorkspaceStore, id: string, now: number, tx: Tx) {
  const rescued: string[] = [];
  const stack = [...store.children("b:" + id)].reverse();
  while (stack.length) {
    const cur = stack.pop()!;
    const b = store.blocks.get(cur);
    if (!b) continue;
    if (isTrashable(store, b)) { rescued.push(cur); continue; }
    stack.push(...[...store.children("b:" + cur)].reverse());
  }
  if (rescued.length > 0) {
    const parent = store.blocks.get(id)?.parent ?? "w";
    let host = "w";
    if (parent.startsWith("b:")) { const page = containingPage(store, parent.slice(2)); if (page) host = "b:" + page; }
    else if (parent.startsWith("d:")) host = parent;
    const sks = store.children(host).map((c) => store.blocks.get(c)?.sk).filter((s): s is string => s !== undefined);
    const max = sks.length ? sks.reduce((a, b) => (a > b ? a : b)) : undefined;
    const keys = keysBetween(rescued.length, max, undefined);
    rescued.forEach((rid, i) => tx.update(rid, (blk) => {
      blk.parent = host;
      blk.sk = keys[i]!;
      if (blk.trashedAt === undefined) blk.trashedAt = now;
      if (host === "w" && blk.type === "databaseInline") blk.type = "databasePage";
    }));
  }
  removeSubtree(store, id, tx);
}

const wasImported = (store: WorkspaceStore, id: string) => {
  const b = store.blocks.get(id);
  return b !== undefined && importFingerprint(b) !== undefined;
};

/** `id` und alles darunter (bis zu verschachtelten Seiten) kam aus einem Import und ist seitdem unverändert. */
function isUnchangedImport(store: WorkspaceStore, id: string): boolean {
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const b = store.blocks.get(cur);
    if (!b) continue;
    if (cur !== id && isTrashable(store, b)) continue;
    if (!wasImported(store, cur) || changedSinceImport(b)) return false;
    stack.push(...store.children("b:" + cur));
  }
  return true;
}

/**
 * Schreibt einen `ImportBuilder` in einer rückgängig machbaren Transaktion. Vorhandene Records (gleiche ID) werden an
 * Ort und Stelle aktualisiert; Veraltetes wird entfernt, veraltete Seiten und Zeilen kommen in den Papierkorb. Neue
 * Wurzeln werden an `parent` angehängt. Reimport-Schutz (BSD-32): jeder importierte Block merkt sich einen
 * Fingerabdruck; in Based geänderte oder hinzugefügte Blöcke bleiben.
 */
export function commitImport(store: WorkspaceStore, builder: ImportBuilder, parent = "w", name = "Import"): ImportReport {
  const report = builder.report();
  const roots = new Set(builder.roots);
  const importedIDs = new Set(builder.blocks.map((b) => b.id));
  let reimported = 0, keptLocal = 0, keptAdded = 0;
  store.transact(name, (tx) => {
    tx.preserveTimestamps = true;
    const now = store.now();
    const kids = store.children(parent);
    let rootKey: string | undefined = kids.length ? store.blocks.get(kids[kids.length - 1]!)?.sk : undefined;
    // Datenbanken zuerst, damit Blöcke auf sie zeigen können.
    for (const src of builder.databases) {
      const d = structuredClone(src);
      const old = store.databases.get(d.id);
      if (old) {
        if (old.templateIDs !== undefined) d.templateIDs = old.templateIDs;
        if (old.defaultTemplateID !== undefined) d.defaultTemplateID = old.defaultTemplateID;
        d.createdAt = old.createdAt;
      }
      tx.put({ kind: "database", data: d });
    }
    const written: string[] = [];
    for (const src of builder.blocks) {
      const b = structuredClone(src);
      const existing = store.blocks.get(b.id);
      if (existing) reimported += 1;
      // BSD-32: seit dem letzten Import in Based geändert → die lokale Fassung gewinnt.
      if (existing && existing.trashedAt === undefined && changedSinceImport(existing)) { keptLocal += 1; continue; }
      if (roots.has(b.id)) {
        if (existing && existing.trashedAt === undefined && parentExists(store, existing.parent)) {
          b.parent = existing.parent;
          b.sk = existing.sk;
        } else {
          b.parent = parent;
          rootKey = keyBetween(rootKey, undefined);
          b.sk = rootKey;
        }
      }
      if (b.createdBy === undefined && store.userID !== null) b.createdBy = store.userID;
      if (b.updatedBy === undefined && b.createdBy !== undefined) b.updatedBy = b.createdBy;
      delete b.trashedAt;
      tx.put({ kind: "block", data: cleanBlock(b) });
      written.push(b.id);
    }
    // Reimport: aus der Quelle Verschwundenes entfernen – aber nur, was der Import selbst geschrieben hat und seitdem
    // niemand geändert hat (BSD-32). In Based hinzugefügte oder geänderte Blöcke bleiben.
    if (reimported > 0) {
      for (const p of builder.complete) {
        if (p !== "w" && !p.startsWith("b:") && !p.startsWith("d:")) continue;
        for (const cid of [...store.children(p)]) {
          if (importedIDs.has(cid)) continue;
          const c = store.blocks.get(cid);
          if (!c || c.trashedAt !== undefined) continue;
          if (isPageLike(c) || p.startsWith("d:")) {
            // Seiten und Zeilen nur in den Papierkorb – außer sie kamen nie aus einem Import.
            if (!wasImported(store, cid)) { keptAdded += 1; continue; }
            tx.update(cid, (x) => { x.trashedAt = now; });
          } else if (!isUnchangedImport(store, cid)) {
            if (wasImported(store, cid)) keptLocal += 1; else keptAdded += 1;
          } else {
            removeSubtreeKeepingPages(store, cid, now, tx);
          }
        }
      }
      // Ansichten reimportierter Datenbank-Blöcke, die es in der Quelle nicht mehr gibt.
      const builderViews = new Set(builder.views.map((v) => v.id));
      for (const b of builder.blocks) {
        if (b.type !== "databaseInline" && b.type !== "databasePage") continue;
        for (const v of viewIDsForBlock(store, b.id)) if (!builderViews.has(v)) tx.remove(keyOf("view", v));
      }
    }
    for (const v of builder.views) tx.put({ kind: "view", data: structuredClone(v) });
    // Datenbank-Container, die jetzt auf einen anderen Datenbank-Record zeigen (z. B. HTML- → API-Reimport).
    for (const b of builder.blocks) {
      const before = tx.before.get(keyOf("block", b.id));
      if (!before || before.kind !== "block") continue;
      const oldDB = before.data.props?.databaseID;
      if (oldDB === undefined || oldDB === b.props?.databaseID) continue;
      const d = store.databases.get(oldDB);
      if (!d || d.blockID !== b.id) continue;
      for (const r of [...store.children("d:" + oldDB)]) if (!importedIDs.has(r)) removeSubtree(store, r, tx);
      for (const v of store.views.values()) if (v.databaseID === oldDB && v.blockID === b.id) tx.remove(keyOf("view", v.id));
      tx.remove(keyOf("database", oldDB));
    }
    // Fingerabdruck dessen, was der Import geschrieben hat, so wie es gespeichert ist.
    for (const id of written) {
      if (!store.blocks.has(id)) continue;
      tx.update(id, (x) => { (x as Record<string, unknown>)[IMPORT_FINGERPRINT_KEY] = contentFingerprint(x); });
    }
  });
  report.rootIDs = [...builder.roots];
  report.keptLocalChanges = keptLocal;
  report.keptLocalAdditions = keptAdded;
  if (keptAdded > 0) report.warnings.unshift(`Kept ${keptAdded} block${keptAdded === 1 ? "" : "s"} added in Based (not in the source).`);
  if (keptLocal > 0) report.warnings.unshift(`Kept ${keptLocal} block${keptLocal === 1 ? "" : "s"} changed in Based since the last import (not overwritten).`);
  if (reimported > 0) report.warnings.unshift(`Updated ${reimported - keptLocal} existing blocks from an earlier import.`);
  return report;
}
