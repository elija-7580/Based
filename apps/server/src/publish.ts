// Veröffentlichte Seiten (Publish to web, BSD-219) und die kleinen HTML-Seiten für Share-Links. Alles server-
// gerendert, ohne JavaScript und ohne fremde Ressourcen: Stylesheet aus den Design-Tokens, Bilder vom eigenen Server,
// HTML-Blöcke als eigenes Dokument mit `sandbox` (opaque Origin). Strenge CSP auf jeder Antwort.
import { escapeAttribute, escapeText, exportHTMLPage, HTMLExporter, isPageLike, isTrashed, titleOf, type WorkspaceStore } from "@based/core";
import { exportStylesheet } from "@based/design-tokens/export-css";
import type { RouteResult } from "./router.js";
import { ROLE_LABEL, type SharingLink, type ShareService } from "./share.js";

/** Seiten: nur eigene Bilder/Medien, eigene Rahmen (HTML-Blöcke), kein Skript, kein Formularziel außer sich selbst. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** Ein HTML-Block: Skripte ja, aber in einer Sandbox ohne eigene Origin und ohne Netz. */
export const HTML_BLOCK_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "Cache-Control": "no-store",
};

/**
 * BSD-236: CSP einer veröffentlichten Seite mit erlaubten Embeds – nur die https-Hosts der Embeds dieser Seite in
 * `frame-src` (die Rahmen selbst tragen `sandbox`). Ohne Hosts bleibt es bei `PAGE_CSP`.
 */
export function pageCSP(embedHosts: readonly string[] = []): string {
  if (embedHosts.length === 0) return PAGE_CSP;
  return PAGE_CSP.replace("frame-src 'self'", `frame-src 'self' ${[...new Set(embedHosts)].sort().join(" ")}`);
}

/** https-Origins der Embed-Blöcke unter `pageID` (ohne Unterseiten, ohne Papierkorb). */
export function embedHosts(store: WorkspaceStore, pageID: string): string[] {
  const out = new Set<string>();
  const walk = (parent: string) => {
    for (const id of store.children(parent)) {
      const b = store.blocks.get(id);
      if (!b || b.trashedAt !== undefined || isPageLike(b)) continue;
      if (b.type === "embed" && typeof b.props?.url === "string") {
        try {
          const u = new URL(b.props.url);
          if (u.protocol === "https:") out.add(u.origin);
        } catch { /* keine URL */ }
      }
      walk("b:" + id);
    }
  };
  walk("b:" + pageID);
  return [...out];
}

export function htmlResponse(html: string, status = 200, csp = PAGE_CSP): RouteResult {
  return { status, html, headers: { "Content-Security-Policy": csp, ...SECURITY_HEADERS } };
}

/** Kleine Info-Seite (abgelaufen, nicht gefunden, Einladung) im Stil der Exporte. */
export function messagePage(title: string, bodyHTML: string, status = 200): RouteResult {
  const css = `${exportStylesheet()}\n.notice { max-width: 420px; } .muted { color: var(--muted); }\ninput, button { font: inherit; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg); color: var(--ink); width: 100%; box-sizing: border-box; margin-top: var(--space-3); }\nbutton { background: var(--ink); color: var(--bg); border: none; cursor: pointer; }\ncode.token { display: block; padding: var(--space-3); word-break: break-all; margin: var(--space-3) 0; }`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeText(title)}</title>
<style>${css}</style>
</head>
<body>
<main class="page notice">
<h1 class="title">${escapeText(title)}</h1>
${bodyHTML}
</main>
</body>
</html>
`;
  return htmlResponse(html, status);
}

export const notPublished = () => messagePage("Not found", `<p class="muted">This page isn't published, or the link was revoked.</p>`, 404);

/** Liegt `target` (Block-ID) im Bereich des Links und ist nicht im Papierkorb? */
function inArea(share: ShareService, link: SharingLink, target: string): boolean {
  const b = share.store.blocks.get(target);
  if (!b || isTrashed(share.store, target)) return false;
  return share.role({ kind: "link", link }, { kind: "block", data: b }) !== undefined;
}

/**
 * Eine Seite eines Links als HTML (veröffentlicht: `/p/<id>[/<page>]`; Access-Link: `/s/<secret>[/<page>]`).
 * Links auf Seiten außerhalb des Bereichs werden zu reinem Text.
 */
export function renderSharedPage(share: ShareService, link: SharingLink, target: string, base: string): string | undefined {
  return renderShared(share, link, target, base)?.html;
}

/** Wie `renderSharedPage`, dazu die CSP (BSD-236: fremde Embeds nur mit Opt-in des Publish-Links). */
export function renderShared(share: ShareService, link: SharingLink, target: string, base: string): { html: string; csp: string } | undefined {
  const store: WorkspaceStore = share.store;
  const b = store.blocks.get(target);
  if (!b || !isPageLike(b) && b.type !== "databaseInline" || !inArea(share, link, target)) return undefined;
  const exporter = new HTMLExporter(store, {
    pageLink: (id) => (inArea(share, link, id) && isPageLike(store.blocks.get(id)) ? { title: titleOf(store, id), url: `${base}/${encodeURIComponent(id)}` } : undefined),
    assetLink: (a) => `${base}/asset/${encodeURIComponent(a.id)}`,
    htmlBlockURL: (id) => `${base}/${encodeURIComponent(target)}/html/${encodeURIComponent(id)}`,
    embeds: link.allowEmbeds === true ? "frame" : "link",
    // BSD-279: nichts von außerhalb des Bereichs (Titel hinter Erwähnungen, Relationen, verknüpfte Datenbanken)
    canRead: (id) => inArea(share, link, id),
  });
  const html = exportHTMLPage(exporter, target, { css: exportStylesheet(), offline: true });
  return { html, csp: link.allowEmbeds === true ? pageCSP(embedHosts(store, target)) : PAGE_CSP };
}

/** Quelltext eines HTML-Blocks im Bereich des Links (Code-Block mit Sprache „html“). */
export function htmlBlockSource(share: ShareService, link: SharingLink, blockID: string): string | undefined {
  const b = share.store.blocks.get(blockID);
  if (!b || b.type !== "code" || (b.props?.language ?? "").toLowerCase() !== "html" || !inArea(share, link, blockID)) return undefined;
  const t = b.text;
  return typeof t === "string" ? t : (t ?? []).map((r) => r.t ?? "").join("");
}

export function htmlBlockResponse(source: string): RouteResult {
  return htmlResponse(source, 200, HTML_BLOCK_CSP);
}

/** Beitrittsseite einer Einladung (ein Formular, kein Skript). */
export function invitePage(title: string, link: SharingLink, error?: string): RouteResult {
  const t = title === "" ? "Untitled" : title;
  return messagePage(
    `You're invited to “${t}”`,
    `<p class="muted">${escapeText(ROLE_LABEL[link.role])}. Enter your name so others know who made changes.</p>
<form method="post">
<input name="name" placeholder="Your name" aria-label="Your name" maxlength="80" required autofocus>
<button type="submit">Join</button>
</form>
${error ? `<p class="muted" role="alert">${escapeText(error)}</p>` : ""}`,
  );
}

/** Nach dem Beitritt: der Geräte-Token, einmal sichtbar, und wie man ihn in Based einträgt. */
export function joinedPage(title: string, token: string, serverURL: string): RouteResult {
  return messagePage(
    "You're in",
    `<p>You can now open “${escapeText(title === "" ? "Untitled" : title)}” in Based.</p>
<p class="muted">In Based, open Settings → Sync &amp; server and connect with:</p>
<p>Server URL</p><code class="token">${escapeText(serverURL)}</code>
<p>Token</p><code class="token" data-testid="device-token">${escapeText(token)}</code>
<p class="muted">This token is shown only once. Keep it private — it works like a password for this shared page.</p>`,
  );
}

export const linkGone = () => messagePage("Link unavailable", `<p class="muted">This link has expired or was revoked.</p>`, 404);

export { escapeAttribute };
