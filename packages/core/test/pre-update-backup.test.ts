// BSD-456: Sicherung vor jedem App-Update – Archiv mit allen Records und Dateien, zurückgelesen und geprüft, die
// letzten drei bleiben; jeder Fehler hält das Update auf (ok: false mit einem Satz). Wiederherstellen über den Archiv-Import.
import { describe, expect, it } from "vitest";
import {
  applyImportedRecords, canonicalStringify, createPage, loadArchive, preUpdateFailureText, preUpdateName, preUpdateToPrune, writeArchivePackage,
  writePreUpdateBackup, WorkspaceStore, type BackupTarget, type WireRecord,
} from "../src/index.js";

function memoryTarget(over: Partial<BackupTarget> = {}): BackupTarget & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async list() { return [...files.keys()]; },
    async exists(p) { return files.has(p); },
    async write(p, d) { files.set(p, d.slice()); },
    async read(p) { const d = files.get(p); if (!d) throw new Error("missing " + p); return d.slice(); },
    async remove(p) { files.delete(p); },
    ...over,
  };
}

const HASH = "c".repeat(64);
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
function workspace() {
  const s = new WorkspaceStore({ node: "n" });
  const a = createPage(s, { title: "Alpha" });
  createPage(s, { title: "Child", parent: a });
  s.transact("img", (tx) => tx.put({ kind: "block", data: { id: "img1", type: "image", parent: "b:" + a, sk: "b", createdAt: 0, updatedAt: 0, props: { asset: { id: HASH, name: "cat.png" } } } } as WireRecord));
  return s;
}
const archiveOf = (s: WorkspaceStore) => async () => writeArchivePackage(s, (ref) => (ref.id === HASH ? PNG : undefined)).zip;
const norm = (st: WorkspaceStore) => st.exportRecords().filter((r) => r.kind !== "workspace")
  .map((r) => { const { stamp: _a, updatedAt: _b, updatedBy: _c, ...rest } = r.data as Record<string, unknown>; return canonicalStringify([r.kind, rest]); }).sort();

describe("Sicherung vor dem Update (BSD-456)", () => {
  it("Name sortiert nach Zeit und nennt beide Versionen; fremde Zeichen werden ersetzt", () => {
    expect(preUpdateName(new Date("2026-11-17T03:30:05Z"), "0.2.2", "0.2.3")).toBe("2026-11-17T03-30-05Z Based 0.2.2 before 0.2.3.based.zip");
    expect(preUpdateName(new Date(0), "a/b", "")).toBe("1970-01-01T00-00-00Z Based a_b before unknown.based.zip");
  });

  it("Aufbewahrung: die neuesten drei, fremde Dateien bleiben", () => {
    const names = ["2026-11-01T00-00-00Z Based 1 before 2.based.zip", "2026-11-03T00-00-00Z Based 3 before 4.based.zip", "notes.txt",
      "2026-11-02T00-00-00Z Based 2 before 3.based.zip", "2026-11-04T00-00-00Z Based 4 before 5.based.zip"];
    expect(preUpdateToPrune(names)).toEqual(["2026-11-01T00-00-00Z Based 1 before 2.based.zip"]);
    expect(preUpdateToPrune(names, 1)).toHaveLength(3);
  });

  it("Sicherung enthält alle Records und Dateien und lässt sich über den Archiv-Import wieder einspielen", async () => {
    const s = workspace();
    const t = memoryTarget();
    const r = await writePreUpdateBackup(t, { archive: archiveOf(s), from: "0.2.2", to: "0.2.3", now: new Date("2026-11-17T03:30:00Z") });
    expect(r).toMatchObject({ ok: true, name: "2026-11-17T03-30-00Z Based 0.2.2 before 0.2.3.based.zip", records: s.exportRecords().length });
    const loaded = loadArchive(t.files.get((r as { name: string }).name)!);
    expect(loaded.assets.map((a) => [a.ref.id, a.data])).toEqual([[HASH, PNG]]);
    const fresh = new WorkspaceStore({ node: "m" });
    applyImportedRecords(fresh, loaded.read.records);
    expect(norm(fresh)).toEqual(norm(s));
  });

  it("nur Records (großer Workspace): .based.jsonl, wieder einspielbar", async () => {
    const s = workspace();
    const t = memoryTarget();
    const { writeArchive } = await import("../src/index.js");
    const r = await writePreUpdateBackup(t, { archive: async () => new TextEncoder().encode(writeArchive(s)), from: "1", to: "2", now: new Date("2026-11-17T03:30:00Z") });
    expect(r).toMatchObject({ ok: true, name: "2026-11-17T03-30-00Z Based 1 before 2.based.jsonl", records: s.exportRecords().length });
    const fresh = new WorkspaceStore({ node: "m" });
    applyImportedRecords(fresh, loadArchive(t.files.get((r as { name: string }).name)!).read.records);
    expect(norm(fresh)).toEqual(norm(s));
    expect(preUpdateToPrune(["2026-11-01T00-00-00Z Based 1 before 2.based.jsonl", ...["02", "03", "04"].map((d) => `2026-11-${d}T00-00-00Z Based x before y.based.zip`)])).toEqual(["2026-11-01T00-00-00Z Based 1 before 2.based.jsonl"]);
  });

  it("behält nur die letzten drei Sicherungen", async () => {
    const s = workspace();
    const t = memoryTarget();
    for (let i = 1; i <= 5; i++) await writePreUpdateBackup(t, { archive: archiveOf(s), from: `0.${i}`, to: `0.${i + 1}`, now: new Date(Date.UTC(2026, 10, i)) });
    expect([...t.files.keys()].sort()).toEqual([
      "2026-11-03T00-00-00Z Based 0.3 before 0.4.based.zip",
      "2026-11-04T00-00-00Z Based 0.4 before 0.5.based.zip",
      "2026-11-05T00-00-00Z Based 0.5 before 0.6.based.zip",
    ]);
  });

  it("jeder Fehler hält das Update auf, mit einem Satz; Aufräumfehler nicht", async () => {
    const s = workspace();
    const go = (t: BackupTarget, archive = archiveOf(s)) => writePreUpdateBackup(t, { archive, from: "1", to: "2" });
    expect(await go(memoryTarget(), async () => { throw new Error("store closed"); })).toEqual({ ok: false, message: "Your workspace couldn't be copied: store closed" });
    expect(await go(memoryTarget(), async () => new Uint8Array([1, 2, 3]))).toEqual({ ok: false, message: "The copy of your workspace was incomplete" });
    expect(await go(memoryTarget({ async write() { throw new Error("ENOSPC: no space left on device"); } }))).toEqual({ ok: false, message: "The copy couldn't be saved: ENOSPC: no space left on device" });
    expect(await go(memoryTarget({ async read() { return new Uint8Array([0]); } }))).toMatchObject({ ok: false, message: "The saved copy didn't match your workspace" });
    expect(await go(memoryTarget({ async list() { throw new Error("EPERM"); } }))).toMatchObject({ ok: true, pruned: [] });
    expect(preUpdateFailureText("The copy couldn't be saved: ENOSPC.")).toBe("The update wasn't installed, because Based couldn't save a copy of your workspace first (The copy couldn't be saved: ENOSPC). Your data is unchanged — try again, or export a Based archive first.");
  });
});
