// @vitest-environment jsdom
// BSD-209: Codeblock – Sprache gespeichert, Hervorhebung als Dekorationen, HTML-Vorschau ohne Netz.
import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { basedSchema } from "../src/schema/schema.js";
import { HTML_PREVIEW_CSP, htmlPreviewDoc, htmlPreviewFrame, syntaxDecorations, syntaxHighlighting } from "../src/schema/code.js";

describe("Codeblock", () => {
  it("hebt Code der gewählten Sprache hervor, Klartext nicht", () => {
    const editor = BlockNoteEditor.create({ schema: basedSchema(), extensions: [syntaxHighlighting] });
    const div = document.createElement("div");
    document.body.appendChild(div);
    editor.mount(div);
    editor.replaceBlocks(editor.document, [
      { type: "codeBlock", props: { language: "javascript" }, content: "const x = 1; // one" } as never,
      { type: "codeBlock", props: { language: "text" }, content: "const y = 2" } as never,
      { type: "codeBlock", props: { language: "ts" }, content: "" } as never, // unbekannt im Menü: zeichnet trotzdem
    ]);
    const tok = (cls: string) => [...div.querySelectorAll(".bx-tok-" + cls)].map((e) => e.textContent);
    expect(tok("keyword")).toEqual(["const"]);
    expect(tok("number")).toEqual(["1"]);
    expect(tok("comment")).toEqual(["// one"]);
    const doc = editor.prosemirrorState.doc;
    // drei Tokens im ersten Block, dazu ein Kopierknopf je Codeblock
    expect(syntaxDecorations(doc).find().length).toBe(6);
    expect(div.querySelectorAll("[data-content-type=codeBlock] .bx-code-copy").length).toBe(3);
    expect(editor.document[0]?.props).toMatchObject({ language: "javascript" });
    expect(editor.document[2]?.props).toMatchObject({ language: "ts" });
    editor.unmount();
  });

  it("HTML-Vorschau: CSP ohne Netz vor dem Code", () => {
    const d = htmlPreviewDoc("<b>hi</b>");
    expect(d).toContain(HTML_PREVIEW_CSP);
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(d.indexOf("Content-Security-Policy")).toBeLessThan(d.indexOf("<b>hi</b>"));
    const f = htmlPreviewFrame("<b>hi</b>").querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
  });
});

describe("PDF-Block (BSD-208)", () => {
  it("hochgeladenes PDF: asset im Record, based-asset:-URL im Editor, hin und zurück", async () => {
    const { projectBlock, extractOwned } = await import("../src/mapping/blocks.js");
    const rec = { id: "f", type: "pdf", parent: "b:p", sk: "a0", createdAt: 0, updatedAt: 0, props: { asset: { id: "abc", name: "" } } } as never;
    const bn = projectBlock(rec);
    expect(bn.props).toMatchObject({ kind: "pdf", url: "based-asset:abc" });
    expect(extractOwned(bn)).toMatchObject({ type: "pdf", props: { asset: { id: "abc" } } });
    const linked = projectBlock({ ...(rec as object), props: { url: "https://x.test/a.pdf" } } as never);
    expect(extractOwned(linked)).toMatchObject({ type: "pdf", props: { url: "https://x.test/a.pdf" } });
  });
});
