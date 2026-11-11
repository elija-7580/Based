// BSD-279 (Review Sync): Ein Gerät mit vorgehender Uhr darf eine Seite nicht für alle anderen einfrieren.
import { afterEach, describe, expect, it } from "vitest";
import type { WireRecord } from "@based/core";
import { post, startApp } from "./helpers.js";

const HOUR = 3_600_000;
const page = (id: string, text: string, millis: number, node = "dev"): WireRecord => ({
  kind: "block",
  data: { id, type: "page", parent: "w", sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis, counter: 0, node } },
} as WireRecord);

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

describe("Stempel aus der Zukunft (BSD-279)", () => {
  it("Record mit Stempel > 1 h voraus bekommt den Empfangsstempel; spätere Änderung eines anderen Geräts gewinnt", async () => {
    const app = await startApp();
    apps.push(app);
    const now = Date.now();
    await post(`${app.url}/sync/v2/push`, { records: [page("p1", "falsche Uhr", now + 30 * 24 * HOUR, "skewed")], deletions: [] });
    const stored = app.sync.pull(0).records.find((r) => r.data.id === "p1")!;
    expect(stored.data.text).toBe("falsche Uhr");
    expect((stored.data.stamp as { millis: number }).millis).toBeLessThan(now + HOUR);
    const r = await post(`${app.url}/sync/v2/push`, { records: [page("p1", "richtig", Date.now() + 1000, "ok")], deletions: [] });
    expect(r.body?.newer).toEqual([]);
    expect(app.sync.pull(0).records.find((x) => x.data.id === "p1")!.data.text).toBe("richtig");
  });

  it("Stempel bis 1 h voraus bleiben unverändert", async () => {
    const app = await startApp();
    apps.push(app);
    const millis = Date.now() + 30 * 60_000;
    await post(`${app.url}/sync/v2/push`, { records: [page("p2", "x", millis)], deletions: [] });
    expect((app.sync.pull(0).records.find((r) => r.data.id === "p2")!.data.stamp as { millis: number }).millis).toBe(millis);
  });

  it("Löschung mit Zukunftsstempel friert den Tombstone nicht ein", async () => {
    const app = await startApp();
    apps.push(app);
    await post(`${app.url}/sync/v2/push`, { records: [page("p3", "a", Date.now())], deletions: [] });
    const far = Date.now() + 365 * 24 * HOUR;
    await post(`${app.url}/sync/v2/push`, { records: [], deletions: [{ kind: "block", id: "p3", stamp: { millis: far, counter: 0, node: "skewed" } }] });
    const del = app.sync.pull(0).deletions.find((d) => d.id === "p3")!;
    expect(del.stamp!.millis).toBeLessThan(Date.now() + HOUR);
    // Wiederherstellen von einem Gerät mit richtiger Uhr ist möglich.
    await post(`${app.url}/sync/v2/push`, { records: [page("p3", "wieder da", Date.now() + 1000, "ok")], deletions: [] });
    expect(app.sync.pull(0).records.find((r) => r.data.id === "p3")?.data.text).toBe("wieder da");
  });
});

describe("Date-Header für den Uhrvergleich (BSD-286)", () => {
  it("jede Antwort hat Date; für den erlaubten Origin ist er im Browser lesbar", async () => {
    const app = await startApp({ allowedOrigin: "https://web.example" });
    apps.push(app);
    const r = await fetch(`${app.url}/sync/v2/info`, { headers: { Authorization: "Bearer test-token-0123456789", Origin: "https://web.example" } });
    expect(Math.abs(Date.parse(r.headers.get("date")!) - Date.now())).toBeLessThan(5_000);
    expect(r.headers.get("access-control-expose-headers")).toBe("Date");
  });
});
