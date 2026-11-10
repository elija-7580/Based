// BSD-217: Notion-API-Client – Ziele aus Links, Seitenweise, Wiederholen, Fehler ohne Token, Abbrechen, Bericht.
// Die Übersetzung selbst prüfen die Golden Fixtures (fixtures/import/notion-api.utc.json).
import { describe, expect, it } from "vitest";
import { NotionAPIError, NotionClient, NotionWorkspaceImport, convertNotionFormula, notionTarget, parseNotionTargets, readableNotionFormula } from "../src/index.js";
import type { NotionTransport } from "../src/index.js";

const enc = new TextEncoder();
const json = (status: number, v: unknown, headers: Record<string, string> = {}) => ({ status, headers, body: enc.encode(JSON.stringify(v)) });

function scripted(answers: ((url: string, method: string, body?: string) => ReturnType<typeof json>)[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const t: NotionTransport = {
    async send(method, url, headers, body) {
      calls.push({ url, method, headers, ...(body !== undefined ? { body } : {}) });
      const a = answers.shift();
      if (!a) throw new Error("no answer");
      return a(url, method, body);
    },
  };
  return { t, calls };
}

describe("Notion-API", () => {
  it("Ziele aus Links und IDs", () => {
    expect(notionTarget("https://app.notion.com/p/25afa757a99a4c998c1fa9ec4a6051eb")).toBe("25afa757-a99a-4c99-8c1f-a9ec4a6051eb");
    expect(notionTarget("https://www.notion.so/team/Tasks-33333333333343338333333333333333?v=99999999999949998999000000000001")).toBe("33333333-3333-4333-8333-333333333333");
    expect(notionTarget("https://www.notion.so/x?p=11111111111141118111111111111111")).toBe("11111111-1111-4111-8111-111111111111");
    expect(notionTarget("hello")).toBeUndefined();
    const hub = "11111111-1111-4111-8111-111111111111", sub = "22222222-2222-4222-8222-222222222222";
    expect(parseNotionTargets(`${hub}\n${hub}, ${sub}`)).toEqual([hub, sub]);
  });

  it("seitenweise lesen, Version und Token im Header, 429 mit Retry-After", async () => {
    const { t, calls } = scripted([
      () => json(429, { code: "rate_limited", message: "slow" }, { "retry-after": "0" }),
      () => json(200, { results: [1, 2], has_more: true, next_cursor: "c2" }),
      () => json(200, { results: [3], has_more: false, next_cursor: null }),
    ]);
    const c = new NotionClient(" secret_abc ", t, { requestsPerSecond: 0 });
    expect(await c.paginateGet("users")).toEqual([1, 2, 3]);
    expect(c.requestCount).toBe(3);
    expect(calls[2]!.url).toBe("https://api.notion.com/v1/users?page_size=100&start_cursor=c2");
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer secret_abc", "Notion-Version": "2026-03-11" });
  });

  it("Fehler nennen die Anfrage, nie das Token", async () => {
    const { t } = scripted([() => json(404, { code: "object_not_found", message: "Could not find page" })]);
    const c = new NotionClient("secret_abc", t, { requestsPerSecond: 0 });
    const e = await c.get("pages/x").catch((x: unknown) => x) as NotionAPIError;
    expect(e.kind).toBe("notFound");
    expect(e.message).toContain("[GET /v1/pages/x, object_not_found]");
    expect(c.lastFailure).toBe("HTTP 404 [GET /v1/pages/x, object_not_found]: Could not find page");
    const imp = new NotionWorkspaceImport("secret_abc", t);
    const report = imp.diagnosticReport(["11111111-1111"], e, ["w1"], new Date("2026-11-10T22:00:00Z"));
    expect(report).not.toContain("secret_abc");
    expect(report).toContain("Notion-Version: 2026-03-11");
    expect(report).toContain("Targets: 11111111…");
    expect(report).toContain("  • w1");
  });

  it("401 bricht ab; Abbrechen über das Signal", async () => {
    const { t } = scripted([() => json(401, { code: "unauthorized", message: "API token is invalid." })]);
    await expect(new NotionClient("x", t, { requestsPerSecond: 0 }).get("users/me")).rejects.toMatchObject({ kind: "unauthorized" });
    const ctl = new AbortController();
    ctl.abort();
    const { t: t2 } = scripted([]);
    await expect(new NotionClient("x", t2, { requestsPerSecond: 0, signal: ctl.signal }).get("users/me")).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("Formeln übersetzen (wie Swift formulaConversion)", () => {
    const names = new Map([["a", "Price"], ["b", "Qty"], ["c:", 'Odd "Name"']]);
    expect(convertNotionFormula("{{notion:block_property:a:x:y}} * {{notion:block_property:b:x:y}}", names)).toBe('prop("Price") * prop("Qty")');
    expect(convertNotionFormula('if({{notion:block_property:a:x:y}} > 3, "big", "small")', names)).toBe('if(prop("Price") > 3, "big", "small")');
    expect(convertNotionFormula("{{notion:block_property:zz:x:y}} + 1", names)).toBeUndefined();
    expect(convertNotionFormula("unknownFn({{notion:block_property:a:x:y}})", names)).toBeUndefined();
    expect(readableNotionFormula("{{notion:block_property:b:x:y}} + 1", names)).toBe('prop("Qty") + 1');
  });

  it("Token prüfen", async () => {
    const { t } = scripted([() => json(200, { name: "Based import", bot: { workspace_name: "Elija" } })]);
    expect(await NotionWorkspaceImport.verify("x", t)).toBe("Based import · Elija");
  });
});
