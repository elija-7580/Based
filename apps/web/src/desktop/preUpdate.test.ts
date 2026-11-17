// BSD-456: Sicherung vor dem Update in der Hülle – ohne Archivquelle kein Update; mit Quelle landet ein prüfbares
// Archiv im Ziel. (Echter Tauri-Dateizugriff: Mac-Test.)
import { describe, expect, it } from "vitest";
import { createPage, loadArchive, WorkspaceStore, writeArchivePackage, type BackupTarget } from "@based/core";
import { backupBeforeUpdate, setPreUpdateArchive } from "./preUpdate.js";

const memory = (): BackupTarget & { files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>();
  return { files, list: async () => [...files.keys()], exists: async (p) => files.has(p), write: async (p, d) => void files.set(p, d), read: async (p) => files.get(p)!, remove: async (p) => void files.delete(p) };
};

describe("backupBeforeUpdate (BSD-456)", () => {
  it("ohne geöffneten Workspace: kein Update", async () => {
    setPreUpdateArchive(undefined);
    expect(await backupBeforeUpdate("0.2.2", "0.2.3", memory())).toEqual({ ok: false, message: "The workspace isn't open in this window" });
  });

  it("mit Workspace: Archiv im pre-update-Ordner, alle Records", async () => {
    const s = new WorkspaceStore({ node: "n" });
    createPage(s, { title: "Keep me" });
    setPreUpdateArchive(async () => writeArchivePackage(s, () => undefined).zip);
    const t = memory();
    const r = await backupBeforeUpdate("0.2.2", "0.2.3", t);
    expect(r.ok).toBe(true);
    const [name] = [...t.files.keys()];
    expect(name).toMatch(/ Based 0\.2\.2 before 0\.2\.3\.based\.zip$/);
    expect(loadArchive(t.files.get(name!)!).read.records).toHaveLength(s.exportRecords().length);
    setPreUpdateArchive(undefined);
  });
});
