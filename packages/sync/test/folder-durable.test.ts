// BSD-431: Ordner-Sync (iCloud) verliert keine eigenen Änderungen – auch nicht bei Absturz zwischen Änderung und Runde,
// bei einer Änderung während des Schreibens oder bei einem Absturz nach dem Schreiben, vor dem Sichern des Zustands.
import { describe, expect, it } from "vitest";
import { createPage, renamePage, type WorkspaceStore } from "@based/core";
import { FolderSync, openWorkspace, segmentName, type FolderSyncState, type FolderTarget, type SqlitePersistence } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";

function folder(): FolderTarget & { files: Map<string, Uint8Array>; gate?: Promise<void> | undefined } {
  const files = new Map<string, Uint8Array>();
  const t: FolderTarget & { files: Map<string, Uint8Array>; gate?: Promise<void> | undefined } = {
    files,
    async list(dir) {
      const out = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(dir + "/")) out.add(k.slice(dir.length + 1).split("/")[0]!);
      return [...out];
    },
    async write(p, d) { if (t.gate) await t.gate; files.set(p, d.slice()); },
    async read(p) { const d = files.get(p); if (!d) throw new Error("missing"); return d; },
    async remove(p) { files.delete(p); },
  };
  return t;
}

type Dev = { store: WorkspaceStore; persistence: SqlitePersistence; saved: FolderSyncState | undefined; sync: FolderSync };
/** Ein Mac mit dem lokalen Server: SQLite mit Change-Log, Zustand wird wie im Server sofort gesichert. */
function device(name: string, target: FolderTarget, ws = openWorkspace(openNodeDatabase(), { node: name }), state?: FolderSyncState): Dev {
  const d: Dev = { store: ws.store, persistence: ws.persistence, saved: state, sync: undefined as unknown as FolderSync };
  d.sync = new FolderSync({ store: ws.store, target, device: name, enabled: true, exportRemote: true, changeLog: ws.persistence,
    saveState: (s) => { d.saved = structuredClone(s); }, ...(state ? { state } : {}) });
  return d;
}
/** Neustart desselben Macs: gleiche Datenbank, gespeicherter Zustand (wie aus meta gelesen). */
const restart = (d: Dev, name: string, target: FolderTarget, state = d.saved) => {
  d.sync.stop();
  return device(name, target, { store: d.store, persistence: d.persistence } as ReturnType<typeof openWorkspace>, state);
};

describe("BSD-431 Ordner-Sync ohne Verluste", () => {
  it("Absturz zwischen Änderung und Runde: nach dem Neustart kommt die Änderung in den Ordner und beim anderen Mac an", async () => {
    const f = folder();
    const a = device("macA", f), b = device("macB", f);
    const p = createPage(a.store, { title: "Before crash" });
    // keine Runde, kein stop(): Prozess weg
    const a2 = restart(a, "macA", f);
    await a2.sync.round();
    await b.sync.round();
    expect(b.store.blocks.get(p)?.text).toBe("Before crash");
  });

  it("Änderung während des Schreibens geht ins nächste Segment", async () => {
    const f = folder();
    const a = device("macA", f), b = device("macB", f);
    const p = createPage(a.store, { title: "v1" });
    let open!: () => void;
    f.gate = new Promise<void>((r) => { open = r; });
    const pushing = a.sync.push();
    await new Promise((r) => setTimeout(r, 5));
    renamePage(a.store, p, "v2"); // während target.write wartet
    open();
    await pushing;
    f.gate = undefined;
    await a.sync.push();
    await b.sync.round();
    expect(b.store.blocks.get(p)?.text).toBe("v2");
  });

  it("Absturz nach dem Schreiben, vor dem Sichern: Segment N wird nicht überschrieben, der andere Mac bekommt alles", async () => {
    const f = folder();
    const a = device("macA", f), b = device("macB", f);
    const p1 = createPage(a.store, { title: "One" });
    await a.sync.push();
    await b.sync.round(); // B hat Segment 1 gelesen
    const stale = { nextSeq: 1, seen: {} }; // Zustand vor dem Schreiben (nicht gesichert)
    const p2 = createPage(a.store, { title: "Two" });
    const a2 = restart(a, "macA", f, stale);
    await a2.sync.push();
    expect([...f.files.keys()].filter((k) => k.startsWith("devices/macA/") && k.endsWith(".jsonl")).sort())
      .toEqual([`devices/macA/${segmentName(1)}`, `devices/macA/${segmentName(2)}`]);
    await b.sync.round();
    expect(b.store.blocks.get(p1)?.text).toBe("One");
    expect(b.store.blocks.get(p2)?.text).toBe("Two");
  });

  it("was aus dem Ordner kam, geht nicht zurück; der Zustand wird nach jedem Segment gesichert", async () => {
    const f = folder();
    const a = device("macA", f), b = device("macB", f);
    createPage(b.store, { title: "From B" });
    await b.sync.round();
    await a.sync.round(); // A liest B, schreibt (anfangs) nur eigene Änderungen
    const before = [...f.files.keys()].filter((k) => k.startsWith("devices/macA/") && k.endsWith(".jsonl")).length;
    await a.sync.round();
    const after = [...f.files.keys()].filter((k) => k.startsWith("devices/macA/") && k.endsWith(".jsonl")).length;
    expect(after).toBe(before);
    const text = [...f.files.entries()].filter(([k]) => k.startsWith("devices/macA/") && k.endsWith(".jsonl")).map(([, v]) => new TextDecoder().decode(v)).join("");
    expect(text).not.toContain("From B");
    expect(a.saved?.pushedSeq).toBeGreaterThan(0);
    expect(b.saved?.nextSeq).toBe(2);
  });
});
