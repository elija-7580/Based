// Sync v2 über HTTP gegen den TS-Server: Endpunkte, Router (Auth, 404/405/413), Long-Poll, Tombstone-GC.
import { afterEach, describe, expect, it } from "vitest";
import type { WireRecord } from "@based/core";
import { createApp } from "../src/app.js";
import { silentLogger } from "../src/log.js";
import { auth, get, post, startApp, TOKEN } from "./helpers.js";

const page = (id: string, text: string, millis = 1000, node = "dev"): WireRecord => ({
  kind: "block",
  data: { id, type: "page", parent: "w", sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis, counter: 0, node } },
});

let apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});
const start = async (...a: Parameters<typeof startApp>) => {
  const app = await startApp(...a);
  apps.push(app);
  return app;
};

describe("Router", () => {
  it("ohne Token kein Server", () => {
    expect(() => createApp({ token: "", log: silentLogger })).toThrow(/token/);
  });

  it("Health öffentlich, alles andere nur mit Bearer-Token (nie über ?token=)", async () => {
    const app = await start();
    expect((await get(`${app.url}/health`, {})).body).toMatchObject({ ok: true, protocol: 2 });
    expect((await get(`${app.url}/sync/v2/info`, {})).status).toBe(401);
    expect((await get(`${app.url}/sync/v2/info`, { Authorization: "Bearer falsch" })).status).toBe(401);
    expect((await get(`${app.url}/sync/v2/info?token=${TOKEN}`, {})).status).toBe(401);
    expect((await post(`${app.url}/mcp`, {}, {})).status).toBe(401);
    expect((await get(`${app.url}/sync/v2/info`)).status).toBe(200);
  });

  it("404, 405 mit Allow, 413 bei zu großem Body, 400 bei kaputtem JSON", async () => {
    const app = await start();
    expect((await get(`${app.url}/nope`)).status).toBe(404);
    const r = await get(`${app.url}/sync/v2/push`);
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    expect((await post(`${app.url}/sync/v2/push`, "x".repeat(33 << 20))).status).toBe(413);
    expect((await post(`${app.url}/sync/v2/push`, "{kaputt")).status).toBe(400);
    expect((await post(`${app.url}/sync/v2/push`, { records: [{ kind: "block", data: { id: 1 } }], deletions: [] })).status).toBe(400);
    expect((await get(`${app.url}/sync/v2/pull?after=-1`)).status).toBe(400);
  });

  it("CORS nur für BASED_PUBLIC_URL", async () => {
    const app = await start({ allowedOrigin: "https://based.example" });
    const ok = await fetch(`${app.url}/health`, { headers: { Origin: "https://based.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://based.example");
    const other = await fetch(`${app.url}/health`, { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Sync v2", () => {
  it("info, push, pull in Seiten", async () => {
    const app = await start();
    expect((await get(`${app.url}/sync/v2/info`)).body).toMatchObject({ protocol: 2, seq: 0, oldestSeq: 0 });
    const records = Array.from({ length: 7 }, (_, i) => page(`p${i}`, `Seite ${i}`));
    const push = await post(`${app.url}/sync/v2/push`, { records, deletions: [] });
    expect(push.body).toEqual({ newer: [], seq: 7, deleted: [] });

    const seen: string[] = [];
    let after = 0;
    for (;;) {
      const r = (await get(`${app.url}/sync/v2/pull?after=${after}&limit=3`)).body as { records: WireRecord[]; next: number; more: boolean };
      seen.push(...r.records.map((x) => x.data.id));
      after = r.next;
      if (!r.more) break;
    }
    expect(seen).toEqual(records.map((r) => r.data.id));
    expect(after).toBe(7);
    expect((await get(`${app.url}/sync/v2/pull?after=7`)).body).toEqual({ records: [], deletions: [], next: 7, more: false });
  });

  it("newer: der Server hat eine neuere Version; Löschung verliert gegen neuere Bearbeitung", async () => {
    const app = await start();
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "neu", 5000)], deletions: [] });
    const r = await post(`${app.url}/sync/v2/push`, {
      records: [page("p1", "alt", 1000)],
      deletions: [],
    });
    expect((r.body!.newer as WireRecord[]).map((x) => x.data.text)).toEqual(["neu"]);
    const del = await post(`${app.url}/sync/v2/push`, { records: [], deletions: [{ kind: "block", id: "p1", stamp: { millis: 2000, counter: 0, node: "dev" } }] });
    expect((del.body!.newer as WireRecord[]).map((x) => x.data.id)).toEqual(["p1"]);
    expect(app.sync.store.blocks.get("p1")?.text).toBe("neu");
  });

  it("deleted: neuerer Tombstone schlägt einen älteren Push; Löschungen tragen ihren Stempel", async () => {
    const app = await start();
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "x", 1000)], deletions: [] });
    const stamp = { millis: 9000, counter: 0, node: "dev" };
    await post(`${app.url}/sync/v2/push`, { records: [], deletions: [{ kind: "block", id: "p1", stamp }] });
    const late = await post(`${app.url}/sync/v2/push`, { records: [page("p1", "offline bearbeitet", 5000)], deletions: [] });
    expect(late.body!.deleted).toEqual([{ kind: "block", id: "p1", stamp }]);
    const pulled = (await get(`${app.url}/sync/v2/pull?after=0`)).body!;
    expect(pulled.deletions).toEqual([{ kind: "block", id: "p1", stamp }]);
    expect(app.sync.store.blocks.has("p1")).toBe(false);
  });

  it("ungestempelte Löschung (ältere Clients) stempelt der Server beim Empfang", async () => {
    const app = await start();
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "x", 1000)], deletions: [] });
    await post(`${app.url}/sync/v2/push`, { records: [], deletions: [{ kind: "block", id: "p1" }] });
    const d = ((await get(`${app.url}/sync/v2/pull?after=0`)).body!.deletions as { stamp?: { node: string } }[])[0];
    expect(d?.stamp?.node).toBe("server");
  });

  it("wait: Long-Poll antwortet beim Push sofort, sonst nach dem Timeout; Verbindungsabbruch räumt auf", async () => {
    const app = await start();
    const t0 = Date.now();
    const waiting = get(`${app.url}/sync/v2/wait?after=0&timeout=10`);
    await new Promise((r) => setTimeout(r, 100));
    expect(app.sync.waiting).toBe(1);
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "x")], deletions: [] });
    expect((await waiting).body).toEqual({ seq: 1 });
    expect(Date.now() - t0).toBeLessThan(2000);

    const t1 = Date.now();
    expect((await get(`${app.url}/sync/v2/wait?after=1&timeout=1`)).body).toEqual({ seq: 1 });
    expect(Date.now() - t1).toBeGreaterThanOrEqual(900);

    const ac = new AbortController();
    const aborted = fetch(`${app.url}/sync/v2/wait?after=1&timeout=30`, { headers: auth, signal: ac.signal }).catch(() => "abgebrochen");
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    expect(await aborted).toBe("abgebrochen");
    await expect.poll(() => app.sync.waiting).toBe(0);
  });

  it("wait mit after hinter dem Stand antwortet sofort; Schließen des Servers beendet Long-Polls", async () => {
    const app = await startApp();
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "x")], deletions: [] });
    expect((await get(`${app.url}/sync/v2/wait?after=0&timeout=30`)).body).toEqual({ seq: 1 });
    const pending = get(`${app.url}/sync/v2/wait?after=1&timeout=30`).catch(() => ({ status: 0 }));
    await new Promise((r) => setTimeout(r, 100));
    const t = Date.now();
    await app.close();
    await pending;
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("Tombstone-GC: alte Löschzeilen weg, oldestSeq steigt, seq bleibt monoton", async () => {
    const app = await start();
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "x"), page("p2", "y")], deletions: [] });
    const old = { millis: Date.now() - 100 * 86_400_000, counter: 0, node: "dev" };
    await post(`${app.url}/sync/v2/push`, { records: [], deletions: [{ kind: "block", id: "p2", stamp: { ...old, millis: Date.now() } }] });
    // Neu gestempelte Löschung bleibt; eine 100 Tage alte (anderer Record) wird kompaktiert.
    await post(`${app.url}/sync/v2/push`, { records: [page("p3", "z", old.millis - 1)], deletions: [] });
    await post(`${app.url}/sync/v2/push`, { records: [], deletions: [{ kind: "block", id: "p3", stamp: old }] });
    expect(app.sync.compactTombstones()).toBe(1);
    const info = (await get(`${app.url}/sync/v2/info`)).body!;
    expect(info).toMatchObject({ protocol: 2, seq: 5, oldestSeq: 5 });
    const pulled = (await get(`${app.url}/sync/v2/pull?after=0`)).body!;
    expect((pulled.deletions as { id: string }[]).map((d) => d.id)).toEqual(["p2"]);
    expect(app.sync.compactTombstones()).toBe(0);
  });

  it("v1-Endpunkte für alte Apps: push/pull mit Stempel-Cursor", async () => {
    const app = await start();
    const r = await post(`${app.url}/sync/push`, { records: [page("p1", "v1", 3000)], deletions: [], cursor: { millis: 0, counter: 0, node: "" } });
    expect(r.status).toBe(200);
    const all = (await get(`${app.url}/sync/pull`)).body!;
    expect((all.records as WireRecord[]).map((x) => x.data.id)).toContain("p1");
    const since = encodeURIComponent(JSON.stringify(all.cursor));
    expect(((await get(`${app.url}/sync/pull?since=${since}`)).body!.records as unknown[]).length).toBe(0);
  });
});
