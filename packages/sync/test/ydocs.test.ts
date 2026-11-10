// BSD-220 Teil 2: Y-Zustände in ydocs.sqlite (eigene Datei, based.sqlite bleibt v3 für die Swift-App).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, MemoryYDocStorage, SqliteYDocStorage } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempFile = () => {
  const d = mkdtempSync(join(tmpdir(), "based-ydocs-"));
  dirs.push(d);
  return join(d, "ydocs.sqlite");
};

describe("SqliteYDocStorage", () => {
  it("speichert, überschreibt und liest nach dem Wiederöffnen", () => {
    const file = tempFile();
    const db = openNodeDatabase(file);
    const s = new SqliteYDocStorage(db, () => 1);
    expect(s.get("P")).toBeUndefined();
    s.put("P", new Uint8Array([1, 2, 3]));
    s.put("Q", new Uint8Array([9]));
    s.put("P", new Uint8Array([4, 5]));
    db.close();
    const again = new SqliteYDocStorage(openNodeDatabase(file));
    expect([...again.get("P")!]).toEqual([4, 5]);
    expect(again.roots()).toEqual(["P", "Q"]);
    again.delete("Q");
    expect(again.get("Q")).toBeUndefined();
    again.db.close();
  });

  it("legt keine Tabelle in based.sqlite an (Schema-Version bleibt für Swift lesbar)", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
  });

  it("Speicher-Variante kopiert die Bytes", () => {
    const m = new MemoryYDocStorage();
    const bytes = new Uint8Array([1]);
    m.put("A", bytes);
    bytes[0] = 7;
    expect([...m.get("A")!]).toEqual([1]);
  });
});
