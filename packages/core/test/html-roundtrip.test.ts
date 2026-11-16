// Prüfung Pass 37 (Import/Export): Rundreise HTML-Export von Based → HTML-Import. Vorher blieb die Seite leer – der
// Import hielt Based' <article class="page"> für eine Notion-Seite und suchte deren „page-body“. Jetzt erkennt er den
// Export (<meta name="generator" content="Based">) und liest Überschriften (eine Ebene tiefer), Aufgaben, Farben und
// Formeln wie geschrieben. Grenze: mehrfache Leerzeichen fallen zusammen (HTML-Leerraum).
import { describe, expect, it } from "vitest";
import { createPage, exportPageHTML, exportWorkspaceHTML, ImportFiles, importNotionItems, MemoryPersistence, runsOf, titleOf, topLevelPages, WorkspaceStore, type Block } from "../src/index.js";

const CASES: [string, unknown, Record<string, unknown>?][] = [
  ["text", "Plain *star* _under_ `tick` # hash [br] | pipe \\ backslash <b>x</b> & &amp; \"q\" 'a'"],
  ["text", "1. not a list"], ["text", "line1\nline2"],
  ["text", [{ t: "bold", m: { b: true } }, { t: " and " }, { t: "ital", m: { i: true } }, { t: " " }, { t: "code `x`", m: { c: true } }, { t: "u", m: { u: true } }, { t: "s", m: { s: true } }]],
  ["text", [{ t: "red", m: { color: "red" } }, { t: "bg", m: { color: "yellowBackground" } }]],
  ["text", [{ t: "Formel ", m: {} }, { t: "a^2", m: {}, eq: "a^2" }]],
  ["text", [{ t: "link", m: { link: "https://example.com/a_(b)?x=1&y=2" } }]],
  ["heading1", "H1"], ["heading2", "H2"], ["heading3", "H3"], ["bulletedList", "item"], ["numberedList", "num"],
  ["todo", "todo", { checked: true }], ["todo", "open", { checked: false }],
  ["quote", "multi\nline quote"], ["code", "a <b> & `c`\n  indented\ttab", { language: "typescript" }], ["text", "emoji 🧠 Ä ß"],
  ["callout", "note", { icon: "💡" }], ["toggle", "toggle head"], ["divider", ""], ["equation", "", { expression: "e^{i\\pi}+1=0" }],
  ["text", "farbiger Absatz", { color: "blue" }],
];

function source() {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const page = createPage(store, { title: "Rundreise" });
  const now = store.now();
  store.transact("t", (tx) => CASES.forEach(([type, text, props], i) => tx.put({ kind: "block", data: { id: "b" + i, type, parent: "b:" + page, sk: "a" + String(i).padStart(3, "0"), ...(text !== "" ? { text } : {}), ...(props ? { props } : {}), createdAt: now, updatedAt: now } as Block })));
  return { store, page };
}

const importInto = (name: string, data: Uint8Array) => {
  const dst = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "d" });
  const report = importNotionItems(dst, [{ files: new ImportFiles([[name, data]]), path: name }]);
  return { dst, report };
};

describe("HTML-Rundreise (Prüfung Pass 37)", () => {
  it("eine Seite: Blöcke, Marks, Farben, Aufgaben, Formeln, Code-Sprache kommen zurück", () => {
    const { store, page } = source();
    const html = exportPageHTML(store, page);
    const { dst, report } = importInto(html.name, html.data);
    const root = report.rootIDs[0]!;
    expect(titleOf(dst, root)).toBe("Rundreise");
    const got = dst.children("b:" + root).map((k) => dst.blocks.get(k)!);
    expect(got.map((b) => b.type)).toEqual(CASES.map(([t]) => t));
    CASES.forEach(([, text, props], i) => {
      expect(JSON.stringify(runsOf(got[i]!.text as never)), `#${i}`).toBe(JSON.stringify(runsOf(text as never)));
      for (const [k, v] of Object.entries(props ?? {})) expect((got[i]!.props as Record<string, unknown> | undefined)?.[k], `#${i} ${k}`).toEqual(v);
    });
  });

  it("ganzer Workspace als ZIP: Seiten und Unterseiten mit Inhalt", () => {
    const { store, page } = source();
    const sub = createPage(store, { title: "Unterseite", parent: page });
    const now = store.now();
    store.transact("t", (tx) => tx.put({ kind: "block", data: { id: "s1", type: "text", parent: "b:" + sub, sk: "a0", text: "Inhalt der Unterseite", createdAt: now, updatedAt: now } as Block }));
    const zip = exportWorkspaceHTML(store);
    const { dst } = importInto(zip.name, zip.data);
    const top = topLevelPages(dst);
    const rt = top.find((b) => titleOf(dst, b.id) === "Rundreise")!;
    expect(rt).toBeDefined();
    expect(dst.children("b:" + rt.id).length).toBeGreaterThanOrEqual(CASES.length);
    const subPage = [...dst.blocks.values()].find((b) => b.type === "page" && titleOf(dst, b.id) === "Unterseite")!;
    expect(subPage).toBeDefined();
    expect(dst.children("b:" + subPage.id).map((k) => runsOf(dst.blocks.get(k)!.text as never).map((r) => r.t).join(""))).toContain("Inhalt der Unterseite");
  });

  it("andere <article class=\"page\"> ohne Based-Kennung bleiben Notion-Seiten", () => {
    const html = `<html><head><title>N</title></head><body><article id="11111111-1111-4111-8111-111111111111" class="page sans"><header><h1 class="page-title">N</h1></header><div class="page-body"><h2>Kopf</h2><p>Text</p></div></article></body></html>`;
    const { dst, report } = importInto("N 11111111111141118111111111111111.html", new TextEncoder().encode(html));
    expect(dst.children("b:" + report.rootIDs[0]!).map((k) => dst.blocks.get(k)!.type)).toEqual(["heading2", "text"]);
  });
});
