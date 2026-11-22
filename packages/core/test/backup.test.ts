// BSD-274: automatische Backups – Stand schreiben und ohne Unterschied wiederherstellen (inkl. Dateien),
// inkrementell (Dateien einmal, unveränderter Inhalt = kein neuer Stand), Aufbewahrung 24/30/12, Wiederherstellen
// nach „Seite gelöscht und Papierkorb geleert“.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  archiveDamage, prepareFiles, readArchive, readZipEntries, zipEntryData,
  applyRestore, createPage, emptyTrash, listSnapshots, planRestore, pruneBackups, readSnapshot, snapshotAssetCandidates, snapshotAssetIDs, snapshotName, snapshotsToPrune,
  snapshotTime, trashPages, writeSnapshot, WorkspaceStore, canonicalStringify, type BackupTarget, type SnapshotAssetCache, type WireRecord,
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

  // BSD-491: das Aufräumen las jede Stunde alle verbleibenden Stände (50 000 Records: ~1 GB, 16 s).
  it("Aufräumen: Datei-IDs per Textsuche (Obermenge), jeder Stand nur einmal gelesen, ohne Dateien gar nicht", async () => {
    const { s } = workspace();
    const other = "b".repeat(64);
    s.transact("cover", (tx) => tx.put({ kind: "block", data: { id: "cov", type: "page", parent: "w", sk: "z", createdAt: 0, updatedAt: 0, text: "Cover", props: { cover: { asset: { _0: { id: other, name: "c.png" } } } } } } as WireRecord));
    s.transact("arch", (tx) => tx.put({ kind: "block", data: { id: "file1", type: "file", parent: "w", sk: "zz", createdAt: 0, updatedAt: 0, props: { asset: { id: "Imported_file-1", name: "a.pdf" } } } } as WireRecord));
    const t = memoryTarget();
    await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets: [], now: new Date("2026-11-12T00:00:00Z") });
    const text = new TextDecoder().decode(t.files.get("snapshots/" + snapshotName(new Date("2026-11-12T00:00:00Z")))!);
    const found = snapshotAssetCandidates(text)!;
    for (const id of snapshotAssetIDs(s.exportRecords())) expect(found.has(id)).toBe(true);
    expect(found.has(HASH) && found.has(other) && found.has("Imported_file-1")).toBe(true);
    expect(snapshotAssetCandidates("not an archive\n" + HASH)).toBeUndefined();

    // ohne Dateien im Backup: kein Stand wird gelesen
    const plain = memoryTarget();
    for (let h = 0; h < 5; h++) await writeSnapshot(plain, { records: s.exportRecords(), workspaceName: "W", assets: [], now: new Date(Date.parse("2026-11-12T00:00:00Z") + h * 3_600_000), force: true });
    expect(await pruneBackups(plain, { recent: 2, hourly: 0, daily: 0, monthly: 0 })).toEqual({ snapshots: 3, assets: 0 });
    expect(plain.reads).toBe(0);

    // mit Dateien: jeder verbleibende Stand einmal je Cache; gebrauchte Dateien bleiben, verwaiste fallen weg
    const t2 = memoryTarget();
    const cache: SnapshotAssetCache = new Map();
    const assets = [{ id: HASH, read: () => new Uint8Array([1]) }];
    for (let h = 0; h < 4; h++) await writeSnapshot(t2, { records: s.exportRecords(), workspaceName: "W", assets, now: new Date(Date.parse("2026-11-12T00:00:00Z") + h * 3_600_000), force: true });
    t2.files.set("assets/" + "c".repeat(64), new Uint8Array([2]));
    expect(await pruneBackups(t2, { recent: 3, hourly: 0, daily: 0, monthly: 0 }, cache)).toEqual({ snapshots: 1, assets: 1 });
    expect(t2.reads).toBe(3);
    await writeSnapshot(t2, { records: s.exportRecords(), workspaceName: "W", assets, now: new Date(Date.parse("2026-11-12T00:00:00Z") + 9 * 3_600_000), force: true });
    expect(await pruneBackups(t2, { recent: 3, hourly: 0, daily: 0, monthly: 0 }, cache)).toEqual({ snapshots: 1, assets: 0 });
    expect(t2.reads).toBe(4); // nur der neue Stand
    expect(await t2.list("assets")).toEqual([HASH]);
    expect(cache.size).toBe(3);
  });

  it("Aufräumen: ein Stand mit gleichem Namen (dieselbe Sekunde) ersetzt den gemerkten Inhalt (BSD-491)", async () => {
    const { s } = workspace();
    const t = memoryTarget();
    const cache: SnapshotAssetCache = new Map();
    const other = "d".repeat(64);
    const at = (h: number) => new Date(Date.parse("2026-11-12T00:00:00Z") + h * 3_600_000);
    for (let h = 0; h < 3; h++) await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets: [{ id: HASH, read: () => new Uint8Array([1]) }], now: at(h), force: true, cache });
    await pruneBackups(t, { recent: 2, hourly: 0, daily: 0, monthly: 0 }, cache);
    // gleiche Sekunde wie der neueste Stand, jetzt mit einer anderen Datei statt HASH
    s.transact("swap", (tx) => tx.update("img1", (b) => { b.props = { asset: { id: other, name: "dog.png" } }; }));
    await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets: [{ id: other, read: () => new Uint8Array([2]) }], now: at(2), force: true, cache });
    await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets: [{ id: other, read: () => new Uint8Array([2]) }], now: at(3), force: true, cache });
    await pruneBackups(t, { recent: 2, hourly: 0, daily: 0, monthly: 0 }, cache);
    expect((await t.list("assets")).sort()).toEqual([other]);
  });

  // BSD-648: ein beschädigter Stand (abgeschnitten, unlesbare Zeilen) wird erkannt und gemeldet – nur lesen, nichts ändern.
  describe("beschädigter Stand (BSD-648)", () => {
    async function snapshotOf(pages: number) {
      const s = new WorkspaceStore({ node: "n" });
      for (let i = 0; i < pages; i++) createPage(s, { title: "P" + i });
      const t = memoryTarget();
      const info = (await writeSnapshot(t, { records: s.exportRecords(), workspaceName: "W", assets: [], now: new Date("2026-11-12T05:00:00Z") }))!;
      const key = `snapshots/${info.name}`;
      return { s, t, info, key, text: new TextDecoder().decode(t.files.get(key)!) };
    }

    it("unversehrt: kein `damaged`", async () => {
      const { t, info, s } = await snapshotOf(6);
      const read = await readSnapshot(t, info.name);
      expect(read.damaged).toBeUndefined();
      expect(read.records).toHaveLength(s.exportRecords().length);
    });

    it("mitten in einer Zeile abgeschnitten: `damaged` mit gelesen/erwartet/unlesbar; der Stand bleibt unverändert", async () => {
      const { t, info, key, text, s } = await snapshotOf(6);
      const cut = new TextEncoder().encode(text.slice(0, Math.floor(text.length / 2)));
      t.files.set(key, cut);
      const read = await readSnapshot(t, info.name);
      expect(read.damaged).toEqual({ readable: read.records.length, expected: s.exportRecords().length, skipped: 1 });
      expect(read.damaged!.readable).toBeLessThan(read.damaged!.expected);
      expect(t.files.get(key)).toEqual(cut); // nur gelesen
    });

    it("genau an einer Zeilengrenze abgeschnitten (keine unlesbare Zeile): Kopf ≠ gelesen → `damaged`", async () => {
      const { t, info, key, text, s } = await snapshotOf(6);
      const lines = text.split("\n");
      t.files.set(key, new TextEncoder().encode(lines.slice(0, 4).join("\n") + "\n"));
      const read = await readSnapshot(t, info.name);
      expect(read.skipped).toBe(0);
      expect(read.damaged).toEqual({ readable: 3, expected: s.exportRecords().length, skipped: 0 });
    });

    it("eine unlesbare Zeile in der Mitte: `damaged`", async () => {
      const { t, info, key, text, s } = await snapshotOf(3);
      const lines = text.split("\n");
      lines[2] = "{kaputt";
      t.files.set(key, new TextEncoder().encode(lines.join("\n")));
      const read = await readSnapshot(t, info.name);
      expect(read.damaged).toEqual({ readable: s.exportRecords().length - 1, expected: s.exportRecords().length, skipped: 1 });
    });

    it("Archiv-Import: an einer Zeilengrenze abgeschnitten → Hinweis „only N of M records“; unversehrt kein Hinweis", async () => {
      const { text, s } = await snapshotOf(4);
      const enc = new TextEncoder();
      expect(prepareFiles([{ path: "full.based.jsonl", data: enc.encode(text) }]).notes).toEqual([]);
      const cut = text.split("\n").slice(0, 3).join("\n") + "\n";
      expect(prepareFiles([{ path: "cut.based.jsonl", data: enc.encode(cut) }]).notes)
        .toEqual([`cut.based.jsonl: only 2 of ${s.exportRecords().length} records could be read – the file may be incomplete`]);
      // mitten in der Zeile: der bisherige Hinweis auf die unlesbare Zeile genügt (kein zweiter)
      expect(prepareFiles([{ path: "half.based.jsonl", data: enc.encode(text.slice(0, text.length - 5)) }]).notes).toEqual(["half.based.jsonl: skipped 1 unreadable line"]);
    });

    // Archive der Beta-Builds (packages/sync/test/fixtures/beta, nur gelesen) als Backup-Stand: nicht beschädigt.
    const BETA = fileURLToPath(new URL("../../sync/test/fixtures/beta", import.meta.url));
    const zips = existsSync(BETA) ? readdirSync(BETA).filter((f) => f.endsWith(".based.zip")).sort() : [];
    it("die Beta-Archive liegen vor", () => expect(zips).toContain("beta-9614eb09.based.zip"));
    for (const f of zips) {
      it(`${f} als Stand: kein \`damaged\`, Wiederherstellen in einen leeren Workspace liest alles`, async () => {
        const bytes = new Uint8Array(readFileSync(join(BETA, f)));
        const entry = readZipEntries(bytes).find((e) => e.path === "workspace.jsonl")!;
        const jsonl = zipEntryData(bytes, entry);
        const t = memoryTarget();
        const name = snapshotName(new Date("2026-11-20T08:00:00Z"));
        t.files.set(`snapshots/${name}`, jsonl);
        const read = await readSnapshot(t, name);
        expect(read.damaged).toBeUndefined();
        expect(archiveDamage(readArchive(new TextDecoder().decode(jsonl)))).toBeUndefined();
        const fresh = new WorkspaceStore({ node: "m" });
        applyRestore(fresh, planRestore(fresh, read.records));
        expect(planRestore(fresh, read.records).upserts).toHaveLength(0);
      });
    }
  });
});
