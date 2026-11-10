// ShareAPI gegen einen nachgebildeten Server: Pfade, Header, Fehler; publishedLink.
import { describe, expect, it } from "vitest";
import { ShareAPI, ShareAPIError, publishedLink, shareErrorMessage, shareURL } from "../src/share.js";

function fakeFetch(reply: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = reply(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("ShareAPI", () => {
  it("veröffentlicht, liest die Zugangsliste, widerruft – mit Bearer-Token, ohne Token in der URL", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith("/share/v1/links") ? { status: 200, body: { id: "L1", kind: "publish", role: "view", pageID: "P", label: null, active: true, path: "/p/L1" } }
        : url.includes("/share/v1/pages/") ? { status: 200, body: { pageID: "P", people: [], links: [{ id: "L1", kind: "publish", role: "view", pageID: "P", label: null, active: true, inherited: false }] } }
          : { status: 200, body: { ok: true } });
    const api = new ShareAPI({ url: "https://based.example.com/", token: "secret-token", fetch: f });
    const link = await api.publish("P");
    expect(link.path).toBe("/p/L1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ pageID: "P", kind: "publish", role: "view" });
    expect(publishedLink(await api.access("P"))?.id).toBe("L1");
    await api.revoke("L1");
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "https://based.example.com/share/v1/links"],
      ["GET", "https://based.example.com/share/v1/pages/P"],
      ["POST", "https://based.example.com/share/v1/links/L1/revoke"],
    ]);
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
      expect(c.url).not.toContain("secret-token");
    }
    expect(shareURL("https://based.example.com/", "/p/L1")).toBe("https://based.example.com/p/L1");
  });

  it("Fehler mit verständlichen Meldungen; geerbter Publish-Link zählt nicht", async () => {
    const { f } = fakeFetch(() => ({ status: 404, body: { error: "not found" } }));
    const err = await new ShareAPI({ url: "http://x", token: "t", fetch: f }).access("P").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShareAPIError);
    expect(shareErrorMessage(err)).toContain("isn't on the server yet");
    expect(shareErrorMessage(new ShareAPIError(403, "forbidden"))).toBe("You need full access to share this page.");
    expect(shareErrorMessage(new TypeError("fetch failed"))).toContain("Can't reach the server");
    expect(publishedLink({ pageID: "P", people: [], links: [{ id: "x", kind: "publish", role: "view", pageID: "Q", label: null, active: true, inherited: true }] })).toBeUndefined();
  });
});
