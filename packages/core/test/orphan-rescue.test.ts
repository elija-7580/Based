// BSD-437 (Swift BSD-104, OrphanRescueTests): Blöcke, deren Elternteil nach einem Remote-Stapel fehlt, landen im
// Papierkorb statt unsichtbar zu bleiben.
import { describe, expect, it } from "vitest";
import {
  createDatabase, createPage, MemoryPersistence, orphanCandidates, orphanedBlocks, RECOVERED_BLOCKS_PAGE_ID, rescueOrphans, restorePages,
  trashedPages, WorkspaceStore, type WireRecord,
} from "../src/index.js";

const store = (node: string) => new WorkspaceStore({ persistence: new MemoryPersistence(), node });
const text = (s: WorkspaceStore, id: string, parent: string, t: string, sk = "a" + id) => {
  s.transact("add", (tx) => tx.put({ kind: "block", data: { id, type: "text", parent: "b:" + parent, sk, text: t, createdAt: 0, updatedAt: 0 } }));
  return id;
};

describe("BSD-437 verwaiste Blöcke in den Papierkorb", () => {
  it("Waisen aus einem Remote-Stapel landen im Papierkorb (Seite, Textblock mit Kind, Zeile)", () => {
    const s = store("s"), other = store("o");
    const page = createPage(other, { title: "Gone" });
    const sub = createPage(other, { title: "Sub", parent: page });
    const line = text(other, "line", page, "keep");
    const nested = text(other, "nested", line, "nested");
    const db = createDatabase(other, { parent: "b:" + page, title: "Tasks", inline: true, sampleRows: 0 }).databaseID;
    const row = "row";
    other.transact("row", (tx) => tx.put({ kind: "block", data: { id: row, type: "page", parent: "d:" + db, sk: "a0", text: "Row", createdAt: 0, updatedAt: 0 } }));
    const batch: WireRecord[] = [sub, line, nested, row].map((id) => ({ kind: "block", data: other.blocks.get(id)! }) as WireRecord);
    s.applyRemote(batch);

    const rescued = rescueOrphans(s, orphanCandidates(s, batch, []));
    expect(new Set(rescued)).toEqual(new Set([sub, line, row])); // `nested` kommt mit `line`
    const trash = trashedPages(s).map((b) => b.id);
    expect(trash).toEqual(expect.arrayContaining([sub, row, RECOVERED_BLOCKS_PAGE_ID]));
    expect(s.blocks.get(sub)?.parent).toBe("w");
    expect(s.blocks.get(line)?.parent).toBe("b:" + RECOVERED_BLOCKS_PAGE_ID);
    expect(s.blocks.get(nested)?.parent).toBe("b:" + line);
    expect(orphanedBlocks(s, s.blocks.keys())).toEqual([]);
    expect(s.canUndo).toBe(false);

    // wiederherstellbar
    restorePages(s, [sub, RECOVERED_BLOCKS_PAGE_ID]);
    expect(trashedPages(s).map((b) => b.id)).not.toContain(sub);
    expect(s.blocks.get(nested)?.text).toBe("nested");
  });

  it("Kinder einer remote gelöschten Elternseite werden gefunden; zweites Retten nutzt dieselbe Sammelseite", () => {
    const s = store("s");
    const page = createPage(s, { title: "P" });
    const a = text(s, "a", page, "a");
    s.applyRemote([], ["block:" + page as never]);
    const cands = orphanCandidates(s, [], ["block:" + page as never]);
    expect(cands).toEqual([a]);
    expect(rescueOrphans(s, cands)).toEqual([a]);
    const page2 = createPage(s, { title: "P2" });
    const b = text(s, "b", page2, "b");
    s.applyRemote([], ["block:" + page2 as never]);
    rescueOrphans(s, orphanCandidates(s, [], ["block:" + page2 as never]));
    expect(s.children("b:" + RECOVERED_BLOCKS_PAGE_ID)).toEqual([a, b]);
    expect(rescueOrphans(s, [a, b])).toEqual([]); // nichts verwaist → keine Transaktion
  });
});
