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
    expect(syntaxDecorations(doc).find().length).toBe(3);
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
