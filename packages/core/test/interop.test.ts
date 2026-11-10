// BSD-176: Randfälle von HTML-Leser, URL-Prüfung und Seitenlinks, die die Golden Fixtures nicht abdecken.
import { describe, expect, it } from "vitest";
import { ClipboardHTMLImporter, decodeEntities, importedJSON, MarkdownImporter, pageIDFromLink, parseHTML, sanitizeURL } from "../src/index.js";

describe("HTML-Leser", () => {
  it("dekodiert Entities nur mit Semikolon in Reichweite", () => {
    expect(decodeEntities("&amp;&#65;&#x42;&#39;&bogus;&amp")).toBe("&AB'&bogus;&amp");
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
  });
  it("schließt <li> und <p> implizit und liest Rohtext in <script>", () => {
    const root = parseHTML("<ul><li>a<li>b</ul><p>x<p>y<script>if (a<b) {}</script>");
    expect(root.children.map((c) => c.tag)).toEqual(["ul", "p", "p"]);
    expect(root.children[0]!.children.length).toBe(2);
    expect(root.children[2]!.children[1]!.rawText).toBe("");
    expect(root.children[2]!.children[1]!.innerHTML).toBe("if (a<b) {}");
  });
  it("lässt \\r\\n wie Swift stehen (ein Zeichen)", () => {
    const blocks = new ClipboardHTMLImporter().parse("<p>a\r\nb  c</p>").map(importedJSON);
    expect(blocks[0]!.text).toBe("a\r\nb c");
  });
});

describe("URLs", () => {
  it("entschärft javascript: auch mit Steuerzeichen im Schema", () => {
    expect(sanitizeURL("java\tscript:alert(1)")).toBe("#");
    expect(sanitizeURL(" https://x.y ")).toBe("https://x.y");
    expect(sanitizeURL("assets/a.png")).toBe("assets/a.png");
    expect(sanitizeURL("data:image/png;base64,AA", true)).toBe("data:image/png;base64,AA");
    expect(sanitizeURL("data:image/svg+xml,<svg>", true)).toBe("#");
  });
  it("liest Seiten-IDs aus Based- und Notion-Links", () => {
    expect(pageIDFromLink("based://page/doc-1")).toBe("doc-1");
    expect(pageIDFromLink("https://www.notion.so/Tasks-1fe618c1167e80f8946ec1a7918dfc28")).toBe("1fe618c1-167e-80f8-946e-c1a7918dfc28");
    expect(pageIDFromLink("https://example.com")).toBe("https://example.com");
  });
});

describe("Markdown-Import: eingerückte Zeile nach Block ohne Kinder (BSD-183)", () => {
  const types = (md: string) => new MarkdownImporter().parse(md).map((b) => [b.type, b.children.length]);
  it("Code-Block bleibt erhalten, eingerückte Zeile wird eigener Block", () => {
    const blocks = new MarkdownImporter().parse("```js\nlet a = 1\n```\n    eingerückt\nweiter");
    expect(blocks.map((b) => b.type)).toEqual(["code", "text", "text"]);
    expect(blocks[0]!.props).toMatchObject({ language: "js" });
  });
  it("Trenner, Gleichung und Bild gehen nicht verloren", () => {
    expect(types("---\n  - a\n      - b")).toEqual([["divider", 0], ["bulletedList", 1]]);
    expect(types("$$x$$\n    y")).toEqual([["equation", 0], ["text", 0]]);
  });
  it("Block mit Kindern nimmt die eingerückte Zeile weiter als Kind", () => {
    expect(types("- a\n    - b")).toEqual([["bulletedList", 1]]);
  });
});
