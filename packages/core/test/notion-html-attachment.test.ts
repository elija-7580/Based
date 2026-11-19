// Mac 19.11. (Elijás Second Brain, „Biomarker-Tracking“): Eine in Notion hochgeladene HTML-Datei (Embed-/Dateiblock)
// wurde beim Import zu einer eigenen Unterseite, deren Inhalt ohne <head>-Stil und ohne Skripte als HTML-Block landete –
// das Dashboard stand ohne Layout da, Karten und Tabellenzeilen (per Skript erzeugt) fehlten.
// Jetzt: die Anlage wird an ihrer Stelle ein HTML-Block mit der ganzen Datei, keine Unterseite.
import { describe, expect, it } from "vitest";
import { ImportFiles, importNotionItems, MemoryPersistence, WorkspaceStore, type Block } from "../src/index.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const bare = (id: string) => id.replaceAll("-", "");
const enc = new TextEncoder();
const doc = (id: string, title: string, body: string) =>
  `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>${title}</title></head><body><article id="${id}" class="page sans"><header><h1 class="page-title">${title}</h1></header><div class="page-body">${body}</div></article></body></html>`;
const DASHBOARD = `<!DOCTYPE html><html lang="de"><head><title>Biomarker-Tracking</title><style>.summary{display:grid;grid-template-columns:repeat(4,1fr)}</style></head>` +
  `<body><div class="wrap"><header><h1>Biomarker-Tracking</h1></header><section><div class="summary"></div></section>` +
  `<table><tbody id="trendBody"></tbody></table></div><script>document.getElementById('trendBody').innerHTML='<tr><td>x</td></tr>'</script></body></html>`;

function run(figure: (href: string) => string, linked = true) {
  const pageName = `Biomarker-Tracking ${bare(PAGE)}`;
  const href = `${encodeURIComponent(pageName)}/biomarker-tracking.html`;
  const files = new ImportFiles([
    [`${pageName}.html`, enc.encode(doc(PAGE, "Biomarker-Tracking", `<p>Intro</p>${linked ? figure(href) : ""}`))],
    [`${pageName}/biomarker-tracking.html`, enc.encode(DASHBOARD)],
  ]);
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n" });
  importNotionItems(store, [{ files, path: `${pageName}.html` }]);
  return store;
}

const all = (s: WorkspaceStore) => [...s.blocks.values()];
const text = (b: Block | undefined) => (typeof b?.text === "string" ? b.text : (b?.text ?? []).map((r) => r.t ?? "").join(""));

describe("Notion-Export: hochgeladene HTML-Datei", () => {
  it.each([
    ["Datei-/Embed-Block als Link", (h: string) => `<figure id="66666666-6666-4666-8666-666666666666"><div class="source"><a href="${h}">biomarker-tracking.html</a></div></figure>`],
    ["Embed als iframe", (h: string) => `<figure id="66666666-6666-4666-8666-666666666666"><iframe src="${h}"></iframe></figure>`],
  ])("%s: HTML-Block mit der ganzen Datei an ihrer Stelle, keine Unterseite", (_, figure) => {
    const s = run(figure);
    const pages = all(s).filter((b) => b.type === "page");
    expect(pages.map((p) => text(p))).toEqual(["Biomarker-Tracking"]);
    const kids = s.children("b:" + PAGE).map((id) => s.blocks.get(id)!);
    expect(kids.map((b) => b.type)).toEqual(["text", "code"]);
    const html = kids[1]!;
    expect(html.props).toMatchObject({ language: "html", codeView: "preview" });
    expect(text(html)).toBe(DASHBOARD); // <head>-Stil und Skript bleiben
    expect(all(s).some((b) => b.type === "file")).toBe(false);
  });

  it("nicht verlinkte Anlage im Seitenordner: Unterseite mit der ganzen Datei als HTML-Block (Stil und Skript bleiben)", () => {
    const s = run(() => "", false);
    const sub = all(s).find((b) => b.type === "page" && b.parent === "b:" + PAGE)!;
    expect(sub).toBeDefined();
    const kids = s.children("b:" + sub.id).map((id) => s.blocks.get(id)!);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.props).toMatchObject({ language: "html", codeView: "preview" });
    expect(text(kids[0])).toBe(DASHBOARD);
  });
});
