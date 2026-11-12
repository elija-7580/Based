// BSD-209: Bookmark-Vorschau – Titel, Beschreibung, Bild und Icon aus dem HTML einer Seite (Open Graph, Twitter Card,
// <title>, <meta name=description>, <link rel=icon>). Geholt wird nur auf ausdrücklichen Klick („Fetch preview“) in
// der Desktop-App; hier nur das Auslesen, ohne Netz.
import type { BlockProps } from "../model/records.js";
import { decodeEntities, parseHTML } from "./html.js";

export type BookmarkMeta = NonNullable<BlockProps["bookmark"]>;

/** Höchstens so viel HTML lesen (der <head> steht vorn). */
export const LINK_PREVIEW_MAX_BYTES = 512 * 1024;

const clean = (s: string | undefined, max: number): string | undefined => {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

/** Absolute http(s)-Adresse oder nichts (keine javascript:/data:-Adressen in Records). */
function absolute(href: string | undefined, base: string): string | undefined {
  if (!href?.trim()) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Metadaten einer Seite aus ihrem HTML; `pageURL` löst relative Adressen auf. */
export function parseLinkPreview(html: string, pageURL: string): BookmarkMeta {
  const doc = parseHTML(html.length > LINK_PREVIEW_MAX_BYTES ? html.slice(0, LINK_PREVIEW_MAX_BYTES) : html);
  const metas = doc.all((n) => n.tag === "meta");
  const meta = (...keys: string[]) => {
    for (const k of keys) {
      const m = metas.find((n) => (n.attr("property") ?? n.attr("name") ?? "").toLowerCase() === k);
      const c = m?.attr("content");
      if (c?.trim()) return c;
    }
    return undefined;
  };
  const rawTitle = doc.first((n) => n.tag === "title")?.textContent;
  const titleTag = rawTitle === undefined ? undefined : decodeEntities(rawTitle);
  const icons = doc.all((n) => n.tag === "link" && /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(n.attr("rel") ?? ""));
  const out: BookmarkMeta = {};
  const title = clean(meta("og:title", "twitter:title") ?? titleTag, 200);
  const summary = clean(meta("og:description", "twitter:description", "description"), 300);
  const imageURL = absolute(meta("og:image", "og:image:url", "twitter:image"), pageURL);
  const iconURL = absolute(icons[0]?.attr("href") ?? "/favicon.ico", pageURL);
  if (title) out.title = title;
  if (summary) out.summary = summary;
  if (imageURL) out.imageURL = imageURL;
  if (iconURL) out.iconURL = iconURL;
  return out;
}
