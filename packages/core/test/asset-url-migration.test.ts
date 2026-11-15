// BSD-430: Der Block-Editor schrieb Uploads bis 56bc6e4f nur als `props.url = "based-asset:<id>"`. Alte Daten lesen und
// einmalig auf `props.asset` umstellen – danach sehen Archiv- und Markdown-Export die Datei.
import { describe, expect, it } from "vitest";
import {
  archiveAssetRefs, ASSET_URL_SCHEME, MemoryPersistence, migrateAssetURLBlocks, planWorkspaceExport, topLevelPages, WorkspaceStore, type Block,
} from "../src/index.js";

const HASH = "a".repeat(64);
const block = (id: string, type: string, parent: string, props?: Block["props"]): Block =>
  ({ id, type, parent, sk: "a" + id, createdAt: 1, updatedAt: 5, ...(props ? { props } : {}) });

/** Stand wie ihn der Block-Editor vor 56bc6e4f geschrieben hat (alte Daten). */
function oldData() {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t", now: () => 100 });
  s.transact("old", (tx) => {
    tx.put({ kind: "block", data: { ...block("p", "page", "w"), text: "Trip" } });
    tx.put({ kind: "block", data: block("img", "image", "b:p", { url: ASSET_URL_SCHEME + HASH }) });
    tx.put({ kind: "block", data: block("pdf", "pdf", "b:p", { url: ASSET_URL_SCHEME + "b".repeat(64) }) });
    tx.put({ kind: "block", data: block("web", "image", "b:p", { url: "https://example.org/x.png" }) });
    tx.put({ kind: "block", data: block("ok", "file", "b:p", { asset: { id: "c".repeat(64), name: "notes.txt" } }) });
  }, { undoable: false });
  return s;
}

describe("BSD-430 Uploads als based-asset-URL", () => {
  it("vorher: Archiv und Export sehen die Datei nicht", () => {
    const s = oldData();
    expect(archiveAssetRefs(s.allRecords()).map((r) => r.id)).toEqual(["c".repeat(64)]);
  });

  it("Migration: asset mit Name (bekannt bzw. Ersatzname), url weg, Zeiten bleiben, idempotent", () => {
    const s = oldData();
    const edited = s.blocks.get("img")!.updatedAt;
    s.now = () => 999;
    const n = migrateAssetURLBlocks(s, (id) => (id === HASH ? { name: "beach.jpg", mime: "image/jpeg", size: 1234 } : undefined));
    expect(n).toBe(2);
    expect(s.blocks.get("img")?.props).toEqual({ asset: { id: HASH, name: "beach.jpg", mime: "image/jpeg", size: 1234 } });
    expect(s.blocks.get("pdf")?.props).toEqual({ asset: { id: "b".repeat(64), name: "document-bbbbbbbb.pdf" } });
    expect(s.blocks.get("web")?.props).toEqual({ url: "https://example.org/x.png" });
    expect(s.blocks.get("img")?.updatedAt).toBe(edited);
    expect(s.canUndo).toBe(false);
    expect(migrateAssetURLBlocks(s)).toBe(0);
    // Archiv und Markdown-Export nennen die Dateien jetzt
    expect(archiveAssetRefs(s.allRecords()).map((r) => r.id).sort()).toEqual([HASH, "b".repeat(64), "c".repeat(64)].sort());
    const plan = planWorkspaceExport(s, topLevelPages(s), "markdown");
    expect(plan.assets.map((a) => a.ref.id).sort()).toEqual([HASH, "b".repeat(64), "c".repeat(64)].sort());
  });

  it("schreibgeschützt: nichts", () => {
    const s = oldData();
    const failing = s.persistence as MemoryPersistence;
    failing.write = () => { throw new Error("disk full"); };
    expect(migrateAssetURLBlocks(s)).toBe(0); // Schreiben scheitert …
    expect(s.blocks.get("img")?.props?.url).toBe(ASSET_URL_SCHEME + HASH); // … im Speicher zurückgedreht
    expect(migrateAssetURLBlocks(s)).toBe(0); // danach schreibgeschützt: kein neuer Versuch
  });
});
