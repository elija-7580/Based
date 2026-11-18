// BSD-535: Eine HTML-Datei wird ein HTML-Block (Codeblock, Sprache HTML, nur das Ergebnis) – in einen leeren Absatz,
// in einen vorhandenen Codeblock (Code ersetzt) oder als neuer Block danach; ein Undo-Schritt; zu große Dateien nicht.
import { describe, expect, it } from "vitest";
import { blockCommands as cmd, KNOWN_KEYS, MemoryPersistence, WorkspaceStore, type WireRecord } from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const blk = (id: string, type: string, parent: string, sk: string, extra: Record<string, unknown> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, stamp, ...extra } }) as WireRecord;
const store = () => new WorkspaceStore({ persistence: new MemoryPersistence([
  blk("P", "page", "w", "a0", { text: "Page" }),
  blk("E", "text", "b:P", "a0"),
  blk("T", "text", "b:P", "a1", { text: "Some text" }),
  blk("C", "code", "b:P", "a2", { text: "<p>old</p>", props: { language: "html", codeView: "split", wrap: true } }),
]), node: "n" });
const HTML = "<!doctype html><h1>Artifact</h1><script>1</script>";

describe("BSD-535 HTML-Datei als HTML-Block", () => {
  it("leerer Absatz wird selbst zum HTML-Block (nur Ergebnis), ein Undo-Schritt", () => {
    const s = store();
    expect(cmd.placeHTMLFile(s, "E", HTML)).toEqual({ blockId: "E", selected: true });
    expect(s.blocks.get("E")).toMatchObject({ type: "code", text: HTML, props: { language: "html", codeView: "preview" } });
    s.undo();
    expect(s.blocks.get("E")?.type).toBe("text");
    expect(s.blocks.get("E")?.text).toBeUndefined();
  });

  it("vorhandener Codeblock: Code ersetzt, andere Einstellungen bleiben", () => {
    const s = store();
    cmd.placeHTMLFile(s, "C", HTML, { replace: true });
    expect(s.blocks.get("C")).toMatchObject({ type: "code", text: HTML, props: { language: "html", codeView: "preview", wrap: true } });
    // ohne replace: neuer Block nach dem Codeblock
    const f = cmd.placeHTMLFile(s, "C", "<p>next</p>");
    expect(s.children("b:P").at(-1)).toBe(f?.blockId);
    expect(s.blocks.get("C")?.text).toBe(HTML);
  });

  it("Absatz mit Text: neuer HTML-Block danach; zu groß: nichts", () => {
    const s = store();
    const f = cmd.placeHTMLFile(s, "T", HTML);
    const id = f?.blockId;
    expect(id && id !== "T").toBeTruthy();
    expect(s.children("b:P")).toEqual(["E", "T", id, "C"]);
    expect(s.blocks.get(id!)).toMatchObject({ type: "code", text: HTML, props: { language: "html", codeView: "preview" } });
    expect(cmd.placeHTMLFile(s, "E", "x".repeat(cmd.HTML_FILE_MAX_CHARS + 1))).toBeUndefined();
    expect(s.blocks.get("E")?.type).toBe("text");
  });

  it("Größe gezogen: width/height am Block (height nur TS-Stack, rein additiv)", () => {
    const s = store();
    cmd.setBlockProps(s, ["C"], { width: 480, height: 320 }, "Resize HTML");
    expect(s.blocks.get("C")?.props).toMatchObject({ width: 480, height: 320 });
    expect(KNOWN_KEYS.BlockProps).toContain("height");
  });
});
