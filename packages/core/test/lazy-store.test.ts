// ADR 0017 Stufe B: Ein Store, der nach Bedarf lädt, verhält sich in jedem Schritt wie einer, der alles geladen hat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSkeletonBlock, LinkIndex, keyOf, keysBetween, MemoryPersistence, WorkspaceStore, type Block, type RecordKeyString, type Stamp, type WireRecord } from "../src/index.js";

/** Fester Zufall, damit ein Fehlschlag wiederholbar ist. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const block = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, text: id, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "seed" }, ...extra } }) as WireRecord;

function seedRecords(rnd: () => number): WireRecord[] {
  const out: WireRecord[] = [];
  const pages = keysBetween(6, undefined, undefined);
  for (let p = 0; p < 6; p++) {
    const pid = "P" + p;
    out.push(block(pid, "page", p < 3 ? "w" : "b:P" + (p - 3), pages[p]!, p === 5 ? { trashedAt: 5 } : {}));
    const keys = keysBetween(5, undefined, undefined);
    for (let j = 0; j < 5; j++) {
      const id = `${pid}-b${j}`;
      out.push(block(id, rnd() < 0.3 ? "toggle" : "text", "b:" + pid, keys[j]!));
      if (j === 1) out.push(block(`${id}-n`, "text", "b:" + id, "a0"), block(`${pid}-sub`, "page", "b:" + id, "a1"));
    }
  }
  return out;
}

const pair = (records: WireRecord[]) => {
  const now = () => 1000;
  const eagerP = new MemoryPersistence(records), lazyP = new MemoryPersistence(records);
  const open = () => ({
    eager: new WorkspaceStore({ persistence: eagerP, node: "dev", now, lazy: false, propertyRecords: false }),
    lazy: new WorkspaceStore({ persistence: lazyP, node: "dev", now, lazy: true, propertyRecords: false }),
  });
  return { open, eagerP, lazyP };
};

/** Alles, was ein Aufrufer sehen kann – ohne den lazy Store dafür ganz zu laden (nur am Ende). */
function sameView(eager: WorkspaceStore, lazy: WorkspaceStore, ids: string[], parents: string[], where: string) {
  for (const id of ids) expect(lazy.blocks.get(id), `${where}: block ${id}`).toEqual(eager.blocks.get(id));
  for (const p of parents) expect(lazy.children(p), `${where}: children ${p}`).toEqual(eager.children(p));
  expect(lazy.blocks.size, `${where}: size`).toBe(eager.blocks.size);
  expect([...lazy.skeletonBlocks()].map((b) => b.id).sort(), `${where}: skeleton`).toEqual([...eager.blocks.values()].filter(isSkeletonBlock).map((b) => b.id).sort());
}

describe("Laden nach Bedarf (ADR 0017 Stufe B)", () => {
  // Feste Zeit: beide Stores stempeln dann gleich, und der Vergleich darf die Stempel einschließen.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("öffnet mit dem Gerüst und holt Inhalt erst auf Nachfrage", () => {
    const { open } = pair(seedRecords(rng(1)));
    const { lazy } = open();
    expect(lazy.isPartial).toBe(true);
    expect(lazy.blocks.loadedSize).toBe(12); // 6 Seiten + 6 Unterseiten in Toggles
    expect(lazy.blocks.size).toBe(48);
    expect(lazy.children("b:P0")).toHaveLength(6); // 5 Blöcke + Seite P3
    expect(lazy.blocks.loadedSize).toBe(17);
    expect(lazy.blocks.get("P4-b1-n")?.parent).toBe("b:P4-b1");
    expect(lazy.blocks.get("nope")).toBeUndefined();
    expect(lazy.blocks.has("P2-b3")).toBe(true);
    expect(lazy.descendants("P1")).toHaveLength(7 + 1 + 7); // P1: 5 + n + sub; P4 darunter mit 5 + n + sub
    expect(lazy.fullLoads).toBe(0);
    expect([...lazy.blocks.values()]).toHaveLength(48);
    expect(lazy.fullLoads).toBe(1);
    expect(lazy.isPartial).toBe(false);
  });

  it("ein einzeln geholter Block macht die Kinderliste seines Elternteils nicht unvollständig", () => {
    const { open } = pair(seedRecords(rng(2)));
    const { eager, lazy } = open();
    lazy.blocks.get("P0-b3");
    expect(lazy.children("b:P0")).toEqual(eager.children("b:P0"));
    expect(lazy.endKey("b:P1")).toBe(eager.endKey("b:P1"));
  });

  it("leere Datei: von Anfang an vollständig (erster Sync ohne Rückfragen)", () => {
    const forced = WorkspaceStore.lazyEvenWhenEmpty;
    WorkspaceStore.lazyEvenWhenEmpty = false; // die Testsuite mit BASED_LAZY_STORE=1 schaltet das sonst ab
    try {
      const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "dev", lazy: true });
      expect(s.isPartial).toBe(false);
    } finally {
      WorkspaceStore.lazyEvenWhenEmpty = forced;
    }
  });

  it("entfernt und vor dem Speichern wieder gefragt: bleibt entfernt; zurückgerollt: wieder da", () => {
    const { open } = pair(seedRecords(rng(3)));
    const { lazy } = open();
    lazy.transact("t", (tx) => {
      tx.remove(keyOf("block", "P0-b0"));
      expect(lazy.blocks.get("P0-b0")).toBeUndefined();
      expect(lazy.blocks.has("P0-b0")).toBe(false);
    });
    expect(lazy.blocks.get("P0-b0")).toBeUndefined();
    expect(() => lazy.transact("t", (tx) => { tx.remove(keyOf("block", "P0-b2")); throw new Error("x"); })).toThrow("x");
    expect(lazy.blocks.get("P0-b2")?.id).toBe("P0-b2");
    expect(lazy.children("b:P0")).not.toContain("P0-b0");
    expect(lazy.children("b:P0")).toContain("P0-b2");
  });

  it("die Uhr setzt hinter nachgeladenen Stempeln fort", () => {
    const recs = seedRecords(rng(4));
    const far = { millis: Date.now() + 60_000, counter: 3, node: "other" }; // eine Minute voraus: die Uhr nimmt das an
    (recs.find((r) => r.data.id === "P0-b0")!.data as Block).stamp = far;
    const { open } = pair(recs);
    const { lazy } = open();
    lazy.transact("edit", (tx) => tx.update("P0-b0", (b) => { b.text = "neu"; }));
    const s = lazy.blocks.get("P0-b0")!.stamp as Stamp;
    expect(s.millis > far.millis || (s.millis === far.millis && s.counter > far.counter)).toBe(true);
  });

  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
    it(`zufällige Änderungen, Undo/Redo, Sync und Neuöffnen: gleich wie ein voll geladener Store (Saat ${seed})`, () => {
      const rnd = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const { open } = pair(seedRecords(rnd));
      let { eager, lazy } = open();
      const ids = seedRecords(rng(seed)).map((r) => r.data.id);
      let fresh = 0, remote = 100;
      const both = (f: (s: WorkspaceStore) => void) => { f(eager); f(lazy); };
      for (let step = 0; step < 220; step++) {
        const parents = ["w", ...ids.map((i) => "b:" + i)];
        const op = rnd();
        const id = pick(ids), target = pick(parents);
        if (op < 0.2) {
          const nid = `N${fresh++}`;
          ids.push(nid);
          const type = rnd() < 0.2 ? "page" : "text";
          both((s) => s.transact("add", (tx) => tx.put(block(nid, type, target, s.endKey(target)))));
        } else if (op < 0.4) {
          // verschieben (auch in noch nicht geladene Eltern) – nie unter sich selbst
          both((s) => { if (target !== "b:" + id && !s.descendants(id).includes(target.slice(2))) s.transact("move", (tx) => tx.update(id, (b) => { b.parent = target; b.sk = s.endKey(target); })); });
        } else if (op < 0.5) both((s) => s.transact("text", (tx) => tx.update(id, (b) => { b.text = "t" + step; })));
        else if (op < 0.6) both((s) => s.transact("del", (tx) => { for (const d of [id, ...s.descendants(id)]) tx.remove(keyOf("block", d)); }));
        else if (op < 0.68) both((s) => void s.undo());
        else if (op < 0.74) both((s) => void s.redo());
        else if (op < 0.9) {
          // ankommend: mal neuer, mal älter als der Stand hier, mal eine Löschung mit Stempel
          const kind = rnd();
          // neuer (die Uhr folgt), älter, oder weit in der Zukunft (die Uhr lehnt ab, der Record gewinnt trotzdem)
          const millis = kind < 0.4 ? Date.now() + 1000 + step : kind < 0.8 ? 0 : 5_000_000_000_000 + step;
          const stamp = { millis, counter: remote++, node: "remote" };
          const upsert = rnd() < 0.7;
          const cyclic = target === "b:" + id || eager.descendants(id).includes(target.slice(2));
          if (upsert && !cyclic) {
            const rec = block(id, "text", target, "a" + step, { text: "remote " + step, stamp });
            both((s) => { const r = s.applyRemote([rec]); expect(r).toBeDefined(); });
          } else if (!upsert) both((s) => void s.applyRemote([], [keyOf("block", id) as RecordKeyString], new Map([[keyOf("block", id) as RecordKeyString, stamp]])));
        } else ({ eager, lazy } = open()); // neu öffnen: wieder nur das Gerüst
        expect(lazy.clock.current, `Uhr nach Schritt ${step} (op ${op.toFixed(2)}, ${id} → ${target})`).toEqual(eager.clock.current);
        if (step % 7 === 0) sameView(eager, lazy, [pick(ids), pick(ids), pick(ids)], [pick(parents), pick(parents), "w"], `Schritt ${step}`);
      }
      expect(lazy.fullLoads, "bis hierher nie alles geladen").toBe(0);
      sameView(eager, lazy, ids, ["w", ...ids.map((i) => "b:" + i)], "Ende");
      const sorted = (s: WorkspaceStore) => s.allRecords().map((r) => JSON.stringify(r)).sort();
      expect(sorted(lazy)).toEqual(sorted(eager));
      const reopened = open();
      expect(sorted(reopened.lazy)).toEqual(sorted(reopened.eager));
    });
  }

  it("Backlinks: der Link-Index aus der Datei ist derselbe wie über alle Blöcke – ohne alles zu laden", () => {
    const recs = seedRecords(rng(7));
    const text = (id: string, t: unknown) => { (recs.find((r) => r.data.id === id)!.data as Block).text = t as Block["text"]; };
    text("P0-b0", [{ t: "see " }, { t: "P2", mention: { page: { _0: "P2" } } }]);
    text("P1-b1-n", [{ t: "link", m: { link: "based://page/P2" } }]);
    (recs.find((r) => r.data.id === "P3-b4")!.data as Block).props = { linkTarget: "P2" };
    text("P4-b2", "based: kein Link, nur das Wort");
    const { open } = pair(recs);
    const { eager, lazy } = open();
    expect(LinkIndex.fromStore(lazy).backlinks(lazy, "P2")).toEqual(LinkIndex.fromStore(eager).backlinks(eager, "P2"));
    expect(LinkIndex.fromStore(lazy).backlinks(lazy, "P2")).toEqual(["P0", "P1", "P3"]);
    expect(lazy.fullLoads).toBe(0);
  });
});
