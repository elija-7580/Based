// BSD-286: Geräte-Uhr gegen den Date-Header des Servers – Warnung und korrigierte Stempel.
import { describe, expect, it } from "vitest";
import { openWorkspace, SyncClient, clockSkewFrom, CLOCK_SKEW_LIMIT_MS } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { FakeServer } from "./fake-server.js";

const HOUR = 3_600_000;

function setup(deviceOffset: number) {
  const server = new FakeServer();
  const dated: typeof fetch = async (input, init) => {
    const res = await server.fetch(input, init);
    const headers = new Headers(res.headers);
    headers.set("date", new Date(Date.now()).toUTCString());
    return new Response(await res.text(), { status: res.status, headers });
  };
  const { store, persistence } = openWorkspace(openNodeDatabase());
  store.clock.wallClock = () => Date.now() + deviceOffset;
  const skews: (number | undefined)[] = [];
  const logs: string[] = [];
  const client = new SyncClient(store, persistence, { baseURL: "https://based.test", token: server.token, fetch: dated, onClockSkew: (s) => skews.push(s), log: (_l, m) => logs.push(m) });
  return { store, client, skews, logs };
}

describe("Uhr-Abweichung (BSD-286)", () => {
  it("clockSkewFrom: Sekunden-Auflösung und Laufzeit sind Rauschen; kein oder kaputter Header → undefined", () => {
    const t = Date.parse("2026-11-11T05:00:00.400Z");
    expect(clockSkewFrom("Wed, 11 Nov 2026 05:00:00 GMT", t, t + 100)).toBe(0);
    expect(clockSkewFrom("Wed, 11 Nov 2026 06:00:00 GMT", t, t)).toBe(HOUR - 400);
    expect(clockSkewFrom(null, t, t)).toBeUndefined();
    expect(clockSkewFrom("kaputt", t, t)).toBeUndefined();
  });

  it("Gerät geht eine Stunde nach: Warnung, neue Stempel mit Server-Zeit; stop() stellt die Geräte-Uhr wieder her", async () => {
    const { store, client, skews, logs } = setup(-HOUR);
    await client.syncNow();
    expect(client.clockSkew).toBeGreaterThan(HOUR - 5_000);
    expect(client.clockSkew).toBeLessThan(HOUR + 5_000);
    expect(skews).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/clock is off by/);
    expect(Math.abs(store.clock.now().millis - Date.now())).toBeLessThan(5_000);
    // Weitere Runden melden dieselbe Abweichung nicht erneut.
    await client.syncNow();
    expect(skews).toHaveLength(1);
    client.stop();
    expect(client.clockSkew).toBeUndefined();
    expect(skews.at(-1)).toBeUndefined();
    expect(Math.abs(store.clock.wallClock() - (Date.now() - HOUR))).toBeLessThan(5_000);
  });

  it("Gerät geht zwei Tage vor: negative Abweichung, Stempel werden nicht mehr in die Zukunft gesetzt", async () => {
    const { store, client } = setup(48 * HOUR);
    await client.syncNow();
    expect(client.clockSkew).toBeLessThan(-47 * HOUR);
    // Der HLC nimmt nie einen kleineren Stempel als den letzten; neue Stempel folgen ab hier der korrigierten Zeit.
    expect(store.clock.wallClock()).toBeLessThan(Date.now() + 5_000);
  });

  it("kleine Abweichung (30 s) bleibt ohne Warnung und ohne Korrektur", async () => {
    const { client, skews } = setup(30_000);
    await client.syncNow();
    expect(30_000).toBeLessThan(CLOCK_SKEW_LIMIT_MS);
    expect(client.clockSkew).toBeUndefined();
    expect(skews).toEqual([]);
  });
});
