// BSD-209: Bookmark-Vorschau aus HTML (ohne Netz).
import { describe, expect, it } from "vitest";
import { parseLinkPreview } from "../src/index.js";

describe("parseLinkPreview", () => {
  it("Open Graph vor <title>, relative Adressen werden absolut", () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="  The   Guide ">
      <meta name="description" content="Plain description">
      <meta property="og:description" content="OG description">
      <meta property="og:image" content="/img/cover.png">
      <link rel="shortcut icon" href="favicon-32.png"></head><body><h1>x</h1></body></html>`;
    expect(parseLinkPreview(html, "https://example.com/docs/guide")).toEqual({
      title: "The Guide", summary: "OG description", imageURL: "https://example.com/img/cover.png", iconURL: "https://example.com/docs/favicon-32.png",
    });
  });
  it("ohne Meta: <title>, Beschreibung, /favicon.ico; gefährliche Adressen fallen weg", () => {
    const html = `<title>Only &amp; title</title><meta name="description" content="Desc"><meta property="og:image" content="javascript:alert(1)">`;
    expect(parseLinkPreview(html, "https://site.test/a")).toEqual({ title: "Only & title", summary: "Desc", iconURL: "https://site.test/favicon.ico" });
  });
  it("lange Texte werden mit … gekürzt, leere Seite gibt nur das Icon", () => {
    const long = "w".repeat(500);
    expect(parseLinkPreview(`<meta name="twitter:title" content="${long}">`, "https://x.test/").title).toHaveLength(200);
    expect(parseLinkPreview("", "https://x.test/")).toEqual({ iconURL: "https://x.test/favicon.ico" });
  });
});
