// BSD-230: Datei-Verweise umschreiben, wenn Dateien in den inhaltsadressierten Speicher (SHA-256, BSD-78) wandern –
// beim Import (vorläufige IDs → Hash) und bei der einmaligen Migration alter Import-Dateien.
// Ein Verweis ist ein Objekt mit `id` und `name` (AssetRef: Bild-/Dateiblock, Icon, Cover, Datei-Property, Spuren).
import type { WorkspaceStore } from "../store/store.js";

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
  for (const b of store.blocks.values()) { walk(b.props); walk(b.values); }
  return out;
}

/** Verweise im Store umschreiben (ein Schritt, nicht rückgängig zu machen – es ändert sich nur der Speicherort). */
export function remapStoreAssets(store: WorkspaceStore, map: ReadonlyMap<string, string>): number {
  if (map.size === 0) return 0;
  const hits: string[] = [];
  for (const b of store.blocks.values()) {
    if (remapAssetRefs(b.props, map) !== b.props || remapAssetRefs(b.values, map) !== b.values) hits.push(b.id);
  }
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
