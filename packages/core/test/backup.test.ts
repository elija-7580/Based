// BSD-274: automatische Backups – Stand schreiben und ohne Unterschied wiederherstellen (inkl. Dateien),
// inkrementell (Dateien einmal, unveränderter Inhalt = kein neuer Stand), Aufbewahrung 24/30/12, Wiederherstellen
// nach „Seite gelöscht und Papierkorb geleert“.
import { describe, expect, it } from "vitest";
import {
  applyRestore, createPage, emptyTrash, listSnapshots, planRestore, pruneBackups, readSnapshot, snapshotAssetIDs, snapshotName, snapshotsToPrune,
  snapshotTime, trashPages, writeSnapshot, WorkspaceStore, canonicalStringify, type BackupTarget, type WireRecord,
} from "../src/index.js";

function memoryTarget(): BackupTarget & { files: Map<string, Uint8Array>; reads: number } {
  const files = new Map<string, Uint8Array>();
  const t = {
    files, reads: 0,
    async list(dir: string) { return [...files.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)).filter((k) => !k.includes("/")); },
    async exists(p: string) { return files.has(p); },
    async write(p: string, d: Uint8Array) { files.set(p, d.slice()); },
    async read(p: string) { t.reads++; const d = files.get(p); if (!d) throw new Error("missing " + p); return d; },
    async remove(p: string) { files.delete(p); },
  };
  return t;
}

const HASH = "a".repeat(64);
function workspace() {
  const s = new WorkspaceStore({ node: "n" });
  const a = createPage(s, { title: "Alpha" });
  createPage(s, { title: "Child", parent: a });
  const img = createPage(s, { title: "With image" });
  s.transact("img", (tx) => tx.put({ kind: "block", data: { id: "img1", type: "image", parent: "b:" + img, sk: "a", createdAt: 0, updatedAt: 0, props: { asset: { id: HASH, name: "cat.png" } } } } as WireRecord));
  return { s, a };
}

describe("Backups (BSD-274)", () => {
  it("Stand → Wiederherstellen in einen leeren Workspace ohne Unterschied, Datei liegt einmal im Ordner", async () => {
    const { s } = workspace();
    const t = memoryTarget();
    const bytes = new Uint8Array([1, 2, 3]);
    const info = (await writeSnapshot(t, { records: s.exportRecords(), workspaceName: s.workspace.name, assets: snapshotAssetIDs(s.exportRecords()).map((id) => ({ id, read: () => (id === HASH ? bytes : undefined) })), now: new Date("2026-11-12T05:00:00Z") }))!;
    expect(info.name).toBe("2026-11-12T05-00-00Z.based.jsonl");
    expect(info.assetsWritten).toBe(1);
    expect(t.files.get(`assets/${HASH}`)).toEqual(bytes);
    const read = await readSnapshot(t, info.name);
    const fresh = new WorkspaceStore({ node: "m" });
    applyRestore(fresh, planRestore(fresh, read.records));
    const norm = (st: WorkspaceStore) => st.exportRecords().filter((r) => r.kind !== "workspace").map((r) => { const { stamp: _a, updatedAt: _b, updatedBy: _c, ...rest } = r.data as Record<string, unknown>; return canonicalStringify([r.kind, rest]); }).sort();
    expect(norm(fresh)).toEqual(norm(s));
    expect(planRestore(fresh, read.records).upserts).toHaveLength(0);
  });

  it("inkrementell: unveränderter Inhalt schreibt nichts, Dateien werden nicht noch einmal geschrieben; Lesen nur beim Wiederherstellen", async () => {
    const { s } = workspace();
    const t = memoryTarget();
    const assets = [{ id: HASH, read: () => new Uint8Array([9]) }];
    const first = (await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets, now: new Date("2026-11-12T05:00:00Z") }))!;
    expect(await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets, now: new Date("2026-11-12T06:00:00Z"), previousDigest: first.digest })).toBeUndefined();
    createPage(s, { title: "New" });
    const second = (await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets, now: new Date("2026-11-12T06:00:00Z"), previousDigest: first.digest }))!;
    expect(second.assetsWritten).toBe(0);
    expect(second.assetsKept).toBe(1);
    expect(t.reads).toBe(0);
    expect((await listSnapshots(t)).map((x) => x.name)).toEqual([second.name, first.name]);
  });

  it("Seite löschen, Papierkorb leeren, aus dem Backup wiederherstellen; Vorschau zählt Seiten", async () => {
    const { s, a } = workspace();
    const t = memoryTarget();
    const snap = (await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets: [], now: new Date("2026-11-12T05:00:00Z") }))!;
    trashPages(s, [a]);
    emptyTrash(s);
    expect(s.blocks.has(a)).toBe(false);
    const later = createPage(s, { title: "Written after the backup" });
    const plan = planRestore(s, (await readSnapshot(t, snap.name)).records);
    expect(plan.pages).toEqual({ added: 2, changed: 0, removed: 1 });
    applyRestore(s, plan);
    expect(s.blocks.get(a)?.text).toBe("Alpha");
    expect(s.children("b:" + a)).toHaveLength(1);
    expect(s.blocks.has(later)).toBe(false);
  });

  it("Aufbewahrung: letzte 10, 24 stündlich, 30 täglich, 12 monatlich – je Zeitraum der neueste; Dateien ohne Stand fallen weg", async () => {
    const start = Date.parse("2026-01-01T00:30:00Z");
    const snaps = Array.from({ length: 24 * 400 }, (_, i) => { const at = start + i * 3_600_000; return { name: snapshotName(new Date(at)), at }; });
    const drop = new Set(snapshotsToPrune(snaps));
    const kept = snaps.filter((x) => !drop.has(x.name));
    // 24 Stunden + bis 30 Tage + bis 12 Monate, Überschneidungen zählen einmal
    expect(kept.length).toBeLessThanOrEqual(10 + 24 + 30 + 12);
    expect(kept.length).toBeGreaterThanOrEqual(30 + 12);
    const newest = snaps[snaps.length - 1]!;
    expect(drop.has(newest.name)).toBe(false);
    expect(snapshotTime(newest.name)).toBe(newest.at);
    expect(snapshotTime("evil/../x.based.jsonl")).toBeUndefined();

    const t = memoryTarget();
    const { s } = workspace();
    const assets = [{ id: HASH, read: () => new Uint8Array([1]) }];
    for (let h = 0; h < 30; h++) {
      if (h === 29) s.transact("rm", (tx) => tx.remove("block:img1" as never));
      createPage(s, { title: "p" + h });
      await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets: snapshotAssetIDs(s.exportRecords()).map((id) => assets.find((a) => a.id === id)!).filter(Boolean), now: new Date(Date.parse("2026-11-12T00:00:00Z") + h * 3_600_000) });
    }
    const r = await pruneBackups(t, { hourly: 1, daily: 0, monthly: 0 });
    expect(r.snapshots).toBe(29);
    expect(r.assets).toBe(1);
    expect(await t.list("assets")).toEqual([]);
  });
});
