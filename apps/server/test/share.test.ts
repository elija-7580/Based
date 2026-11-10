// Teilen (docs/sharing.md): Rollen und Vererbung, gefilterter Pull/Push, Löschung beim Herausbewegen, gehashte
// Geheimnisse, Widerruf, Einladungen, Publish to web (ohne Token lesbar, privater Bereich nicht).
import { createHash } from "node:crypto";
import { keyOf } from "@based/core";
import { afterEach, describe, expect, it } from "vitest";
import { META_KEY } from "../src/share.js";
import { auth, get, post, startApp } from "./helpers.js";

let apps: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

async function setup() {
  const app = await startApp();
  apps.push(app);
  const shared = app.pages.create({ title: "Team Wiki", markdown: "Welcome to the wiki" });
  const sub = app.pages.create({ title: "Onboarding", parent: shared, markdown: "First day" });
  const priv = app.pages.create({ title: "Private Diary", markdown: "secret thoughts" });
  return { app, shared, sub, priv };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function createLink(url: string, pageID: string, kind: string, role: string, headers = auth) {
  const r = await post(`${url}/share/v1/links`, { pageID, kind, role }, headers);
  return r as { status: number; body: Record<string, string> };
}

async function text(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers, redirect: "manual" });
  return { status: r.status, body: await r.text(), headers: r.headers };
}

describe("Freigaben: Rollen und Vererbung", () => {
  it("eine Rolle auf einer Seite gilt für Unterseiten, nicht für Geschwister; höchste Rolle gewinnt", async () => {
    const { app, shared, sub, priv } = await setup();
    const view = app.share.createLink("access", shared, "view", { kind: "owner" });
    const p = app.share.principal(view.secret!)!;
    expect(app.share.rolePage(p, shared)).toBe("view");
    expect(app.share.rolePage(p, sub)).toBe("view");
    expect(app.share.rolePage(p, priv)).toBeUndefined();
    // Nutzer mit zwei Grants: auf der Unterseite gewinnt die höhere
    const inv = app.share.createLink("invite", shared, "view", { kind: "owner" });
    const { user, token } = app.share.acceptInvite(inv.secret!, "Ada");
    app.share.setGrant(user.id, sub, "edit", { kind: "owner" });
    const u = app.share.principal(token)!;
    expect(app.share.rolePage(u, shared)).toBe("view");
    expect(app.share.rolePage(u, sub)).toBe("edit");
    expect(app.share.roots(u).map((r) => r.pageID)).toEqual([shared]);
  });

  it("Regeln beim Anlegen: Publish nur lesend, Access-Link nie voll, nicht mehr geben als man hat", async () => {
    const { app, shared } = await setup();
    expect((await createLink(app.url, shared, "publish", "edit")).status).toBe(400);
    expect((await createLink(app.url, shared, "access", "full")).status).toBe(400);
    const inv = app.share.createLink("invite", shared, "edit", { kind: "owner" });
    const { token } = app.share.acceptInvite(inv.secret!, "Bob");
    // Gast mit „edit“ darf nicht teilen
    expect((await createLink(app.url, shared, "access", "view", bearer(token))).status).toBe(403);
    expect((await get(`${app.url}/share/v1/pages/${shared}`, bearer(token))).status).toBe(403);
  });
});

describe("Gefilterter Sync", () => {
  it("Pull zeigt nur den geteilten Bereich; herausbewegte Seiten kommen mit Inhalt als Löschung an", async () => {
    const { app, shared, sub, priv } = await setup();
    const { body } = await createLink(app.url, shared, "access", "edit");
    const guest = bearer(body.secret!);
    const first = await get(`${app.url}/sync/v2/pull?after=0&limit=5000`, guest);
    expect(first.status).toBe(200);
    const ids = (first.body!.records as { kind: string; data: { id: string } }[]).map((r) => r.data.id);
    expect(ids).toContain(shared);
    expect(ids).toContain(sub);
    expect(ids).not.toContain(priv);
    expect((first.body!.records as { kind: string }[]).some((r) => r.kind === "workspace")).toBe(false);
    const subContent = app.sync.store.children("b:" + sub);
    expect(subContent.length).toBeGreaterThan(0);
    for (const c of subContent) expect(ids).toContain(c);

    // Owner zieht „Onboarding“ in den privaten Bereich
    app.sync.store.transact("Move", (tx) => tx.update(sub, (b) => { b.parent = "b:" + priv; }));
    const next = await get(`${app.url}/sync/v2/pull?after=${first.body!.next as number}`, guest);
    const gone = (next.body!.deletions as { kind: string; id: string }[]).map((d) => `${d.kind}:${d.id}`);
    expect(gone).toContain(keyOf("block", sub));
    for (const c of subContent) expect(gone).toContain(keyOf("block", c));
    expect((next.body!.records as { data: { id: string } }[]).map((r) => r.data.id)).not.toContain(sub);
  });

  it("Snapshot: alles Lesbare plus Position", async () => {
    const { app, shared, priv } = await setup();
    const { body } = await createLink(app.url, shared, "access", "view");
    const snap = await get(`${app.url}/share/v1/snapshot`, bearer(body.secret!));
    const ids = (snap.body!.records as { data: { id: string } }[]).map((r) => r.data.id);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(priv);
    expect(snap.body!.next).toBe(app.sync.seq);
  });

  it("Push: Bearbeiten im Bereich ja; außerhalb, Herausbewegen und Lesen-Rolle nein (Server-Kopie zurück)", async () => {
    const { app, shared, sub, priv } = await setup();
    const edit = bearer((await createLink(app.url, shared, "access", "edit")).body.secret!);
    const view = bearer((await createLink(app.url, shared, "access", "view")).body.secret!);
    const store = app.sync.store;
    const stampLater = (b: { stamp?: { millis: number; counter: number; node: string } | undefined }) => ({ ...b.stamp!, millis: b.stamp!.millis + 1000, node: "guest" });
    const para = store.children("b:" + sub)[0]!;
    const privPara = store.children("b:" + priv)[0]!;
    const edited = { ...structuredClone(store.blocks.get(para)!), text: "Changed by guest" };
    edited.stamp = stampLater(edited);
    const outside = { ...structuredClone(store.blocks.get(privPara)!), text: "hacked" };
    outside.stamp = stampLater(outside);
    const moved = { ...structuredClone(store.blocks.get(sub)!), parent: "b:" + priv };
    moved.stamp = stampLater(moved);

    const r1 = await post(`${app.url}/sync/v2/push`, { records: [{ kind: "block", data: edited }, { kind: "block", data: outside }, { kind: "block", data: moved }], deletions: [] }, edit);
    expect(r1.status).toBe(200);
    expect(store.blocks.get(para)?.text).toBe("Changed by guest");
    expect(store.blocks.get(privPara)?.text).toBe("secret thoughts");
    expect(store.blocks.get(sub)?.parent).toBe("b:" + shared);
    const newer = (r1.body!.newer as { data: { id: string } }[]).map((r) => r.data.id);
    expect(newer).toContain(sub); // zurückrollen
    expect(newer).not.toContain(privPara); // nichts Privates verraten

    const again = { ...edited, text: "viewer edit", stamp: { ...edited.stamp, millis: edited.stamp.millis + 2000 } };
    await post(`${app.url}/sync/v2/push`, { records: [{ kind: "block", data: again }], deletions: [{ kind: "block", id: para }] }, view);
    expect(store.blocks.get(para)?.text).toBe("Changed by guest");

    // Neue Seite mit Inhalt im Bereich anlegen (Eltern im selben Push) geht
    const now = { millis: Date.now() + 5000, counter: 0, node: "guest" };
    const newPage = { ...structuredClone(store.blocks.get(sub)!), id: "11111111-1111-4111-8111-111111111111", text: "Guest page", parent: "b:" + shared, stamp: now };
    const newPara = { ...structuredClone(store.blocks.get(para)!), id: "22222222-2222-4222-8222-222222222222", text: "hi", parent: "b:" + newPage.id, stamp: now };
    await post(`${app.url}/sync/v2/push`, { records: [{ kind: "block", data: newPara }, { kind: "block", data: newPage }] }, edit);
    expect(store.blocks.get(newPara.id)?.text).toBe("hi");
  });
});

describe("Geheimnisse, Widerruf, Einladungen, Zugriff auf Owner-Routen", () => {
  it("Geheimnisse liegen nur gehasht in meta; Widerruf sperrt sofort", async () => {
    const { app, shared } = await setup();
    const { body } = await createLink(app.url, shared, "access", "view");
    const secret = body.secret!;
    const meta = app.sync.persistence.meta(META_KEY)!;
    expect(meta).not.toContain(secret);
    expect(meta).toContain(createHash("sha256").update(secret).digest("hex"));
    expect((await get(`${app.url}/sync/v2/pull`, bearer(secret))).status).toBe(200);
    expect((await post(`${app.url}/share/v1/links/${body.id}/revoke`, {})).status).toBe(200);
    expect((await get(`${app.url}/sync/v2/pull`, bearer(secret))).status).toBe(401);
    expect((await text(`${app.url}/s/${secret}`)).status).toBe(404);
  });

  it("Einladung: Formular → Geräte-Token (nur einmal), dann /share/v1/me; Gäste kommen nicht an MCP", async () => {
    const { app, shared } = await setup();
    const { body } = await createLink(app.url, shared, "invite", "comment");
    const landing = await text(`${app.url}/s/${body.secret}`);
    expect(landing.body).toContain("invited to “Team Wiki”");
    const joined = await fetch(`${app.url}/s/${body.secret}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=Grace" });
    const html = await joined.text();
    const token = /data-testid="device-token">([^<]+)</.exec(html)?.[1] ?? "";
    expect(token).toMatch(/^bdu_/);
    expect(app.sync.persistence.meta(META_KEY)).not.toContain(token);
    const me = await get(`${app.url}/share/v1/me`, bearer(token));
    expect(me.body).toMatchObject({ kind: "user", name: "Grace", pages: [{ id: shared, title: "Team Wiki", role: "comment" }] });
    const mcp = await post(`${app.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(token));
    expect(mcp.status).toBe(403);
    expect((await get(`${app.url}/sync/pull`, bearer(token))).status).toBe(403);
    // Zugangsliste für den Owner, ohne Hashes
    const list = await get(`${app.url}/share/v1/pages/${shared}`);
    expect(JSON.stringify(list.body)).not.toContain("secretHash");
    expect((list.body!.people as { name: string; role: string }[])[0]).toMatchObject({ name: "Grace", role: "comment" });
  });
});

describe("Publish to web", () => {
  it("ohne Token lesbar, Unterseiten inklusive; privater Bereich 404; Widerruf → 404", async () => {
    const { app, shared, sub, priv } = await setup();
    const { body } = await createLink(app.url, shared, "publish", "view");
    expect(body.path).toBe(`/p/${body.id}`);
    expect(body.secret).toBeUndefined();
    // erneut veröffentlichen gibt denselben Link
    expect((await createLink(app.url, shared, "publish", "view")).body.id).toBe(body.id);

    const page = await text(`${app.url}${body.path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.body).toContain("Team Wiki");
    expect(page.body).toContain("Welcome to the wiki");
    expect(page.body).toContain(`href="/p/${body.id}/${sub}"`);
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body).not.toMatch(/https?:\/\//); // keine fremden Ressourcen

    const subPage = await text(`${app.url}/p/${body.id}/${sub}`);
    expect(subPage.status).toBe(200);
    expect(subPage.body).toContain("First day");
    const privPage = await text(`${app.url}/p/${body.id}/${priv}`);
    expect(privPage.status).toBe(404);
    expect(privPage.body).not.toContain("secret thoughts");
    expect((await text(`${app.url}/p/unknown`)).status).toBe(404);

    await post(`${app.url}/share/v1/links/${body.id}/revoke`, {});
    expect((await text(`${app.url}${body.path}`)).status).toBe(404);
    expect((await text(`${app.url}/p/${body.id}/${sub}`)).status).toBe(404);
  });

  it("HTML-Blöcke als eigenes Dokument mit Sandbox-CSP; Bilder vom eigenen Server", async () => {
    const app = await startApp();
    apps.push(app);
    const id = app.pages.create({ title: "Demo", markdown: "```html\n<b>hi</b>\n```" });
    const code = app.sync.store.children("b:" + id).map((k) => app.sync.store.blocks.get(k)!).find((b) => b.type === "code")!;
    expect(code.props?.language).toBe("html");
    const { body } = await createLink(app.url, id, "publish", "view");
    const page = await text(`${app.url}${body.path}`);
    expect(page.body).toContain(`src="/p/${body.id}/${id}/html/${code.id}"`);
    expect(page.body).not.toContain("srcdoc");
    const block = await text(`${app.url}/p/${body.id}/${id}/html/${code.id}`);
    expect(block.body).toBe("<b>hi</b>");
    expect(block.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts;/);

    // Datei: nur, wenn sie zum veröffentlichten Bereich gehört
    const bytes = Buffer.from("not really a png");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect((await fetch(`${app.url}/sync/v2/asset/${hash}`, { method: "PUT", headers: auth, body: bytes })).status).toBe(200);
    expect((await fetch(`${app.url}/p/${body.id}/asset/${hash}`)).status).toBe(404);
    app.sync.store.transact("Image", (tx) => tx.update(code.id, (b) => { b.type = "image"; b.props = { asset: { id: hash, name: "x.png", mime: "image/png" } }; }));
    const img = await fetch(`${app.url}/p/${body.id}/asset/${hash}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await text(`${app.url}/p/${body.id}`)).body).toContain(`/p/${body.id}/asset/${hash}`);
  });

  it("Access-Link: im Browser lesbar, Publish-Geheimnis leitet weiter", async () => {
    const { app, shared } = await setup();
    const access = await createLink(app.url, shared, "access", "edit");
    const r = await text(`${app.url}${access.body.path}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("Welcome to the wiki");
  });
});

describe("Fremde Embeds auf veröffentlichten Seiten (BSD-236)", () => {
  it("Standard: Link-Karte und keine fremden Rahmen in der CSP; Opt-in: Rahmen mit sandbox, nur die Hosts dieser Seite", async () => {
    const { app, shared } = await setup();
    app.share.store.transact("embed", (tx) => {
      tx.put({ kind: "block", data: { id: "emb-1", type: "embed", parent: "b:" + shared, sk: "zz", props: { url: "https://www.youtube.com/embed/abc" }, createdAt: 0, updatedAt: 0 } });
      tx.put({ kind: "block", data: { id: "emb-2", type: "embed", parent: "b:" + shared, sk: "zzz", props: { url: "http://insecure.example/x" }, createdAt: 0, updatedAt: 0 } });
    });
    const { body } = await createLink(app.url, shared, "publish", "view");
    expect(body.allowEmbeds).toBe(false);
    let page = await text(`${app.url}/p/${body.id}`);
    expect(page.body).not.toContain("<iframe class=\"embed\"");
    expect(page.body).toContain("embed-link");
    expect(page.headers.get("content-security-policy")).toContain("frame-src 'self';");

    const on = await post(`${app.url}/share/v1/links/${body.id}/embeds`, { allow: true });
    expect(on.body).toMatchObject({ allowEmbeds: true });
    page = await text(`${app.url}/p/${body.id}`);
    expect(page.body).toContain('<iframe class="embed" src="https://www.youtube.com/embed/abc" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"');
    expect(page.headers.get("content-security-policy")).toContain("frame-src 'self' https://www.youtube.com;");
    expect(page.headers.get("content-security-policy")).not.toContain("insecure.example");

    // Opt-in überlebt einen Neustart des Dienstes (gespeichert im Link); alte Daten ohne Feld = aus.
    const raw = JSON.parse(app.share.persistence.meta(META_KEY)!) as { links: { id: string; allowEmbeds?: boolean }[] };
    expect(raw.links.find((l) => l.id === body.id)?.allowEmbeds).toBe(true);
    delete raw.links.find((l) => l.id === body.id)!.allowEmbeds;
    app.share.persistence.setMeta(META_KEY, JSON.stringify(raw));
    const { ShareService } = await import("../src/share.js");
    expect(ShareService.load(app.share.persistence).links.find((l) => l.id === body.id)?.allowEmbeds).toBeUndefined();

    expect((await post(`${app.url}/share/v1/links/${body.id}/embeds`, { allow: "yes" })).status).toBe(400);
    const access = await createLink(app.url, shared, "access", "view");
    expect((await post(`${app.url}/share/v1/links/${access.body.id}/embeds`, { allow: true })).status).toBe(400);
    expect((await post(`${app.url}/share/v1/links/${body.id}/embeds`, { allow: false })).body).toMatchObject({ allowEmbeds: false });
  });
});
