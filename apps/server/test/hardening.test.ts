// BSD-75: Server-Härtung – Long-Poll ereignisgesteuert mit Grenzen je Client und gesamt, Logs ohne Nutzerinhalte.
import { afterEach, describe, expect, it } from "vitest";
import type { WireRecord } from "@based/core";
import { createLogger } from "../src/log.js";
import { auth, post, startApp } from "./helpers.js";
import { WorkspaceStore as PinnedStore } from "@based/core";

// Diese Datei prüft das alte Format (Properties im Datenbank-Record, Protokoll 2) – auch wenn die Suite sonst mit
// BASED_PROPERTY_RECORDS=1 läuft (BSD-30).
PinnedStore.propertyRecordsByDefault = false;

const page = (id: string, text: string, millis = 1000): WireRecord => ({
  kind: "block",
  data: { id, type: "page", parent: "w", sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis, counter: 0, node: "dev" } },
} as WireRecord);

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

describe("Long-Poll (BSD-75)", () => {
  it("50 gleichzeitige waits werden von einer Änderung sofort beantwortet, ohne Abfrageschleife", async () => {
    const app = await startApp({ maxWaitsPerClient: 64 });
    apps.push(app);
    const waits = Array.from({ length: 50 }, () => fetch(`${app.url}/sync/v2/wait?after=0&timeout=30`, { headers: auth }).then((r) => r.json() as Promise<{ seq: number }>));
    await expect.poll(() => app.sync.waiting).toBe(50);
    const t0 = Date.now();
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "hello")], deletions: [] });
    const answers = await Promise.all(waits);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(answers.every((a) => a.seq > 0)).toBe(true);
    expect(app.sync.waiting).toBe(0);
  });

  it("Grenze je Client: darüber 429 mit Retry-After; abgebrochene waits geben ihren Platz frei", async () => {
    const lines: string[] = [];
    const app = await startApp({ maxWaitsPerClient: 2, log: createLogger({ write: (l) => lines.push(l) }) });
    apps.push(app);
    const ctl = new AbortController();
    const a = fetch(`${app.url}/sync/v2/wait?after=0&timeout=30`, { headers: auth, signal: ctl.signal }).catch(() => undefined);
    const b = fetch(`${app.url}/sync/v2/wait?after=0&timeout=30`, { headers: auth }).then((r) => r.status);
    await expect.poll(() => app.sync.waiting).toBe(2);
    const third = await fetch(`${app.url}/sync/v2/wait?after=0&timeout=30`, { headers: auth });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("5");
    ctl.abort();
    await a;
    await expect.poll(() => app.sync.waiting).toBe(1);
    const fourth = fetch(`${app.url}/sync/v2/wait?after=0&timeout=30`, { headers: auth }).then((r) => r.status);
    await expect.poll(() => app.sync.waiting).toBe(2);
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "Geheimer Titel")], deletions: [] });
    expect(await b).toBe(200);
    expect(await fourth).toBe(200);
    // Logs: Grenze gemeldet, kein Nutzerinhalt, kein Token, keine Query.
    const all = lines.join("\n");
    expect(all).toContain("long-poll limit");
    expect(all).not.toContain("Geheimer Titel");
    expect(all).not.toContain("after=0");
  });

  it("Gesamtgrenze", async () => {
    const app = await startApp({ maxWaitsPerClient: 10, maxWaits: 1 });
    apps.push(app);
    const a = fetch(`${app.url}/sync/v2/wait?after=0&timeout=30`, { headers: auth }).then((r) => r.status);
    await expect.poll(() => app.sync.waiting).toBe(1);
    expect((await fetch(`${app.url}/sync/v2/wait?after=0&timeout=30`, { headers: auth })).status).toBe(429);
    await post(`${app.url}/sync/v2/push`, { records: [page("p2", "x")], deletions: [] });
    expect(await a).toBe(200);
  });
});
