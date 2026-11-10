// Teilen-Endpunkte (docs/sharing.md). Öffentlich: Publish-Seiten, Link-Landeseiten, Beitritt. Sonst `shared`:
// Owner-Token, Geräte-Token (`bdu_…`) oder Access-Link-Geheimnis (`bdl_…`), alles nach Rolle gefiltert.
//
//   GET  /p/<id>[/<pageID>]               veröffentlichte Seite (HTML, nur lesen)
//   GET  /p/<id>/<pageID>/html/<blockID>  HTML-Block als eigenes Dokument (sandbox)
//   GET  /p/<id>/asset/<hash>             Bild/Datei einer veröffentlichten Seite
//   GET  /s/<secret>[/<pageID>]           Access-Link: Seite lesen · Einladung: Beitrittsformular · Publish: Weiterleitung
//   POST /s/<secret>                      Einladung annehmen (Formular) → Geräte-Token
//   POST /share/v1/invites/accept         {secret, name} → {token, user, pageID}
//   GET  /share/v1/me · /share/v1/snapshot · /share/v1/pages/<pageID>
//   POST /share/v1/links · /share/v1/links/<id>/revoke · /share/v1/grants
import { createReadStream } from "node:fs";
import { titleOf } from "@based/core";
import type { AssetStore } from "./assets.js";
import { ASSET_HASH } from "./assets.js";
import type { Logger } from "./log.js";
import type { SyncService } from "./sync.js";
import { htmlBlockResponse, htmlBlockSource, htmlResponse, invitePage, joinedPage, linkGone, notPublished, renderShared, renderSharedPage } from "./publish.js";
import { error, json, type Caller, type RouteContext, type RouteResult, type Router } from "./router.js";
import { isRole, linkJSON, OWNER, ShareError, type LinkKind, type SharePrincipal, type ShareService, type SharingLink } from "./share.js";

/** Principal einer Anfrage auf einer `shared`-Route. */
export const principalOf = (caller: Caller<unknown> | undefined): SharePrincipal => (caller?.kind === "shared" ? (caller.principal as SharePrincipal) : OWNER);

function body(ctx: RouteContext): Record<string, unknown> {
  try {
    const v = JSON.parse(ctx.body.toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const failure = (e: unknown): RouteResult => {
  if (e instanceof ShareError) return error(e.message, e.status);
  throw e;
};

const guarded = (f: () => RouteResult): RouteResult => {
  try {
    return f();
  } catch (e) {
    return failure(e);
  }
};

const LINK_KINDS = new Set<LinkKind>(["access", "invite", "publish"]);

/** Wie ein Server-Pfad als vollständige URL aussieht (für die Beitrittsseite). */
function serverURL(ctx: RouteContext, publicURL: string | undefined): string {
  if (publicURL) return publicURL.replace(/\/+$/, "");
  const host = ctx.req.headers.host ?? "localhost";
  const proto = (ctx.req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? "http";
  return `${proto}://${host}`;
}

export interface ShareRouteOptions {
  share: ShareService;
  sync: SyncService;
  assets: AssetStore;
  log: Logger;
  /** Öffentliche Adresse des Servers (für den Geräte-Token-Hinweis); sonst aus Host-Header. */
  serverURL?: string | undefined;
}

export function registerShareRoutes(router: Router, { share, sync, assets, log, serverURL: publicURL }: ShareRouteOptions) {
  const store = share.store;

  // MARK: Veröffentlichte Seiten
  const published = (id: string, target: string | undefined) => {
    const link = share.publishedLink(id);
    if (!link) return notPublished();
    const r = renderShared(share, link, target ?? link.pageID, `/p/${encodeURIComponent(link.id)}`);
    return r === undefined ? notPublished() : htmlResponse(r.html, 200, r.csp);
  };
  router.add("GET", "/p/:id", ({ params }) => published(params.id!, undefined), { access: "public" });
  router.add("GET", "/p/:id/:page", ({ params }) => published(params.id!, params.page), { access: "public" });
  router.add("GET", "/p/:id/:page/html/:block", ({ params }) => {
    const link = share.publishedLink(params.id!);
    const src = link ? htmlBlockSource(share, link, params.block!) : undefined;
    return src === undefined ? notPublished() : htmlBlockResponse(src);
  }, { access: "public" });

  const assetFor = (link: SharingLink | undefined, hash: string, ctx: RouteContext): RouteResult => {
    if (!link || !ASSET_HASH.test(hash) || !share.canReadAsset({ kind: "link", link }, hash)) return error("not found", 404);
    const found = assets.locate(hash);
    if (!found) return error("not found", 404);
    // Typ aus dem Verweis; nur Rasterbilder/Medien inline, alles andere als Download (nie als HTML/SVG).
    const mime = mimeFor(store, hash);
    const inline = mime !== undefined && /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/)/.test(mime);
    ctx.res.writeHead(200, {
      "Content-Type": inline ? mime! : "application/octet-stream",
      "Content-Length": String(found.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=300",
      ...(inline ? {} : { "Content-Disposition": "attachment" }),
    });
    if (found.size === 0) ctx.res.end();
    else createReadStream(found.path).on("error", () => ctx.res.destroy()).pipe(ctx.res);
    return undefined;
  };
  router.add("GET", "/p/:id/asset/:hash", (ctx) => assetFor(share.publishedLink(ctx.params.id!), ctx.params.hash!, ctx), { access: "public" });

  // MARK: Link-Landeseiten (/s/<secret>)
  const landing = (secret: string, target: string | undefined) => {
    const link = share.link(secret);
    if (!link || !share.isActive(link)) return linkGone();
    switch (link.kind) {
      case "publish": return { status: 302, headers: { Location: `/p/${encodeURIComponent(link.id)}` } };
      case "invite": return invitePage(titleOf(store, link.pageID), link);
      case "access": {
        // Lesend im Browser; bearbeiten geht mit dem Geheimnis als Token in Based (Settings → Sync & server).
        const html = renderSharedPage(share, link, target ?? link.pageID, `/s/${encodeURIComponent(secret)}`);
        return html === undefined ? linkGone() : htmlResponse(html);
      }
    }
  };
  router.add("GET", "/s/:secret", ({ params }) => landing(params.secret!, undefined), { access: "public" });
  router.add("GET", "/s/:secret/:page", ({ params }) => landing(params.secret!, params.page), { access: "public" });
  router.add("GET", "/s/:secret/asset/:hash", (ctx) => {
    const l = share.link(ctx.params.secret!);
    return assetFor(l && l.kind === "access" && share.isActive(l) ? l : undefined, ctx.params.hash!, ctx);
  }, { access: "public" });
  router.add("GET", "/s/:secret/:page/html/:block", ({ params }) => {
    const l = share.link(params.secret!);
    const src = l && l.kind === "access" && share.isActive(l) ? htmlBlockSource(share, l, params.block!) : undefined;
    return src === undefined ? linkGone() : htmlBlockResponse(src);
  }, { access: "public" });
  router.add("POST", "/s/:secret", (ctx) => {
    const secret = ctx.params.secret!;
    const link = share.link(secret);
    if (!link || link.kind !== "invite" || !share.isActive(link)) return linkGone();
    const name = new URLSearchParams(ctx.body.toString("utf8")).get("name") ?? "";
    try {
      const r = share.acceptInvite(secret, name);
      log.info("share: invite accepted", { role: link.role });
      return joinedPage(titleOf(store, r.pageID), r.token, serverURL(ctx, publicURL));
    } catch (e) {
      if (e instanceof ShareError) return invitePage(titleOf(store, link.pageID), link, e.message);
      throw e;
    }
  }, { access: "public", bodyLimit: 4096 });
  router.add("POST", "/share/v1/invites/accept", (ctx) => guarded(() => {
    const b = body(ctx);
    const r = share.acceptInvite(String(b.secret ?? ""), String(b.name ?? ""));
    return json({ token: r.token, user: r.user.name, pageID: r.pageID });
  }), { access: "public", bodyLimit: 4096 });

  // MARK: Owner oder geteilter Principal
  router.add("GET", "/share/v1/me", ({ caller }) => {
    const p = principalOf(caller);
    const roots = p.kind === "owner" ? [] : share.roots(p);
    return json({
      kind: p.kind,
      name: p.kind === "owner" ? "Owner" : p.kind === "user" ? p.user.name : (p.link.label ?? "Link"),
      pages: roots.map((r) => ({ id: r.pageID, title: titleOf(store, r.pageID), role: r.role })),
    });
  }, { access: "shared" });
  router.add("GET", "/share/v1/snapshot", ({ caller }) => json(share.snapshot(principalOf(caller), sync)), { access: "shared" });
  router.add("GET", "/share/v1/pages/:page", ({ caller, params }) => {
    const p = principalOf(caller);
    const pageID = params.page!;
    if (!store.blocks.has(pageID)) return error("not found", 404);
    if (share.rolePage(p, pageID) !== "full") return error("forbidden", 403);
    const a = share.access(pageID);
    const names = new Map(share.state.users.map((u) => [u.id, u.name]));
    return json({
      pageID,
      people: a.grants.map((g) => ({ id: g.id, userID: g.userID, name: names.get(g.userID) ?? "?", pageID: g.pageID, role: g.role, inherited: g.pageID !== pageID })),
      links: a.links.map((l) => ({ ...linkJSON(l, share.isActive(l)), inherited: l.pageID !== pageID })),
    });
  }, { access: "shared" });
  router.add("POST", "/share/v1/links", (ctx) => guarded(() => {
    const b = body(ctx);
    const kind = (b.kind ?? "access") as LinkKind;
    const role = b.role ?? "view";
    if (typeof b.pageID !== "string" || !LINK_KINDS.has(kind) || !isRole(role)) return error("pageID, kind (access|invite|publish), role (view|comment|edit|full)", 400);
    const days = b.expiresInDays === undefined || b.expiresInDays === null ? undefined : Number(b.expiresInDays);
    const uses = b.uses === undefined || b.uses === null ? undefined : Number(b.uses);
    const created = share.createLink(kind, b.pageID, role, principalOf(ctx.caller), { label: typeof b.label === "string" ? b.label : undefined, expiresInDays: days, uses });
    log.info("share: link created", { kind, role });
    // Das Geheimnis gibt es nur in dieser Antwort; gespeichert ist allein sein Hash.
    const path = kind === "publish" ? `/p/${created.link.id}` : created.secret ? `/s/${created.secret}` : undefined;
    return json({ ...linkJSON(created.link, true), ...(path ? { path } : {}), ...(created.secret && kind !== "publish" ? { secret: created.secret } : {}) });
  }), { access: "shared", bodyLimit: 4096 });
  // BSD-236: fremde Embeds auf der veröffentlichten Seite erlauben / verbieten.
  router.add("POST", "/share/v1/links/:id/embeds", (ctx) => guarded(() => {
    const b = body(ctx);
    if (typeof b.allow !== "boolean") return error("allow (true|false)", 400);
    const l = share.setLinkEmbeds(ctx.params.id!, b.allow, principalOf(ctx.caller));
    log.info("share: embeds", { allow: b.allow });
    return json(linkJSON(l, share.isActive(l)));
  }), { access: "shared", bodyLimit: 1024 });
  router.add("POST", "/share/v1/links/:id/revoke", ({ caller, params }) => guarded(() => {
    share.revokeLink(params.id!, principalOf(caller));
    log.info("share: link revoked");
    return json({ ok: true });
  }), { access: "shared" });
  router.add("POST", "/share/v1/grants", (ctx) => guarded(() => {
    const b = body(ctx);
    if (typeof b.userID !== "string" || typeof b.pageID !== "string") return error("userID, pageID", 400);
    const role = b.role === null || b.role === undefined ? null : b.role;
    if (role !== null && !isRole(role)) return error("role must be view, comment, edit, full or null", 400);
    share.setGrant(b.userID, b.pageID, role, principalOf(ctx.caller));
    return json({ ok: true });
  }), { access: "shared", bodyLimit: 4096 });

}

function mimeFor(store: ShareService["store"], hash: string): string | undefined {
  let found: string | undefined;
  const walk = (v: unknown): void => {
    if (found !== undefined || typeof v !== "object" || v === null) return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (o.id === hash && typeof o.name === "string") {
      found = typeof o.mime === "string" ? o.mime.toLowerCase() : guessMime(o.name);
      return;
    }
    Object.values(o).forEach(walk);
  };
  for (const b of store.blocks.values()) {
    walk(b.props);
    if (found !== undefined) break;
  }
  return found;
}

const EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg" };
function guessMime(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : EXT[name.slice(dot + 1).toLowerCase()];
}
