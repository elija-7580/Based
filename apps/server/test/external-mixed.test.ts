// Gemischt (nur mit ci/server/swift-client-compat.sh): nach dem Swift-Client liest der TS-Client denselben Server.
// Jeder Record, den Swift-Clients geschrieben haben, muss im TS-Kern lesbar sein und byte-gleich zurückkommen.
import { describe, expect, it } from "vitest";
import { encodeRecord, safeParseRecord } from "@based/core";
import { openWorkspace, SyncClient } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";

const url = process.env.BASED_COMPAT_SERVER_URL;
const token = process.env.BASED_COMPAT_SERVER_TOKEN ?? "";

describe.skipIf(!url)("TS-Client nach dem Swift-Client am selben Server", () => {
  it("liest alles, was die Swift-Clients geschrieben haben", async () => {
    const raw: unknown[] = [];
    for (let after = 0; ; ) {
      const r = await fetch(`${url}/sync/v2/pull?after=${after}&limit=200`, { headers: { Authorization: `Bearer ${token}` } });
      const page = (await r.json()) as { records: unknown[]; next: number; more: boolean };
      raw.push(...page.records);
      after = page.next;
      if (!page.more) break;
    }
    expect(raw.length).toBeGreaterThan(50);
    const bad = raw.filter((r) => !safeParseRecord(r).ok);
    expect(bad).toEqual([]);

    const d = openWorkspace(openNodeDatabase());
    const c = new SyncClient(d.store, d.persistence, { baseURL: url!, token, pageSize: 97 });
    await c.syncOnce();
    expect(c.lastError).toBeUndefined();
    for (const r of raw) {
      const parsed = safeParseRecord(r);
      if (!parsed.ok || parsed.record.kind === "workspace") continue;
      const key = `${parsed.record.kind}:${parsed.record.data.id}` as const;
      expect(d.store.record(key) && encodeRecord(d.store.record(key)!), key).toBe(encodeRecord(parsed.record));
    }
    // Rückweg: nichts wird zurückgepusht.
    expect((await c.syncOnce()).pushed).toBe(0);
  });
});
