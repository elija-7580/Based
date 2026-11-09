// Ein based-server für Tests, im Prozess: gleiche Regeln wie BasedBrain SyncServer (v2), gebaut aus demselben
// Kern (WorkspaceStore + SqlitePersistence mit Change-Log), so wie der Swift-Server Client-Code wiederverwendet.
import { keyOf, recordKey, WorkspaceStore, type RecordKeyString, type Stamp, type WireRecord } from "@based/core";
import { decodeDeletions, decodeRecords, SqlitePersistence } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";

export class FakeServer {
  readonly persistence = new SqlitePersistence(openNodeDatabase());
  readonly store = new WorkspaceStore({ persistence: this.persistence, node: "server" });
  token = "secret";
  oldestSeq = 0;
  /** Anfragen schlagen fehl, solange gesetzt (Offline-Simulation). */
  offline = false;
  requests: string[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (this.offline) throw new TypeError("fetch failed (offline)");
    this.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${this.token}`) return new Response("unauthorized", { status: 401 });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/sync/v2/info":
        return json({ protocol: 2, seq: this.persistence.maxSeq(), oldestSeq: this.oldestSeq });
      case "/sync/v2/wait": {
        const after = Number(url.searchParams.get("after") ?? 0);
        const deadline = Date.now() + Math.min(Number(url.searchParams.get("timeout") ?? 25), 55) * 1000;
        while (this.persistence.maxSeq() <= after && Date.now() < deadline) {
          if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
          await new Promise((r) => setTimeout(r, 10));
        }
        return json({ seq: this.persistence.maxSeq() });
      }
      case "/sync/v2/push":
        return json(this.push(JSON.parse(String(init?.body))));
      case "/sync/v2/pull":
        return json(this.pull(Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 500)));
      default:
        return new Response("not found", { status: 404 });
    }
  };

  push(body: { records: unknown; deletions: unknown }) {
    const records = decodeRecords(body.records);
    const del = decodeDeletions(body.deletions);
    // Ungestempelte Löschungen stempelt der Server beim Empfang.
    for (const k of del.keys) if (!del.stamps.has(k)) del.stamps.set(k, this.store.clock.now());
    const merge = this.store.applyRemote(records, del.keys, del.stamps);
    const newer: WireRecord[] = [];
    for (const k of merge.stale) {
      const r = this.store.record(k);
      if (r) newer.push(r);
    }
    // Eine Löschung, die gegen einen neueren Stand verlor, steht in `stale` (Record existiert noch) → newer.
    const deleted = [...merge.tombstoned].map(([k, stamp]) => ({ ...split(k), stamp }));
    return { newer, seq: this.persistence.maxSeq(), deleted };
  }

  pull(after: number, limit: number) {
    const entries = this.persistence.changes(after, limit);
    const records: WireRecord[] = [];
    const deletions: { kind: string; id: string; stamp?: Stamp }[] = [];
    for (const e of entries) {
      if (e.deleted) deletions.push(e.deletedStamp ? { ...split(e.key), stamp: e.deletedStamp } : split(e.key));
      else {
        const r = this.store.record(e.key);
        if (r) records.push(r);
      }
    }
    const last = entries[entries.length - 1];
    return { records, deletions, next: last ? last.seq : after, more: entries.length === limit };
  }

  /** Tombstone-GC wie SyncServer.compactTombstones: Löschzeilen bis `seq` entfernen, oldestSeq anheben. */
  compactTombstones() {
    const rows = this.persistence.db.all("SELECT seq FROM changes WHERE deleted = 1");
    let max = 0;
    for (const r of rows) max = Math.max(max, Number(r.seq));
    this.persistence.db.run("DELETE FROM changes WHERE deleted = 1");
    this.oldestSeq = Math.max(this.oldestSeq, max);
  }

  keys(): RecordKeyString[] {
    return this.store.allRecords().map(recordKey).sort();
  }
}

function split(key: RecordKeyString) {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}

export { keyOf };
