// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Teilen für Agenten (Matrix T1–T4). Sehen und Entziehen gehen immer. Freigeben (Link, Einladung, Veröffentlichen)
// läuft nur ohne Rückfrage, wenn der Mensch Agenten „Work freely“ gegeben hat; sonst wird es eine Frage in der Inbox
// (Entscheidung 3). Die Regeln der Freigabe selbst (wer darf was weitergeben) stehen in ShareService.
import { agentsWorkFreely, ToolError, type ToolCtx, type ToolDef } from "@based/brain";
import { fromSwiftDate, isRole, OWNER, ROLE_LABEL, ShareError, type LinkKind, type ShareService, type SharingLink } from "./share.js";

const KINDS: Record<string, LinkKind> = { link: "access", invite: "invite", publish: "publish" };
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) }) as const;
const wrap = <T>(f: () => T): T => {
  try { return f(); } catch (e) { throw e instanceof ShareError ? new ToolError(e.message) : e; }
};

export function shareTools(share: ShareService, base = ""): (ctx: ToolCtx) => ToolDef[] {
  const url = (l: SharingLink, secret?: string) => (l.kind === "publish" ? `${base}/p/${encodeURIComponent(l.id)}` : secret ? `${base}/s/${secret}` : undefined);
  const day = (d: number | undefined) => (d === undefined ? "" : new Date(fromSwiftDate(d)).toISOString().slice(0, 10));
  return (ctx) => {
    const free = () => agentsWorkFreely(ctx.store);
    const kindOf = (a: Record<string, unknown>): LinkKind => {
      const k = KINDS[typeof a.kind === "string" ? a.kind : "link"];
      if (!k) throw new ToolError("kind must be link, invite or publish");
      return k;
    };
    const roleOf = (a: Record<string, unknown>, kind: LinkKind) => {
      const r = typeof a.role === "string" ? a.role : "view";
      if (!isRole(r)) throw new ToolError(`role must be one of: ${Object.keys(ROLE_LABEL).join(", ")}`);
      if (kind === "publish" && r !== "view") throw new ToolError("Published pages are read-only (role: view).");
      if (kind === "access" && r === "full") throw new ToolError("A link can't give full access; use kind: invite.");
      return r;
    };
    return [
      {
        group: "pages", write: false,
        spec: { name: "list_shares", description: "Who has access to a page: people, links, invites and whether it is published (also what it inherits from pages above).", inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: str("Page id") } } },
        run: (a) => {
          const id = ctx.page(String(a.id)).id;
          const acc = share.access(id);
          if (acc.grants.length === 0 && acc.links.length === 0) return "Not shared.";
          const from = (p: string) => (p === id ? "" : ` (from “${ctx.title(p)}”)`);
          return [
            ...acc.grants.map((g) => `- ${share.userName(g.userID) ?? "Someone"} — ${ROLE_LABEL[g.role]}${from(g.pageID)} (user: ${g.userID})`),
            ...acc.links.map((l) => `- ${l.kind === "publish" ? "Published to the web" : l.kind === "invite" ? "Invite" : "Link"}${l.label ? ` “${l.label}”` : ""} — ${ROLE_LABEL[l.role]}${l.expiresAt !== undefined ? `, until ${day(l.expiresAt)}` : ""}${l.usesLeft !== undefined ? `, ${l.usesLeft} uses left` : ""}${from(l.pageID)} (share: ${l.id})${l.kind === "publish" ? ` ${url(l)}` : ""}`),
          ].join("\n");
        },
      },
      {
        group: "pages", write: true,
        // Erst prüfen, dann fragen; ohne „Work freely“ entscheidet der Mensch in der Inbox.
        ask: (a) => {
          const id = ctx.page(String(a.id)).id;
          const kind = kindOf(a);
          const role = roleOf(a, kind);
          if (free()) return undefined;
          return kind === "publish" ? `Publish “${ctx.title(id)}” to the web` : `Share “${ctx.title(id)}” by ${kind === "invite" ? "invite" : "link"} (${ROLE_LABEL[role].toLowerCase()})`;
        },
        spec: {
          name: "share_page",
          description: "Share a page: kind link (anyone with the link), invite (people join with their name) or publish (public web page, read-only). Unless the user lets agents work freely, this asks them in Based's inbox first. The link is shown once.",
          inputSchema: {
            type: "object", additionalProperties: false, required: ["id"],
            properties: { id: str("Page id"), kind: { type: "string", enum: Object.keys(KINDS) }, role: str("view (default), comment, edit; full only for invites"), label: str(), expires_in_days: { type: "number", exclusiveMinimum: 0 }, uses: { type: "integer", minimum: 1, description: "Invites: how many people may join" } },
          },
        },
        run: (a) => {
          const id = ctx.page(String(a.id)).id;
          const kind = kindOf(a);
          const r = wrap(() => share.createLink(kind, id, roleOf(a, kind), OWNER, {
            label: typeof a.label === "string" ? a.label : undefined,
            expiresInDays: typeof a.expires_in_days === "number" ? a.expires_in_days : undefined,
            uses: typeof a.uses === "number" ? a.uses : undefined,
          }));
          const where = url(r.link, r.secret);
          return `${kind === "publish" ? "Published" : "Shared"} “${ctx.title(id)}” (share: ${r.link.id}, ${ROLE_LABEL[r.link.role].toLowerCase()})${where ? `: ${where}` : ""}`;
        },
      },
      {
        group: "pages", write: true,
        spec: {
          name: "revoke_share",
          description: "Take access away: a link, invite or publication by its share id, or a person's access to a page (user + id). list_shares shows both.",
          inputSchema: { type: "object", additionalProperties: false, required: [], properties: { share: str("Share id of a link, invite or publication"), user: str("User id"), id: str("Page id (with user)") } },
        },
        run: (a) => {
          if (typeof a.share === "string") { wrap(() => share.revokeLink(a.share as string, OWNER)); return "Revoked."; }
          if (typeof a.user === "string" && typeof a.id === "string") {
            wrap(() => share.setGrant(a.user as string, ctx.page(a.id as string).id, null, OWNER));
            return `Removed access to “${ctx.title(a.id)}”.`;
          }
          throw new ToolError("Give share, or user and id.");
        },
      },
    ];
  };
}
