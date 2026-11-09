// BSD-149/151: Welche Module im TS-Kern schon portiert sind. Ein Port bekommt die Eingabe eines Falls und die
// Datei-Metadaten (z. B. Records, `now`) und liefert die Ausgabe im Fixture-Format. Nicht eingetragene Module
// werden übersprungen und im Bericht als „nicht portiert“ geführt.
// Offen: formulas, queries, values, conversion, search, clipboard.
import { compareStamps, isValidKey, keyBetween, keysBetween, keyOf, MemoryPersistence, parseRecord, parseStamp, plainText, StampClock, stampToString, WorkspaceStore } from "../../src/index.js";
import type { RecordKeyString, WireRecord } from "../../src/index.js";
import type { Stamp } from "../../src/hlc.js";
import type { FixtureCase } from "./load.js";

export type Port = (input: FixtureCase["input"], meta: Record<string, unknown>) => unknown;

type HlcInput =
  | { op: "compare"; a: Stamp; b: Stamp }
  | { op: "description"; stamp: Stamp }
  | { op: "parse"; text: string }
  | { op: "clock"; node: string; last: Stamp; maxDrift: number; steps: ({ op: "now"; wall: number } | { op: "observe"; wall: number; remote: Stamp })[] };

type SortKeysInput =
  | { op: "between"; a: string | null; b: string | null }
  | { op: "isValid"; key: string }
  | { op: "keys"; count: number; a: string | null; b: string | null };

const hlc: Port = (raw) => {
  const input = raw as HlcInput;
  switch (input.op) {
    case "compare": return compareStamps(input.a, input.b);
    case "description": return stampToString(input.stamp);
    case "parse": return parseStamp(input.text) ?? null;
    case "clock": {
      if (input.maxDrift !== StampClock.maxDrift) throw new Error("maxDrift weicht ab");
      const clock = new StampClock(input.node, input.last);
      return input.steps.map((s) => {
        clock.wallClock = () => s.wall;
        if (s.op === "now") return { result: clock.now() };
        const result = clock.observe(s.remote);
        return { result, current: clock.current };
      });
    }
  }
};

const sortkeys: Port = (raw) => {
  const input = raw as SortKeysInput;
  switch (input.op) {
    case "between": return keyBetween(input.a, input.b);
    case "isValid": return isValidKey(input.key);
    case "keys": return keysBetween(input.count, input.a, input.b);
  }
};

type MergeStep = { records: unknown[]; deletions: { kind: "block"; id: string; stamp: Stamp | null }[] };

const merge: Port = (raw) => {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "local", now: () => 0 });
  store.clock.wallClock = () => 1;
  return (raw as MergeStep[]).map((step) => {
    const stamps = new Map<RecordKeyString, Stamp>();
    for (const d of step.deletions) if (d.stamp) stamps.set(keyOf(d.kind, d.id), d.stamp);
    const r = store.applyRemote(step.records.map(parseRecord), step.deletions.map((d) => keyOf(d.kind, d.id)), stamps);
    const blocks: Record<string, unknown> = {};
    for (const id of [...store.blocks.keys()].sort()) {
      const b = store.blocks.get(id)!;
      blocks["block:" + id] = { stamp: b.stamp, title: plainText(b.text) };
    }
    return { stale: [...r.stale].sort(), tombstoned: Object.fromEntries(r.tombstoned), blocks };
  });
};

type UndoStep =
  | { op: "setText"; id: string; text: string }
  | { op: "delete"; ids: string[] }
  | { op: "remote"; record: unknown }
  | { op: "remoteDelete"; id: string; stamp: Stamp }
  | { op: "undo" | "redo" };

const undoRemote: Port = (raw, meta) => {
  const records = (meta.records as unknown[]).map(parseRecord) as WireRecord[];
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "local", now: () => 0 });
  let wall = 2000;
  store.clock.wallClock = () => wall;
  store.clearUndoHistory();
  return (raw as UndoStep[]).map((s) => {
    wall += 10;
    let result: unknown = null;
    switch (s.op) {
      case "setText": store.setText(s.id, s.text); break;
      case "delete": store.deleteBlocks(s.ids); break;
      case "remote": store.applyRemote([parseRecord(s.record)]); break;
      case "remoteDelete": store.applyRemote([], [keyOf("block", s.id)], new Map([[keyOf("block", s.id), s.stamp]])); break;
      default: result = s.op === "undo" ? store.undo() : store.redo();
    }
    const blocks: Record<string, unknown> = {};
    for (const id of ["l1", "l2", "l3"]) {
      const b = store.blocks.get(id);
      blocks[id] = b ? { text: plainText(b.text), trashed: b.trashedAt !== undefined, parent: b.parent } : null;
    }
    return { result, blocks, canUndo: store.canUndo, canRedo: store.canRedo };
  });
};

export const PORTS: Record<string, Port | undefined> = { hlc, sortkeys, merge, "undo-remote": undoRemote };
