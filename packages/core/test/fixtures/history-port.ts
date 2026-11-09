// BSD-73: Port für fixtures/history (Swift VersionHistory.swift): Kodierung/Hash, versionBlocks, Aufzeichnen mit
// Dedup, Ausdünnen/Aufräumen, Wiederherstellen mit Undo.
import { historyHash, encodeVersionBlock, MemoryHistoryStorage, MemoryPersistence, parseRecord, plainText, restoreVersion, versionBlocks, VersionHistory, WorkspaceStore } from "../../src/index.js";
import type { Block, HistoryVersion } from "../../src/index.js";

type Input =
  | { op: "encode"; blocks: Block[] }
  | { op: "hash"; texts: string[] }
  | { op: "versionBlocks"; pageID: string }
  | { op: "record"; steps: { blocks: Block[]; title: string; reason: string; at: number }[] }
  | { op: "prune"; now: number; steps: { pageID: string; at: number; blocks: Block[] }[] }
  | { op: "restore"; records: unknown[]; version: Block[] };

const versionJSON = (v: HistoryVersion | null) =>
  v && { id: v.id, at: v.at, manifest: v.manifest, title: v.title, blockCount: v.blockCount, wordCount: v.wordCount, reason: v.reason };


function summary(store: WorkspaceStore) {
  const out: Record<string, unknown> = {};
  for (const b of store.blocks.values()) {
    const e: Record<string, unknown> = { type: b.type, parent: b.parent, sk: b.sk, text: plainText(b.text), trashed: b.trashedAt !== undefined };
    if (b.props?.checked !== undefined) e.checked = b.props.checked;
    out[b.id] = e;
  }
  return out;
}

export const historyPort = (raw: unknown, meta: Record<string, unknown>): unknown => {
  const input = raw as Input;
  switch (input.op) {
    case "encode":
      return input.blocks.map((b) => {
        const json = encodeVersionBlock(b);
        return { json, hash: historyHash(json) };
      });
    case "hash": return input.texts.map((t) => historyHash(t));
    case "versionBlocks": return versionBlocks(new WorkspaceStore({ persistence: new MemoryPersistence((meta.records as unknown[]).map(parseRecord)), node: "local" }), input.pageID).map((b) => b.id);
    case "record": {
      const h = new VersionHistory(new MemoryHistoryStorage(), { compress: false });
      const steps = input.steps.map((s) => {
        const v = h.record("page", s.blocks, s.title, s.reason, s.at);
        const out: Record<string, unknown> = { version: versionJSON(v), stats: h.stats() };
        if (v) {
          const r = h.blocksOf(v);
          if (r.missing.length) throw new Error("fehlende Objekte");
          out.read = r.blocks;
        }
        return out;
      });
      return { steps, versions: h.versions("page").map(versionJSON) };
    }
    case "prune": {
      const h = new VersionHistory(new MemoryHistoryStorage(), { compress: false });
      for (const s of input.steps) h.record(s.pageID, s.blocks, s.pageID, "edit", s.at);
      const removed = h.prune(input.now);
      const garbage = h.collectGarbage();
      const remaining = ["A", "B"].flatMap((p) => h.versions(p).map((v) => ({ pageID: p, at: v.at })));
      return { removed, garbage, remaining, stats: h.stats() };
    }
    case "restore": {
      const records = input.records.map(parseRecord);
      const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "local", now: () => 0 });
      store.clock.wallClock = () => 2000;
      restoreVersion(store, "page", input.version);
      const after = summary(store);
      const undo = store.undo();
      return { after, undo: summary(store), undoName: undo.name };
    }
  }
};
