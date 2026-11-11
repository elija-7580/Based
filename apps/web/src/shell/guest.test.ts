// BSD-235 Teil 2: Gast-Link lesen, Kennung, Ablage, /share/v1/me.
import { describe, expect, it } from "vitest";
import { fetchGuestMe, guestID, guestIDFromSearch, guestStartPage, loadGuest, parseShareFragment, rememberGuest } from "./guest.js";
import { memoryKV, SecretStore } from "./secrets.js";

describe("Gast-Modus (BSD-235)", () => {
  it("parseShareFragment: Server mit Pfad, Unterseite, kaputte Eingaben", () => {
    const url = "https://based.example.com/base/s/bdl_SECRET123/page-1";
    expect(parseShareFragment("#/share/" + encodeURIComponent(url))).toEqual({ server: "https://based.example.com/base", secret: "bdl_SECRET123", page: "page-1" });
    expect(parseShareFragment("#/share/" + encodeURIComponent("http://127.0.0.1:9000/s/bdl_x"))).toEqual({ server: "http://127.0.0.1:9000", secret: "bdl_x" });
    expect(parseShareFragment("#/share/" + encodeURIComponent("javascript:alert(1)//s/x"))).toBeUndefined();
    expect(parseShareFragment("#/share/%E0%A4%A")).toBeUndefined();
    expect(parseShareFragment("#prefs-sync")).toBeUndefined();
    expect(parseShareFragment("#/share/" + encodeURIComponent("https://x.example/p/abc"))).toBeUndefined();
  });

  it("Kennung verrät das Geheimnis nicht; Ablage verschlüsselt und wieder lesbar", async () => {
    const cfg = { server: "https://x.example", secret: "bdl_TOPSECRET" };
    const id = await guestID(cfg);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(guestIDFromSearch(`?guest=${id}`)).toBe(id);
    expect(guestIDFromSearch("?guest=../x")).toBeUndefined();
    const kv = memoryKV();
    const vault = new SecretStore(kv);
    expect(await rememberGuest(vault, cfg)).toBe(id);
    expect(JSON.stringify([...kv.map.entries()].map(([k, v]) => [k, v instanceof Object && "data" in (v as object) ? "sealed" : v]))).not.toContain("TOPSECRET");
    expect(await loadGuest(vault, id)).toEqual(cfg);
    expect(await loadGuest(vault, "0000000000000000")).toBeUndefined();
  });

  it("fetchGuestMe: Token als Bearer, 401 = widerrufen, Netzfehler = undefined; Startseite", async () => {
    const cfg = { server: "https://x.example/", secret: "bdl_s" };
    const seen: string[] = [];
    const ok: typeof fetch = async (input, init) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
      return new Response(JSON.stringify({ kind: "link", name: "Link", pages: [{ id: "p1", title: "Wiki", role: "edit" }] }), { status: 200 });
    };
    const me = await fetchGuestMe(cfg, ok);
    expect(seen).toEqual(["https://x.example/share/v1/me Bearer bdl_s"]);
    expect(me !== "revoked" && guestStartPage(cfg, me)).toBe("p1");
    expect(guestStartPage({ ...cfg, page: "sub" }, me === "revoked" ? undefined : me)).toBe("sub");
    expect(await fetchGuestMe(cfg, async () => new Response("", { status: 401 }))).toBe("revoked");
    expect(await fetchGuestMe(cfg, async () => { throw new TypeError("offline"); })).toBeUndefined();
  });
});
