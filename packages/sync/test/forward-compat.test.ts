// Vorwärts-Verträglichkeit der Beta (Elija, 18.11.): trifft eine ältere App auf etwas aus einer neueren Version,
// darf sie nichts zerstören, nichts überspringen – und muss sagen, dass ein Update nötig ist.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPage, type WorkspaceStore } from "@based/core";
import { CURRENT_SCHEMA_VERSION, FolderSync, isNewerSegment, openBlockedMessage, openWorkspace, PersistenceError, PROPERTY_RECORDS_SCHEMA_VERSION, segmentName, type FolderTarget } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";

function folder(): FolderTarget & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async list(dir) {
      const out = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(dir + "/")) out.add(k.slice(dir.length + 1).split("/")[0]!);
      return [...out];
    },
    async write(p, d) { files.set(p, d.slice()); },
    async read(p) { const d = files.get(p); if (!d) throw new Error("missing"); return d; },
    async remove(p) { files.delete(p); },
  };
}
const dec = new TextDecoder(), enc = new TextEncoder();
const mac = (name: string, target: FolderTarget) => {
  const ws = openWorkspace(openNodeDatabase(), { node: name });
  return { store: ws.store as WorkspaceStore, sync: new FolderSync({ store: ws.store, target, device: name, enabled: true, changeLog: ws.persistence }) };
};

describe("Datei aus einer neueren Version", () => {
  it("wird nicht geöffnet, nicht verändert – und die App weicht nicht auf einen leeren Workspace aus", () => {
    const path = join(mkdtempSync(join(tmpdir(), "based-newer-")), "based.sqlite");
    const first = openWorkspace(openNodeDatabase(path), { node: "a" });
    const page = createPage(first.store, { title: "Stays" });
    const raw = openNodeDatabase(path);
    const future = Math.max(CURRENT_SCHEMA_VERSION, PROPERTY_RECORDS_SCHEMA_VERSION) + 1;
    raw.exec(`PRAGMA user_version = ${future}`);
    const before = raw.all("SELECT kind, id, data FROM records ORDER BY kind, id");

    let error: unknown;
    try { openWorkspace(openNodeDatabase(path), { node: "a" }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).code).toBe("newerFormat");
    // Der Satz, den die App zeigt („Based couldn't open your workspace“) – und das Zeichen für den Store-Worker,
    // NICHT im Speicher weiterzumachen (sonst: leerer Workspace mit Willkommensseite, sieht aus wie Datenverlust).
    expect(openBlockedMessage(error)).toContain("Update Based to open it");
    // Fehler, bei denen Ausweichen vertretbar ist (Browser gibt keinen Speicher), bleiben unberührt.
    expect(openBlockedMessage(new PersistenceError("disk full", "sqlite"))).toBeUndefined();
    expect(openBlockedMessage(new Error("no OPFS"))).toBeUndefined();
    expect(openBlockedMessage(new PersistenceError("migration 9 failed", "migration"))).toContain("left the file unchanged");

    const check = openNodeDatabase(path);
    expect(check.all("PRAGMA user_version")).toEqual([{ user_version: future }]);
    expect(check.all("SELECT kind, id, data FROM records ORDER BY kind, id")).toEqual(before);
    expect(before.some((r) => (r as { id: string }).id === page)).toBe(true);
  });
});

describe("iCloud-Ordner: ein anderes Gerät schreibt schon ein neueres Format", () => {
  it("das Segment wartet (nichts übersprungen), die Runde meldet das Gerät; nach dem Update kommt alles an", async () => {
    const f = folder();
    const a = mac("macNew", f), b = mac("macOld", f);
    const p1 = createPage(a.store, { title: "One" });
    await a.sync.round();
    await b.sync.round();
    expect(b.store.blocks.get(p1)!.text).toBe("One");

    // Das neuere Gerät schreibt Segment 2 im Format v2 (hier: dieselbe Datei mit höherer Nummer im Kopf).
    const p2 = createPage(a.store, { title: "Two" });
    await a.sync.round();
    const name = `devices/macNew/${segmentName(2)}`;
    const v1 = dec.decode(f.files.get(name)!);
    const lines = v1.split("\n");
    const head = JSON.parse(lines[0]!) as Record<string, unknown>;
    f.files.set(name, enc.encode([JSON.stringify({ ...head, v: 2, envelope: "e2e" }), ...lines.slice(1)].join("\n")));
    expect(isNewerSegment(f.files.get(name)!)).toBe(true);
    // Segment 3 ist wieder lesbar – darf aber nicht vor 2 eingemischt werden (Reihenfolge).
    const p3 = createPage(a.store, { title: "Three" });
    await a.sync.round();

    const r = await b.sync.round();
    expect(r.newer).toEqual(["macNew"]);
    expect(r.waiting).toBe(1);
    expect(b.store.blocks.has(p2)).toBe(false);
    expect(b.store.blocks.has(p3)).toBe(false);
    expect(b.sync.state().seen.macNew).toBe(1);
    // Das ältere Gerät arbeitet weiter und schreibt weiter; das neuere liest es.
    const own = createPage(b.store, { title: "From the old Mac" });
    await b.sync.round();
    await a.sync.round();
    expect(a.store.blocks.get(own)!.text).toBe("From the old Mac");

    // „Update“ auf dem alten Mac: jetzt versteht er das Segment (hier: wieder v1) – alles kommt an, in Reihenfolge.
    f.files.set(name, enc.encode(v1));
    const after = await b.sync.round();
    expect(after.newer).toEqual([]);
    expect(b.store.blocks.get(p2)!.text).toBe("Two");
    expect(b.store.blocks.get(p3)!.text).toBe("Three");
  });

  it("eine Record-Art, die diese Version nicht kennt, zählt als neuer; eine nur halb geladene Datei nicht", async () => {
    const f = folder();
    const a = mac("macNew", f), b = mac("macOld", f);
    createPage(a.store, { title: "One" });
    await a.sync.round();
    const name = `devices/macNew/${segmentName(1)}`;
    const text = dec.decode(f.files.get(name)!);
    const lines = text.split("\n");
    const extra = JSON.stringify({ op: "put", record: { kind: "area", data: { id: "x", level: "private" } } });
    const head = JSON.parse(lines[0]!) as { count: number };
    const end = JSON.parse(lines[lines.length - 2]!) as { count: number };
    const withUnknown = [JSON.stringify({ ...head, count: head.count + 1 }), ...lines.slice(1, -2), extra, JSON.stringify({ ...end, count: end.count + 1 }), ""].join("\n");
    f.files.set(name, enc.encode(withUnknown));
    expect(isNewerSegment(enc.encode(withUnknown))).toBe(true);
    const r = await b.sync.round();
    expect(r.newer).toEqual(["macNew"]);
    expect(b.sync.state().seen.macNew ?? 0).toBe(0);
    // iCloud lädt noch (Datei abgeschnitten): warten, aber kein Update-Hinweis.
    f.files.set(name, enc.encode(text.slice(0, Math.floor(text.length / 2))));
    expect(isNewerSegment(f.files.get(name)!)).toBe(false);
    const half = await b.sync.round();
    expect(half.waiting).toBe(1);
    expect(half.newer).toEqual([]);
  });
});
