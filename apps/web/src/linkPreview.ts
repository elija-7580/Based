// BSD-209: Bookmark-Vorschau holen – nur auf Klick „Fetch preview“ und nur in der Desktop-App (Tauri-HTTP, kein CORS;
// erlaubt sind https-Adressen, apps/desktop/src-tauri/capabilities/default.json). Im Browser-Tab gibt es den Knopf
// nicht (Entscheidung Elija 11.11.: Server-Endpunkt erst nach der Beta). Tests setzen `__based.linkPreviewHTML`.
import { LINK_PREVIEW_MAX_BYTES, parseLinkPreview, type BookmarkMeta } from "@based/core";
import { isTauri } from "./desktop.js";

type TestHook = { __based?: { linkPreviewHTML?: (url: string) => Promise<string> } };

/** Holer für die Bookmark-Vorschau oder nichts, wenn diese Hülle keine fremden Seiten lesen kann. */
export function linkPreviewFetcher(g: TestHook = globalThis as TestHook): ((url: string) => Promise<BookmarkMeta>) | undefined {
  const hook = g.__based?.linkPreviewHTML;
  if (typeof hook === "function") return async (url) => parseLinkPreview(await hook(url), url);
  if (!isTauri()) return undefined;
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("Only https links can be previewed");
    const http = await import("@tauri-apps/plugin-http");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await http.fetch(u.href, { method: "GET", headers: { Accept: "text/html" }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (type && !/html|xml/i.test(type)) return {};
      const html = (await res.text()).slice(0, LINK_PREVIEW_MAX_BYTES);
      return parseLinkPreview(html, res.url || u.href);
    } finally {
      clearTimeout(timer);
    }
  };
}
