// BSD-230: Datei-Verweise umschreiben, wenn Dateien in den inhaltsadressierten Speicher (SHA-256, BSD-78) wandern –
// beim Import (vorläufige IDs → Hash) und bei der einmaligen Migration alter Import-Dateien.
// Ein Verweis ist ein Objekt mit `id` und `name` (AssetRef: Bild-/Dateiblock, Icon, Cover, Datei-Property, Spuren).
import type { WorkspaceStore } from "../store/store.js";

const REF_HINTS = ['"name"'] as const;
const isRef = (o: Record<string, unknown>) => typeof o.id === "string" && typeof o.name === "string";

/** Tiefe Kopie, in der jeder AssetRef mit einer ID aus `map` die neue ID bekommt. Ohne Treffer: dasselbe Objekt. */
export function remapAssetRefs<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (map.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => { const y = walk(x); if (y !== x) changed = true; return y; });
      return changed ? out : v;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      let out: Record<string, unknown> | undefined;
      for (const [k, x] of Object.entries(o)) {
        const y = walk(x);
        if (y !== x) { out ??= { ...o }; out[k] = y; }
      }
      if (isRef(o)) {
        const to = map.get(o.id as string);
        if (to !== undefined && to !== o.id) { out ??= { ...o }; out.id = to; }
      }
      return out ?? v;
    }
    return v;
  };
  return walk(value) as T;
}

/** Alle Asset-IDs, auf die Records zeigen. */
export function assetIDsInStore(store: WorkspaceStore): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (isRef(o)) out.add(o.id as string);
      for (const x of Object.values(o)) walk(x);
    }
  };
  // Ein Verweis hat immer ein Feld `name`: mit Laden nach Bedarf sucht die Datei danach, statt alles zu laden.
  store.scanBlocks(REF_HINTS, (b) => { walk(b.props); walk(b.values); });
  return out;
}

/** Verweise im Store umschreiben (ein Schritt, nicht rückgängig zu machen – es ändert sich nur der Speicherort). */
export function remapStoreAssets(store: WorkspaceStore, map: ReadonlyMap<string, string>): number {
  if (map.size === 0) return 0;
  const hits: string[] = [];
  store.scanBlocks(REF_HINTS, (b) => {
    if (remapAssetRefs(b.props, map) !== b.props || remapAssetRefs(b.values, map) !== b.values) hits.push(b.id);
  });
  if (hits.length === 0) return 0;
  store.transact("Move files to synced storage", (tx) => {
    for (const id of hits) {
      tx.update(id, (b) => {
        if (b.props) b.props = remapAssetRefs(b.props, map);
        if (b.values) b.values = remapAssetRefs(b.values, map);
      });
    }
  }, { undoable: false });
  return hits.length;
}

/** BSD-430: Präfix, mit dem die Web-App Dateien aus dem Speicher adressiert (`based-asset:<id>`). */
export const ASSET_URL_SCHEME = "based-asset:";

/** Ersatzname, wenn nichts Besseres bekannt ist (Archive und Exporte brauchen einen Namen). */
function fallbackAssetName(type: string, id: string): string {
  const base = type === "image" ? "image" : type === "video" ? "video" : type === "audio" ? "audio" : type === "pdf" ? "document" : "file";
  return `${base}-${id.slice(0, 8)}${type === "pdf" ? ".pdf" : ""}`;
}

/**
 * BSD-430: Der Block-Editor schrieb bis 56bc6e4f nach einem Upload nur `props.url = "based-asset:<id>"` statt des
 * kanonischen `props.asset = {id, name, …}` (wie Swift, Importer, alter Editor). Exporte, Archive und die Swift-App
 * sahen die Datei so nicht. Einmalige Migration (beim Start, idempotent): solche Blöcke bekommen `asset` (Name aus
 * `info`, sonst ein Ersatzname nach Blockart), `url` fällt weg. Bearbeitungszeiten bleiben; wird gesynct.
 * Gibt die Zahl umgestellter Blöcke zurück.
 */
export function migrateAssetURLBlocks(store: WorkspaceStore, info?: (id: string) => { name?: string; mime?: string; size?: number } | undefined): number {
  const hits: string[] = [];
  for (const b of store.blocks.values()) {
    const url = b.props?.url;
    if (typeof url === "string" && url.startsWith(ASSET_URL_SCHEME) && url.length > ASSET_URL_SCHEME.length && !b.props?.asset) hits.push(b.id);
  }
  if (hits.length === 0 || store.isReadOnly) return 0;
  const rejected = store.writeFailure?.rejected ?? 0;
  store.transact("Fix uploaded files", (tx) => {
    tx.preserveTimestamps = true;
    for (const id of hits) {
      tx.update(id, (b) => {
        const assetID = b.props!.url!.slice(ASSET_URL_SCHEME.length);
        const known = info?.(assetID);
        const asset: NonNullable<NonNullable<typeof b.props>["asset"]> = { id: assetID, name: known?.name || fallbackAssetName(b.type, assetID) };
        if (known?.mime) asset.mime = known.mime;
        if (known?.size !== undefined) asset.size = known.size;
        b.props = { ...b.props, asset };
        delete b.props.url;
      });
    }
  }, { undoable: false });
  // Nicht gespeichert (schreibgeschützt, Platte voll): im Speicher zurückgedreht, nichts umgestellt
  if ((store.writeFailure?.rejected ?? 0) !== rejected || (store.writeFailure && rejected === 0)) return 0;
  return hits.length;
}
