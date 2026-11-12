// BSD-209: Bookmark-Vorschau nur, wo die Hülle fremde Seiten lesen kann (Desktop) – im Browser-Tab kein Knopf.
import { describe, expect, it } from "vitest";
import { linkPreviewFetcher } from "./linkPreview.js";

describe("linkPreviewFetcher", () => {
  it("im Browser ohne Tauri: keiner (kein Knopf „Fetch preview“)", () => {
    expect(linkPreviewFetcher({})).toBeUndefined();
  });
  it("Test-Haken: HTML → Vorschau mit absoluten Adressen", async () => {
    const f = linkPreviewFetcher({ __based: { linkPreviewHTML: async () => '<title>Docs</title><meta property="og:image" content="/c.png">' } })!;
    expect(await f("https://example.com/a/b")).toEqual({ title: "Docs", imageURL: "https://example.com/c.png", iconURL: "https://example.com/favicon.ico" });
  });
});
