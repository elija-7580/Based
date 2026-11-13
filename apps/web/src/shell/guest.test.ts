// BSD-235 Teil 2: Gast-Link lesen, Kennung, Ablage, /share/v1/me.
import { describe, expect, it, vi } from "vitest";
import { fetchGuestMe, guestID, guestIDFromSearch, guestStartPage, loadGuest, parseShareFragment, rememberGuest, watchGuestRevocation } from "./guest.js";
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

describe("BSD-282: endgültig löschen im Gast-Modus", () => {
  it("nur mit „Full access“; unbekannte Rolle zählt als „Can edit“", async () => {
    const { mayDeleteForever, setGuestAccess } = await import("./guest.js");
    expect(mayDeleteForever()).toBe(true); // Besitzer
    setGuestAccess({ pages: [{ id: "a", title: "A", role: "edit" }] });
    expect(mayDeleteForever()).toBe(false);
    setGuestAccess(undefined);
    expect(mayDeleteForever()).toBe(false);
    setGuestAccess({ pages: [{ id: "a", title: "A", role: "edit" }, { id: "b", title: "B", role: "full" }] });
    expect(mayDeleteForever()).toBe(true);
  });
});

describe("BSD-235: nur lesen bei „Can view“/„Can comment“", () => {
  it("nächste geteilte Seite nach oben entscheidet; ohne Gast/Rolle oder ohne Treffer: bearbeiten", async () => {
    const { guestMayEdit, setGuestAccess } = await import("./guest.js");
    const parents: Record<string, string> = { child: "viewed", grand: "child", row: "edited" };
    const parentOf = (id: string) => parents[id];
    setGuestAccess({ pages: [{ id: "viewed", title: "V", role: "view" }, { id: "edited", title: "E", role: "edit" }, { id: "c", title: "C", role: "comment" }] });
    expect(guestMayEdit("viewed", parentOf)).toBe(false);
    expect(guestMayEdit("grand", parentOf)).toBe(false);
    expect(guestMayEdit("c", parentOf)).toBe(false);
    expect(guestMayEdit("row", parentOf)).toBe(true);
    expect(guestMayEdit("elsewhere", parentOf)).toBe(true);
    // Unterseite mit eigener Freigabe „edit“ unter einer „view“-Seite: die nähere gilt
    setGuestAccess({ pages: [{ id: "viewed", title: "V", role: "view" }, { id: "child", title: "C", role: "full" }] });
    expect(guestMayEdit("grand", parentOf)).toBe(true);
    setGuestAccess(undefined);
    expect(guestMayEdit("viewed", parentOf)).toBe(true);
  });
});

describe("Widerruf während der Gast offen ist (BSD-235 Teil 3)", () => {
  it("prüft im Takt und bei Ereignissen; ruft onRevoked genau einmal; Netzfehler zählen nicht", async () => {
    vi.useFakeTimers();
    let status = 200;
    let fail = false;
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      if (fail) throw new TypeError("offline");
      return new Response(JSON.stringify({ role: "edit", pages: [] }), { status });
    }) as unknown as typeof fetch;
    const events = new EventTarget();
    let revoked = 0;
    const w = watchGuestRevocation({ server: "https://s.example", secret: "bdl_x" }, () => { revoked++; }, { intervalMs: 1000, fetcher, events });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(revoked).toBe(0);
    fail = true;
    events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(revoked).toBe(0);
    fail = false;
    status = 403;
    w.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(revoked).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    events.dispatchEvent(new Event("focus"));
    expect(revoked).toBe(1);
    expect(calls).toHaveLength(3);
    vi.useRealTimers();
  });
});
