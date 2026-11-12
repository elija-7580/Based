// BSD-319: Ablage der Fehlerberichte („Problem melden“). Ein Bündel ist ein Ordner mit `report.json` und, wenn gewählt,
// `screenshot.png`.
// - Mac-App (Tauri): ~/.config/based/reports/<id>/ – dort liest sie auch `based reports` (CLI), Nachtschicht und Fable.
// - Browser: IndexedDB „based-reports“ (kein Dateisystem); „Save as file…“ lädt das Bündel als eine JSON-Datei herunter.
import { parseBugBundle, summarizeBundle, type BugBundle, type BugBundleSummary } from "@based/core";
import { isTauri } from "../desktop.js";

export const REPORTS_DIR = ".config/based/reports";

export interface SavedReport extends BugBundleSummary {
  /** Ort für Menschen (Pfad im Dateisystem oder „this browser“). */
  where: string;
}

export interface ReportStore {
  readonly kind: "files" | "browser";
  save(bundle: BugBundle, screenshot?: Blob): Promise<SavedReport>;
  list(): Promise<SavedReport[]>;
  load(id: string): Promise<{ bundle: BugBundle; screenshot?: Blob } | undefined>;
  remove(id: string): Promise<void>;
  /** Finder öffnen (nur Mac-App). */
  reveal?(id: string): Promise<void>;
}

const sortNewest = (a: SavedReport[]) => a.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
const safeID = (id: string) => {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error("Invalid report id");
  return id;
};

// MARK: Mac-App

async function fileStore(): Promise<ReportStore> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { BaseDirectory, homeDir, join } = await import("@tauri-apps/api/path");
  const baseDir = BaseDirectory.Home;
  const home = await homeDir();
  const dir = (id: string) => `${REPORTS_DIR}/${safeID(id)}`;
  const where = async (id: string) => join(home, dir(id));
  return {
    kind: "files",
    async save(bundle, screenshot) {
      await fs.mkdir(dir(bundle.id), { baseDir, recursive: true });
      if (screenshot) await fs.writeFile(`${dir(bundle.id)}/screenshot.png`, new Uint8Array(await screenshot.arrayBuffer()), { baseDir });
      await fs.writeTextFile(`${dir(bundle.id)}/report.json`, JSON.stringify(bundle, null, 1), { baseDir });
      return { ...summarizeBundle(bundle), where: await where(bundle.id) };
    },
    async list() {
      if (!(await fs.exists(REPORTS_DIR, { baseDir }))) return [];
      const out: SavedReport[] = [];
      for (const e of await fs.readDir(REPORTS_DIR, { baseDir })) {
        if (!e.isDirectory || !/^[\w-]{1,80}$/.test(e.name)) continue;
        try {
          const b = parseBugBundle(JSON.parse(await fs.readTextFile(`${dir(e.name)}/report.json`, { baseDir })));
          if (b) out.push({ ...summarizeBundle(b), where: await where(e.name) });
        } catch { /* halbes Bündel überspringen */ }
      }
      return sortNewest(out);
    },
    async load(id) {
      const b = parseBugBundle(JSON.parse(await fs.readTextFile(`${dir(id)}/report.json`, { baseDir })));
      if (!b) return undefined;
      let screenshot: Blob | undefined;
      if (b.screenshot) {
        try {
          screenshot = new Blob([await fs.readFile(`${dir(id)}/screenshot.png`, { baseDir })], { type: "image/png" });
        } catch { /* fehlt */ }
      }
      return { bundle: b, ...(screenshot ? { screenshot } : {}) };
    },
    async remove(id) {
      await fs.remove(dir(id), { baseDir, recursive: true });
    },
    async reveal(id) {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(await join(await where(id), "report.json"));
    },
  };
}

// MARK: Browser

const DB = "based-reports", STORE = "reports";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

interface Row { id: string; bundle: BugBundle; screenshot?: Blob }

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB error"));
    });
  } finally {
    db.close();
  }
}

function browserStore(): ReportStore {
  const where = "this browser";
  return {
    kind: "browser",
    async save(bundle, screenshot) {
      const row: Row = { id: bundle.id, bundle, ...(screenshot ? { screenshot } : {}) };
      await tx("readwrite", (s) => s.put(row));
      return { ...summarizeBundle(bundle), where };
    },
    async list() {
      const rows = await tx<Row[]>("readonly", (s) => s.getAll() as IDBRequest<Row[]>);
      return sortNewest(rows.flatMap((r) => (parseBugBundle(r.bundle) ? [{ ...summarizeBundle(r.bundle), where }] : [])));
    },
    async load(id) {
      const r = await tx<Row | undefined>("readonly", (s) => s.get(safeID(id)) as IDBRequest<Row | undefined>);
      return r ? { bundle: r.bundle, ...(r.screenshot ? { screenshot: r.screenshot } : {}) } : undefined;
    },
    async remove(id) {
      await tx("readwrite", (s) => s.delete(safeID(id)));
    },
  };
}

let store: Promise<ReportStore> | undefined;

/** Die Ablage dieser Hülle (einmal angelegt). */
export function reportStore(): Promise<ReportStore> {
  store ??= isTauri() ? fileStore().catch(() => browserStore()) : Promise.resolve(browserStore());
  return store;
}

// Liste beobachten (Einstellungen): nach Speichern und Löschen neu laden.
const listeners = new Set<() => void>();
export const onReportsChanged = (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
export const reportsChanged = () => { for (const l of listeners) l(); };

/** Ein Bündel als eine JSON-Datei (Bildschirmfoto als data:-URL darin) – zum Herunterladen im Browser. */
export async function bundleFile(bundle: BugBundle, screenshot?: Blob): Promise<Blob> {
  let png: string | undefined;
  if (screenshot) {
    png = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error("read failed"));
      r.readAsDataURL(screenshot);
    });
  }
  return new Blob([JSON.stringify({ ...bundle, ...(png ? { screenshotData: png } : {}) }, null, 1)], { type: "application/json" });
}
