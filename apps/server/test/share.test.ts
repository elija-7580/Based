// Teilen (docs/sharing.md): Rollen und Vererbung, gefilterter Pull/Push, Löschung beim Herausbewegen, gehashte
// Geheimnisse, Widerruf, Einladungen, Publish to web (ohne Token lesbar, privater Bereich nicht).
import { createHash } from "node:crypto";
import { dbops, keyOf } from "@based/core";
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

  it("BSD-284: Seite wandert in den geteilten Bereich – der nächste Pull bringt ihren Inhalt mit, danach nicht mehr", async () => {
    const { app, shared, priv } = await setup();
    const { body } = await createLink(app.url, shared, "access", "view");
    const guest = bearer(body.secret!);
    const first = await get(`${app.url}/sync/v2/pull?after=0&limit=5000`, guest);
    const privContent = app.sync.store.children("b:" + priv);
    expect(privContent.length).toBeGreaterThan(0);
    // Owner zieht „Private Diary“ in „Team Wiki“ (nur der Seiten-Record ändert sich)
    app.sync.store.transact("Move", (tx) => tx.update(priv, (b) => { b.parent = "b:" + shared; }));
    const next = await get(`${app.url}/sync/v2/pull?after=${first.body!.next as number}`, guest);
    const ids = (next.body!.records as { data: { id: string } }[]).map((r) => r.data.id);
    expect(ids).toContain(priv);
    for (const c of privContent) expect(ids).toContain(c);
    expect(new Set(ids).size).toBe(ids.length);
    // Eine spätere Titeländerung schickt den Inhalt nicht erneut.
    app.sync.store.transact("Rename", (tx) => tx.update(priv, (b) => { b.text = "Diary (shared)"; }));
    const later = await get(`${app.url}/sync/v2/pull?after=${next.body!.next as number}`, guest);
    expect((later.body!.records as { data: { id: string } }[]).map((r) => r.data.id)).toEqual([priv]);
    // Der Besitzer bekommt nur das Change-Log.
    const owner = await get(`${app.url}/sync/v2/pull?after=${first.body!.next as number}`);
    expect((owner.body!.records as { data: { id: string } }[]).map((r) => r.data.id)).not.toContain(privContent[0]);
  });

  it("BSD-284: neue Freigabe für einen verbundenen Nutzer – nächster Pull bringt die Seite mit Inhalt", async () => {
    const { app, shared, priv } = await setup();
    const inv = app.share.createLink("invite", shared, "view", { kind: "owner" });
    const { user, token } = app.share.acceptInvite(inv.secret!, "Ada");
    const first = await get(`${app.url}/sync/v2/pull?after=0&limit=5000`, bearer(token));
    expect((first.body!.records as { data: { id: string } }[]).map((r) => r.data.id)).not.toContain(priv);
    app.share.setGrant(user.id, priv, "view", { kind: "owner" });
    const next = await get(`${app.url}/sync/v2/pull?after=${first.body!.next as number}`, bearer(token));
    const ids = (next.body!.records as { data: { id: string } }[]).map((r) => r.data.id);
    expect(ids).toContain(priv);
    for (const c of app.sync.store.children("b:" + priv)) expect(ids).toContain(c);
  });

  it("BSD-284: Verschiebungen stehen in der Server-Datei (Tabelle share_moves), nicht nur im Speicher", async () => {
    const { app, shared, priv } = await setup();
    app.sync.store.transact("Move", (tx) => tx.update(priv, (b) => { b.parent = "b:" + shared; }));
    const rows = app.sync.persistence.db.all("SELECT id FROM share_moves");
    expect(rows.map((r) => r.id)).toContain(priv);
  });

  it("BSD-285: Löschungen kommen nur aus dem Bereich des Gastes", async () => {
    const { app, shared, sub, priv } = await setup();
    const { body } = await createLink(app.url, shared, "access", "view");
    const guest = bearer(body.secret!);
    const first = await get(`${app.url}/sync/v2/pull?after=0&limit=5000`, guest);
    const privPara = app.sync.store.children("b:" + priv)[0]!;
    const subPara = app.sync.store.children("b:" + sub)[0]!;
    app.sync.store.transact("Delete", (tx) => { tx.remove(keyOf("block", privPara)); tx.remove(keyOf("block", subPara)); });
    const next = await get(`${app.url}/sync/v2/pull?after=${first.body!.next as number}`, guest);
    const gone = (next.body!.deletions as { kind: string; id: string }[]).map((d) => d.id);
    expect(gone).toContain(subPara);
    expect(gone).not.toContain(privPara);
    // Der Besitzer sieht beide.
    const owner = await get(`${app.url}/sync/v2/pull?after=${first.body!.next as number}`);
    expect((owner.body!.deletions as { id: string }[]).map((d) => d.id)).toEqual(expect.arrayContaining([privPara, subPara]));
    // Ganze private Seite samt Inhalt löschen: nichts davon beim Gast.
    const rest = app.sync.store.children("b:" + priv);
    app.sync.store.transact("Delete page", (tx) => { for (const c of rest) tx.remove(keyOf("block", c)); tx.remove(keyOf("block", priv)); });
    const later = await get(`${app.url}/sync/v2/pull?after=${next.body!.next as number}`, guest);
    expect(later.body!.deletions).toEqual([]);
  });

  it("BSD-285: abgelehnte Records stehen in der Antwort; der Sync-Client des Gastes übernimmt die Server-Kopie", async () => {
    const { app, shared, sub } = await setup();
    const view = (await createLink(app.url, shared, "access", "view")).body.secret!;
    const { openWorkspace, SyncClient } = await import("@based/sync");
    const { openNodeDatabase } = await import("@based/sync/node");
    const ws = openWorkspace(openNodeDatabase());
    const client = new SyncClient(ws.store, ws.persistence, { baseURL: app.url, token: view });
    await client.syncNow();
    const para = app.sync.store.children("b:" + sub)[0]!;
    const original = ws.store.blocks.get(para)!.text;
    ws.store.setText(para, "lokal geändert");
    await client.syncNow();
    expect(app.sync.store.blocks.get(para)!.text).toEqual(original);
    expect(ws.store.blocks.get(para)!.text).toEqual(original);
    // Direkt am Protokoll: rejected nennt den Record.
    const rec = structuredClone(app.sync.store.blocks.get(para)!);
    rec.text = "nochmal";
    rec.stamp = { ...rec.stamp!, millis: rec.stamp!.millis + 10_000, node: "guest" };
    const r = await post(`${app.url}/sync/v2/push`, { records: [{ kind: "block", data: rec }], deletions: [] }, bearer(view));
    expect(r.body!.rejected).toEqual([{ kind: "block", id: para }]);
    client.stop();
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

describe("Gast-Modus (BSD-235)", () => {
  it("Access-Link mit Web-Client: „Open in Based“ mit dem Link im Fragment; ohne Web-Client keine Leiste", async () => {
    const { app, shared } = await setup();
    const access = await createLink(app.url, shared, "access", "edit");
    expect((await text(`${app.url}${access.body.path}`)).body).not.toContain("data-based-open");
    const web = await startApp({ webURL: "https://web.example/" });
    apps.push(web);
    const page = web.pages.create({ title: "Shared", markdown: "Hi" });
    const link = await createLink(web.url, page, "access", "edit");
    const r = await text(`${web.url}${link.body.path}`);
    const href = /href="([^"]+)" data-based-open/.exec(r.body)?.[1]?.replace(/&amp;/g, "&");
    expect(href).toBeDefined();
    expect(href!.startsWith("https://web.example/#/share/")).toBe(true);
    const shareURL = decodeURIComponent(href!.slice("https://web.example/#/share/".length));
    expect(shareURL).toBe(`${web.url.replace("127.0.0.1", "127.0.0.1")}${link.body.path}`);
    expect(r.body).toContain("Open in Based to edit");
  });

  it("/share/v1/resolve: Seite hinter /s/… und /p/… (nur Besitzer); unbekannt oder widerrufen → 404", async () => {
    const { app, shared, sub } = await setup();
    const access = await createLink(app.url, shared, "access", "comment");
    const r = await get(`${app.url}/share/v1/resolve?path=${encodeURIComponent(access.body.path!)}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "access", pageID: shared, rootPageID: shared, role: "comment", title: "Team Wiki" });
    const deep = await get(`${app.url}/share/v1/resolve?path=${encodeURIComponent(`${app.url}${access.body.path}/${sub}`)}`);
    expect(deep.body).toMatchObject({ pageID: sub, rootPageID: shared });
    const pub = await createLink(app.url, shared, "publish", "view");
    expect((await get(`${app.url}/share/v1/resolve?path=${encodeURIComponent(pub.body.path!)}`)).body).toMatchObject({ kind: "publish", pageID: shared });
    // Gäste dürfen nicht nachschlagen
    const secret = access.body.path!.split("/").pop()!;
    expect((await get(`${app.url}/share/v1/resolve?path=${encodeURIComponent(access.body.path!)}`, bearer(secret))).status).toBe(403);
    expect((await get(`${app.url}/share/v1/resolve?path=/s/bdl_unknown`)).status).toBe(404);
    await post(`${app.url}/share/v1/links/${access.body.id}/revoke`, {});
    expect((await get(`${app.url}/share/v1/resolve?path=${encodeURIComponent(access.body.path!)}`)).status).toBe(404);
  });
});

// BSD-279 (Review): Was eine geteilte oder veröffentlichte Seite über Dinge außerhalb ihres Bereichs verrät.
describe("Review BSD-279: Leseansicht verrät nichts von außerhalb des Bereichs", () => {
  async function world() {
    const s = await setup();
    const store = s.app.sync.store;
    // privat: Datenbank „Clients“ mit einer Zeile
    const clients = dbops.createDatabase(store, { parent: "w", title: "Clients", sampleRows: 0 });
    const revenue = dbops.addProperty(store, clients.databaseID, "Revenue", "number")!;
    const acme = dbops.addRow(store, clients.databaseID)!;
    dbops.setRowTitle(store, acme, "Acme Corp");
    dbops.setValue(store, acme, revenue, dbops.pv("number", 987654));
    // geteilt: Datenbank „Tasks“ mit Relation und Rollup auf „Clients“
    const tasks = dbops.createDatabase(store, { parent: "b:" + s.shared, title: "Tasks", sampleRows: 0, inline: true });
    const rel = dbops.addProperty(store, tasks.databaseID, "Client", "relation")!;
    dbops.setRelationTarget(store, tasks.databaseID, rel, clients.databaseID);
    const roll = dbops.addProperty(store, tasks.databaseID, "Client revenue", "rollup")!;
    dbops.setRollup(store, tasks.databaseID, roll, { relationPropertyID: rel, targetPropertyID: revenue, function: "sum" });
    const fx = dbops.addProperty(store, tasks.databaseID, "Who", "formula")!;
    dbops.updateProperty(store, tasks.databaseID, fx, (q) => { q.formula = 'prop("Client")'; }, "Formula");
    const row = dbops.addRow(store, tasks.databaseID)!;
    dbops.setRowTitle(store, row, "Send offer");
    dbops.setValue(store, row, rel, dbops.pv("relation", [acme]));
    // geteilt: Erwähnung und Link auf die private Seite
    const para = store.children("b:" + s.shared)[0]!;
    store.transact("Mention", (tx) => {
      tx.update(para, (b) => { b.text = [{ t: "see " }, { t: "x", mention: { page: { _0: s.priv } } }]; });
      const base = structuredClone(store.blocks.get(para)!);
      tx.put({ kind: "block", data: { ...base, id: "33333333-3333-4333-8333-333333333333", type: "linkToPage", text: "", props: { linkTarget: s.priv }, sk: base.sk + "V" } });
    });
    return { ...s, store, clients, tasks, acme, row, para };
  }
  const SECRETS = ["Private Diary", "Acme Corp", "987654", "987,654", "secret thoughts"];

  it("veröffentlichte Seite: keine Titel privater Seiten (Erwähnung, Link, Relation), keine Rollup-/Formelwerte daraus", async () => {
    const w = await world();
    const { body } = await createLink(w.app.url, w.shared, "publish", "view");
    const page = await text(`${w.app.url}${body.path}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Send offer");
    expect(page.body).toContain("Tasks");
    for (const secret of SECRETS) expect(page.body).not.toContain(secret);
    // die Zeile als eigene Seite (Eigenschaften-Tabelle)
    const rowPage = await text(`${w.app.url}/p/${body.id}/${w.row}`);
    expect(rowPage.status).toBe(200);
    for (const secret of SECRETS) expect(rowPage.body).not.toContain(secret);
    // Erwähnung bleibt als Platzhalter sichtbar
    expect(page.body).toContain("No access");
  });

  it("Gast mit Bearbeiten-Link kann über einen verknüpften Datenbank-Block keine private Datenbank auslesen", async () => {
    const w = await world();
    const secret = (await createLink(w.app.url, w.shared, "access", "edit")).body.secret!;
    // Die ID der privaten Datenbank steht in der Relation der geteilten Datenbank, der Gast kennt sie also.
    const pulled = await get(`${w.app.url}/sync/v2/pull?after=0&limit=5000`, bearer(secret));
    expect(JSON.stringify(pulled.body)).toContain(w.clients.databaseID);
    expect(JSON.stringify(pulled.body)).not.toContain("Acme Corp");
    const base = structuredClone(w.store.blocks.get(w.para)!);
    const spy = { ...base, id: "44444444-4444-4444-8444-444444444444", type: "databaseInline", text: "", props: { databaseID: w.clients.databaseID, viewIDs: [] }, sk: base.sk + "W", stamp: { millis: Date.now() + 5000, counter: 0, node: "guest" } };
    const pushed = await post(`${w.app.url}/sync/v2/push`, { records: [{ kind: "block", data: spy }], deletions: [] }, bearer(secret));
    expect(pushed.status).toBe(200);
    const page = await text(`${w.app.url}/s/${secret}`);
    expect(page.status).toBe(200);
    for (const s of SECRETS) expect(page.body).not.toContain(s);
    // derselbe Block als Ziel der Leseansicht
    const direct = await text(`${w.app.url}/s/${secret}/${spy.id}`);
    for (const s of SECRETS) expect(direct.body).not.toContain(s);
  });

  it("Datei-Export des Besitzers zeigt weiter alles", async () => {
    const w = await world();
    const { HTMLExporter, exportHTMLPage } = await import("@based/core");
    const html = exportHTMLPage(new HTMLExporter(w.store), w.shared, {});
    expect(html).toContain("Private Diary");
    expect(html).toContain("Acme Corp");
  });
});
