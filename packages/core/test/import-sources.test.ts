// Import-Prüfung (BSD-563): echte Exportformate der großen Notiz-Apps, so wie die Apps sie schreiben – Notion
// (Markdown & CSV, HTML mit Teil-Archiven und CSV-Zwillingen), gewöhnliche Markdown-Ordner, Obsidian, Logseq, Evernote,
// Joplin (JEX), Roam Research (JSON), Google Keep (Takeout), Simplenote, Standard Notes, ChatGPT und Claude.
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { derivedID, extractTar, ImportFiles, importNotionItems, isTar, MemoryAssetSink, MemoryPersistence, plainText, WorkspaceStore, type Block, type ImportReport } from "../src/index.js";
import { MarkdownImporter } from "../src/interop/markdown.js";
import { parseDate } from "../src/query/value.js";

const enc = new TextEncoder();
const files = (m: Record<string, string | Uint8Array>) => new ImportFiles(Object.entries(m).map(([k, v]) => [k, typeof v === "string" ? enc.encode(v) : v] as const));
function load(m: Record<string, string | Uint8Array>, paths: string[]): { s: WorkspaceStore; r: ImportReport } {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const f = files(m);
  const r = importNotionItems(s, paths.map((path) => ({ files: f, path })), { assets: new MemoryAssetSink(), warnMissingFiles: true });
  return { s, r };
}
const kids = (s: WorkspaceStore, parent: string) => s.children(parent).map((id) => s.blocks.get(id)!);
const titles = (s: WorkspaceStore, parent: string) => kids(s, parent).map((b) => plainText(b.text));
const named = (s: WorkspaceStore, title: string, type = "page") => [...s.blocks.values()].find((b) => b.type === type && plainText(b.text) === title)!;
const dbNamed = (s: WorkspaceStore, title: string) => [...s.databases.values()].find((d) => d.title === title)!;
const prop = (s: WorkspaceStore, db: string, name: string) => dbNamed(s, db).properties.find((p) => p.name === name)!;
const value = (s: WorkspaceStore, db: string, row: Block, name: string) => row.values?.[prop(s, db, name).id] as Record<string, { _0: unknown }> | undefined;
/** Typen und Texte eines Teilbaums, eingerückt (zum Vergleichen). */
function outline(s: WorkspaceStore, parent: string, depth = 0): string[] {
  return kids(s, parent).flatMap((b) => [`${"  ".repeat(depth)}${b.type}: ${plainText(b.text)}`, ...outline(s, "b:" + b.id, depth + 1)]);
}

/** tar-Archiv schreiben (ustar, nur Dateien). */
function tar(entries: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, v] of Object.entries(entries)) {
    const data = enc.encode(v);
    const h = new Uint8Array(512);
    h.set(enc.encode(name).subarray(0, 100), 0);
    h.set(enc.encode("0000644\0"), 100); h.set(enc.encode("0000000\0"), 108); h.set(enc.encode("0000000\0"), 116);
    h.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    h.set(enc.encode("00000000000\0"), 136);
    h.set(enc.encode("        "), 148); h[156] = 48;
    h.set(enc.encode("ustar\0" + "00"), 257);
    let sum = 0; for (const b of h) sum += b;
    h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0; for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

const H = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", T = "9f8e7d6c5b4a39281706f5e4d3c2b1a0", R1 = "aa11bb22cc33dd44ee55ff6677889900", R2 = "bb11bb22cc33dd44ee55ff6677889900", S = "cc11bb22cc33dd44ee55ff6677889900", O = "dd11bb22cc33dd44ee55ff6677889900", OP = "ee11bb22cc33dd44ee55ff6677889900";
const dash = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

describe("Notion: Markdown & CSV, wie Notion es schreibt", () => {
  const csv = `\uFEFFName,Status,Due,Tags,Done,Related,Price,Progress,Range,Missing\n`
    + `Write report,In progress,"November 18, 2026","work, urgent",No,Other page (../Other%20DB%20${O}/Other%20page%20${OP}.md),"$1,200.00",50%,"November 18, 2026 → November 20, 2026",Gone (Elsewhere%20${"f".repeat(32)}/Gone%20${"0".repeat(32)}.md)\n`
    + `Untitled,Done,"November 19, 2026 3:00 PM (GMT+1)",work,Yes,,$5.50,100%,,\n`;
  const home = [
    "# Home", "", "- [ ]  Todo item", "- [x]  Done item", "", "This costs $5 and $10, math $a^2$.", "",
    `[Tasks](Home%20${H}/Tasks%20${T}.csv)`, "", "[https://www.youtube.com/watch?v=abc](https://www.youtube.com/watch?v=abc)", "",
  ].join("\n");
  const inner = zipSync({
    [`Home ${H}.md`]: enc.encode(home),
    [`Home ${H}/Tasks ${T}.csv`]: enc.encode(csv),
    [`Home ${H}/Tasks ${T}_all.csv`]: enc.encode(csv),
    [`Home ${H}/Tasks ${T}/Write report ${R1}.md`]: enc.encode("# Write report\n\nStatus: In progress\nPrice: $1,200.00\n\nBody text of row.\n"),
    [`Home ${H}/Tasks ${T}/Untitled ${R2}.md`]: enc.encode("# Untitled\n\nStatus: Done\n\nSecond body\n"),
    [`Home ${H}/notes.txt`]: enc.encode("an uploaded text file, not a page"),
    [`Other DB ${O}.csv`]: enc.encode("Name,Notes\nOther page,hello\n"),
    [`Other DB ${O}/Other page ${OP}.md`]: enc.encode("# Other page\n\nNotes: hello\n\ncontent\n"),
  });
  const { s, r } = load({ "Export-1234.zip": zipSync({ "Export-1234-Part-1.zip": inner }) }, ["Export-1234.zip"]);

  it("Aufgaben ohne führendes Leerzeichen, Geldbeträge sind keine Formel, Lesezeichen", () => {
    const home = named(s, "Home");
    const body = kids(s, "b:" + home.id);
    expect(body.filter((b) => b.type === "todo").map((b) => plainText(b.text))).toEqual(["Todo item", "Done item"]);
    const money = body.find((b) => plainText(b.text).startsWith("This costs"))!;
    expect(plainText(money.text)).toBe("This costs $5 and $10, math a^2.");
    expect(JSON.stringify(money.text)).toContain("a^2"); // die echte Formel bleibt eine
    expect(body.find((b) => b.type === "bookmark")?.props?.url).toBe("https://www.youtube.com/watch?v=abc");
    // eine hochgeladene .txt im Notion-Export ist ein Anhang, keine Unterseite
    expect([...s.blocks.values()].some((b) => b.type === "page" && plainText(b.text) === "notes")).toBe(false);
  });

  it("Datum mit Zeitzone und Bereich, Währung, Prozent", () => {
    expect(prop(s, "Tasks", "Due").type).toBe("date");
    expect(prop(s, "Tasks", "Range").type).toBe("date");
    expect(prop(s, "Tasks", "Price")).toMatchObject({ type: "number", numberFormat: "dollar" });
    expect(prop(s, "Tasks", "Progress")).toMatchObject({ type: "number", numberFormat: "percent" });
    const row = named(s, "Write report");
    expect(value(s, "Tasks", row, "Price")).toEqual({ number: { _0: 1200 } });
    expect(value(s, "Tasks", row, "Progress")).toEqual({ number: { _0: 0.5 } });
    expect((value(s, "Tasks", row, "Range")!.date!._0 as { end?: number }).end).toBeDefined();
    expect(parseDate("November 19, 2026 3:00 PM (GMT+1)")).toEqual(parseDate("November 19, 2026 3:00 PM"));
    expect(parseDate("May 4, 2024 (UTC)")?.includeTime).toBe(false);
    expect(r.rows).toBe(3);
  });

  it("Relation auf eine Datenbank im Export wird eine Relation; fehlende Ziele bleiben als Titel", () => {
    const rel = prop(s, "Tasks", "Related");
    expect(rel.type).toBe("relation");
    expect(rel.relation?.databaseID).toBe(dbNamed(s, "Other DB").id);
    expect(value(s, "Tasks", named(s, "Write report"), "Related")).toEqual({ relation: { _0: [named(s, "Other page").id] } });
    expect(prop(s, "Tasks", "Missing").type).toBe("text");
    expect(value(s, "Tasks", named(s, "Write report"), "Missing")).toEqual({ text: { _0: "Gone" } });
  });
});

describe("Notion: HTML-Export in Teilen", () => {
  const page = (id: string, title: string, body: string, head = "") => `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>${title}</title></head><body><article id="${dash(id)}" class="page sans"><header><h1 class="page-title">${title}</h1>${head}</header><div class="page-body">${body}</div></article></body></html>`;
  const home = page(H, "Home", `<p>Intro</p><figure id="${dash(S)}" class="link-to-page"><a href="Home%20${H}/Sub%20${S}.html">Sub</a></figure><div id="${dash(T)}" class="collection-content"><h4 class="collection-title">Tasks</h4><table class="collection-content"><thead><tr><th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th><th><span class="icon property-icon"><svg class="typesSelect"></svg></span>Kind</th></tr></thead><tbody><tr id="${dash(R1)}"><td class="cell-title"><a href="Home%20${H}/Tasks%20${T}/Write%20${R1}.html">Write</a></td><td><span class="selected-value select-value-color-green">A</span></td></tr></tbody></table></div>`);
  const p1 = zipSync({ "index.html": enc.encode("<html><body><ul><li><a href=\"x\">Home</a></li></ul></body></html>"), [`Home ${H}.html`]: enc.encode(home), [`Home ${H}/Tasks ${T}.csv`]: enc.encode("Name,Kind\nWrite,A\n"), [`Home ${H}/Tasks ${T}_all.csv`]: enc.encode("Name,Kind\nWrite,A\n") }, { level: 0 });
  const p2 = zipSync({ [`Home ${H}/Sub ${S}.html`]: enc.encode(page(S, "Sub", "<p>Sub body</p>")), [`Home ${H}/Tasks ${T}/Write ${R1}.html`]: enc.encode(page(R1, "Write", "<p>Row body</p>")) }, { level: 0 });
  const expected = ["page: Home", "  text: Intro", "  page: Sub", "    text: Sub body", "  databaseInline: "];

  it.each([
    ["ein ZIP mit Teil-Archiven", { "Export-abc.zip": zipSync({ "Export-abc-Part-1.zip": p1, "Export-abc-Part-2.zip": p2 }, { level: 0 }) }, ["Export-abc.zip"]],
    ["die Teile einzeln gewählt", { "Export-abc-Part-1.zip": p1, "Export-abc-Part-2.zip": p2 }, ["Export-abc-Part-1.zip", "Export-abc-Part-2.zip"]],
  ])("%s: Unterseiten und Zeilen behalten ihren Platz, die CSV legt keine zweite Datenbank an", (_n, input, paths) => {
    const { s, r } = load(input as Record<string, Uint8Array>, paths as string[]);
    expect(outline(s, "w")).toEqual(expected);
    expect(r.databases).toBe(1);
    expect(s.databases.size).toBe(1);
    const rows = kids(s, "d:" + dbNamed(s, "Tasks").id);
    expect(rows.map((b) => plainText(b.text))).toEqual(["Write"]);
    expect(titles(s, "b:" + rows[0]!.id)).toEqual(["Row body"]);
  });
});

describe("BSD-661: Notion-Markdown mit Umlauten – Dateiname NFD, Link NFC (oder umgekehrt)", () => {
  const sub = "Über – Plan 🚀 & 100 % «Größe»";
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  /** Export „Markdown & CSV“ mit Unterseite, Bild und Datenbank; `files`/`links`: Unicode-Form der Dateinamen bzw. Links. */
  const exportZip = (files: "NFC" | "NFD", links: "NFC" | "NFD") => {
    const f = (x: string) => x.normalize(files), l = (x: string) => encodeURIComponent(x.normalize(links));
    return zipSync({
      [`Home ${H}.md`]: enc.encode(`# Home\n\nIntro\n\n[${sub}](Home%20${H}/${l(sub)}%20${S}.md)\n\n![](Home%20${H}/${l("Bild Ä.png")})\n\n[Aufgaben](Home%20${H}/${l("Aufgaben")}%20${T}.csv)\n`),
      [`Home ${H}/${f(sub)} ${S}.md`]: enc.encode(`# ${sub}\n\nSub body\n`),
      [`Home ${H}/${f("Bild Ä.png")}`]: png,
      [`Home ${H}/${f("Aufgaben")} ${T}.csv`]: enc.encode("Name\nPrüfen\n"),
      [`Home ${H}/${f("Aufgaben")} ${T}_all.csv`]: enc.encode("Name\nPrüfen\n"),
    });
  };
  const run = (s: WorkspaceStore, zip: Uint8Array) => importNotionItems(s, [{ files: files({ "Export-u.zip": zip }), path: "Export-u.zip" }], { assets: new MemoryAssetSink(), warnMissingFiles: true });
  const fresh = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const live = (s: WorkspaceStore) => [...s.blocks.values()].filter((b) => b.trashedAt === undefined);
  const snapshot = (s: WorkspaceStore) => ({
    outline: outline(s, "w"),
    ids: live(s).map((b) => b.id).sort(),
    image: live(s).find((b) => b.type === "image")?.props?.asset !== undefined,
  });
  const same = fresh();
  run(same, exportZip("NFC", "NFC"));
  const expected = snapshot(same);

  it("Grundlage (gleiche Form): Unterseite und Datenbank an ihrem Platz, Bild als Datei", () => {
    expect(expected.outline.slice(0, 4)).toEqual(["page: Home", "  text: Intro", `  page: ${sub}`, "    text: Sub body"]);
    expect(expected.outline.some((l) => l.startsWith("  text: ") && l.includes(sub))).toBe(false);
    expect(expected.image).toBe(true);
  });

  it.each([["NFD", "NFC"], ["NFC", "NFD"]] as const)("Dateinamen %s, Links %s: gleiche Gliederung, IDs und Bild; Reimport ohne Duplikate", (fileForm, linkForm) => {
    const s = fresh();
    const zip = exportZip(fileForm, linkForm);
    const r = run(s, zip);
    expect(r.warnings.filter((w) => w.startsWith("Missing file"))).toEqual([]);
    const got = snapshot(s);
    expect(got.outline.map((l) => l.normalize("NFC"))).toEqual(expected.outline);
    expect(got.ids).toEqual(expected.ids);
    expect(got.image).toBe(true);
    run(s, zip);
    expect(snapshot(s).ids).toEqual(expected.ids);
  });
});

describe("BSD-656: Notion-HTML mit Umlauten – Dateiname NFD, Link NFC (oder umgekehrt)", () => {
  const page = (id: string, title: string, body: string) => `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>${title}</title></head><body><article id="${dash(id)}" class="page sans"><header><h1 class="page-title">${title}</h1></header><div class="page-body">${body}</div></article></body></html>`;
  const sub = "Über – Plan 🚀 & 100 % «Größe»";
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  /** Export mit Unterseite, Bild und Zeilenseite; `files`/`links`: Unicode-Form der Dateinamen bzw. der Links. */
  const exportZip = (files: "NFC" | "NFD", links: "NFC" | "NFD") => {
    const f = (x: string) => x.normalize(files), l = (x: string) => encodeURIComponent(x.normalize(links));
    const home = page(H, "Home", `<p>Intro</p><figure id="${dash(OP)}" class="link-to-page"><a href="Home%20${H}/${l(sub)}%20${S}.html">${sub}</a></figure>`
      + `<figure class="image"><a href="Home%20${H}/${l("Bild Ä.png")}"><img src="Home%20${H}/${l("Bild Ä.png")}"/></a></figure>`
      + `<div id="${dash(T)}" class="collection-content"><h4 class="collection-title">Aufgaben</h4><table class="collection-content"><thead><tr><th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th></tr></thead><tbody><tr id="${dash(R1)}"><td class="cell-title"><a href="Home%20${H}/${l("Aufgaben")}%20${T}/${l("Prüfen")}%20${R1}.html">Prüfen</a></td></tr></tbody></table></div>`);
    return zipSync({
      [`Home ${H}.html`]: enc.encode(home),
      [`Home ${H}/${f(sub)} ${S}.html`]: enc.encode(page(S, sub, "<p>Sub body</p>")),
      [`Home ${H}/${f("Bild Ä.png")}`]: png,
      [`Home ${H}/Aufgaben ${T}/${f("Prüfen")} ${R1}.html`]: enc.encode(page(R1, "Prüfen", "<p>Row body</p>")),
    });
  };
  const run = (s: WorkspaceStore, zip: Uint8Array) => importNotionItems(s, [{ files: files({ "Export-u.zip": zip }), path: "Export-u.zip" }], { assets: new MemoryAssetSink(), warnMissingFiles: true });
  const fresh = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const live = (s: WorkspaceStore) => [...s.blocks.values()].filter((b) => b.trashedAt === undefined);
  const snapshot = (s: WorkspaceStore) => ({
    outline: outline(s, "w"),
    ids: live(s).map((b) => b.id).sort(),
    image: live(s).find((b) => b.type === "image")?.props?.asset !== undefined,
    rowBody: titles(s, "b:" + dash(R1)),
  });
  const same = fresh();
  run(same, exportZip("NFC", "NFC"));
  const expected = snapshot(same);

  it("Grundlage (gleiche Form): Unterseite an ihrem Platz, Bild als Datei, Zeile mit Inhalt", () => {
    expect(expected.outline.slice(0, 4)).toEqual(["page: Home", "  text: Intro", `  page: ${sub}`, "    text: Sub body"]);
    expect(expected.outline.some((l) => l.includes("linkToPage"))).toBe(false);
    expect(expected.image).toBe(true);
    expect(expected.rowBody).toEqual(["Row body"]);
  });

  it.each([["NFD", "NFC"], ["NFC", "NFD"]] as const)("Dateinamen %s, Links %s: gleiche Gliederung und IDs; Reimport ohne Duplikate", (fileForm, linkForm) => {
    const s = fresh();
    const zip = exportZip(fileForm, linkForm);
    const r = run(s, zip);
    expect(r.warnings.filter((w) => /missing|fehlt/i.test(w))).toEqual([]);
    expect(snapshot(s)).toEqual(expected);
    run(s, zip);
    expect(snapshot(s)).toEqual(expected);
  });
});

describe("Gewöhnliche Markdown-Ordner", () => {
  it("Ordner werden Seiten, .txt und .markdown sind Notizen, Punkt-Dateien fallen weg, <Pfad mit Leerzeichen>", () => {
    const { s, r } = load({
      "Notes/Work/Meeting.md": "# Meeting\n\n![pic](<../img/pic one.png>)\n",
      "Notes/Work/Deep/Deeper.markdown": "Just text\n",
      "Notes/Personal/Ideas.md": "Some idea. See [Meeting](../Work/Meeting.md).\n",
      "Notes/README.md": "# Readme\n\nTop",
      "Notes/img/pic one.png": "PNG",
      "Notes/todo.txt": "plain text file",
      "Notes/d41d8cd98f00b204e9800998ecf8427e.png": "PNG",
      "Notes/.DS_Store": "x",
      "Notes/.git/config.md": "x",
    }, ["Notes"]);
    expect(outline(s, "w")).toEqual([
      "page: Readme", "  text: Top",
      "page: todo", "  text: plain text file",
      "page: Personal", "  page: Ideas", "    text: Some idea. See Meeting.",
      "page: Work", "  page: Meeting", "    image: ", "  page: Deep", "    page: Deeper", "      text: Just text",
    ]);
    expect(kids(s, "b:" + named(s, "Meeting").id)[0]!.props?.asset?.name).toBe("pic one.png");
    expect(JSON.stringify(kids(s, "b:" + named(s, "Ideas").id)[0]!.text)).toContain(named(s, "Meeting").id);
    expect(r.warnings.filter((w) => w.startsWith("Missing"))).toEqual([]);
  });

  it("OneNote-Dateien: Hinweis mit dem Weg, der geht", () => {
    const { r } = load({ "Notebook.one": "x" }, ["Notebook.one"]);
    expect(r.warnings.join(" ")).toContain("export the notebook as Word");
  });
});

describe("Markdown-Leser", () => {
  const parse = (md: string) => new MarkdownImporter().parse(md);
  it("Hinweise: eingeklappt, mit Liste, eigene Art", () => {
    const [folded, plain, custom] = parse("> [!warning]- Folded\n> Body **bold**\n> - item\n\n> [!info]\n> Just text\n\n> [!seealso] Other");
    expect(folded).toMatchObject({ type: "callout", props: { icon: "⚠️" } });
    expect(folded!.text.map((r) => r.t).join("")).toBe("Folded");
    expect(folded!.children.map((c) => c.type)).toEqual(["text", "bulletedList"]);
    expect(plain!.text.map((r) => r.t).join("")).toBe("Just text");
    expect(custom).toMatchObject({ type: "callout" });
  });
  it("Aufgaben-Zustände, Einbettung per iframe", () => {
    const b = parse("- [/] started\n- [-] cancelled\n- [x] done\n\n<iframe src=\"https://www.youtube.com/embed/abc\" width=\"560\"></iframe>");
    expect(b.slice(0, 3).map((x) => [x.type, x.props.checked, x.text.map((r) => r.t).join("")])).toEqual([["todo", false, "started"], ["todo", false, "cancelled"], ["todo", true, "done"]]);
    expect(b[3]).toMatchObject({ type: "embed", props: { url: "https://www.youtube.com/embed/abc" } });
  });
});

describe("Obsidian und Logseq", () => {
  it("Obsidian: unlesbare Excalidraw-Zeichnung wird ein leeres Board mit Hinweis; Dateien in Listen bleiben in der Liste", () => {
    const { s, r } = load({
      "Vault/.obsidian/app.json": "{}",
      "Vault/Note.md": "- item with file [doc](attachments/doc.pdf)\n- ![[pic.png]]\n- [/] started [[Other]]\n",
      "Vault/Other.md": "x",
      "Vault/Drawing.excalidraw.md": "---\nexcalidraw-plugin: parsed\n---\n# Text Elements\n%%\n```compressed-json\nN4KAkARALg\n```\n%%",
      "Vault/attachments/doc.pdf": "%PDF",
      "Vault/attachments/pic.png": "PNG",
    }, ["Vault"]);
    expect(titles(s, "b:" + r.rootIDs[0]!)).toEqual(["Drawing", "Note", "Other"]); // BSD-566: Zeichnungen werden Boards
    expect(r.warnings.some((w) => w.includes("Drawing.excalidraw.md"))).toBe(true);
    expect(outline(s, "b:" + named(s, "Note").id)).toEqual(["bulletedList: item with file", "  pdf: ", "image: ", "todo: started Other"]);
  });

  it("Logseq: Aufgaben-Marken, Zitat-Block, Hervorhebung, Bildgröße, collapsed", () => {
    const { s, r } = load({
      "graph/logseq/config.edn": "{}",
      "graph/journals/2026_11_18.md": "- TODO write notes\n- DONE call\n- LATER read {{embed [[Anna]]}}\n- ![img](../assets/a.png){:height 200, :width 300}\n- #+BEGIN_QUOTE\n  quoted\n  #+END_QUOTE\n- #+BEGIN_WARNING\n  careful\n  #+END_WARNING\n",
      "graph/pages/Anna.md": "- ^^highlight^^\n- collapsed:: true\n  Parent\n\t- child\n",
      "graph/assets/a.png": "PNG",
    }, ["graph"]);
    expect(r.warnings[0]).toContain("Logseq graph");
    const day = kids(s, "b:" + named(s, "Nov 18th, 2026").id);
    expect(day.map((b) => [b.type, plainText(b.text)])).toEqual([["todo", "write notes"], ["todo", "call"], ["todo", "read Anna"], ["image", ""], ["quote", "quoted"], ["callout", "careful"]]);
    expect(day.map((b) => b.props?.checked)).toEqual([false, true, false, undefined, undefined, undefined]);
    expect(outline(s, "b:" + named(s, "Anna").id)).toEqual(["bulletedList: highlight", "bulletedList: Parent", "  bulletedList: child"]);
  });
});

describe("Evernote", () => {
  it("Code-Blöcke (alt und neu) werden Code", () => {
    const enex = `<?xml version="1.0" encoding="UTF-8"?><en-export><note><title>N</title><content><![CDATA[<en-note><div>before</div><en-codeblock><div>old code</div></en-codeblock><div style="--en-codeblock:true;box-sizing: border-box;"><div>line 1</div><div>line &lt;2&gt;</div></div><div>after</div></en-note>]]></content></note></en-export>`;
    const { s } = load({ "Book.enex": enex }, ["Book.enex"]);
    expect(outline(s, "b:" + named(s, "N").id)).toEqual(["text: before", "code: old code", "code: line 1\nline <2>", "text: after"]);
  });
});

describe("Joplin (JEX)", () => {
  const id = (c: string) => c.repeat(32);
  const item = (title: string, body: string, meta: Record<string, string | number>) => `${title}\n\n${body}${body ? "\n\n" : ""}${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  const jex = tar({
    [`${id("a")}.md`]: item("Work", "", { id: id("a"), parent_id: "", type_: 2 }),
    [`${id("b")}.md`]: item("Sub", "", { id: id("b"), parent_id: id("a"), type_: 2 }),
    [`${id("c")}.md`]: item("Meeting: notes?", `![pic](:/${id("e")})\n\nSee [other](:/${id("d")}).`, { id: id("c"), parent_id: id("a"), type_: 1 }),
    [`${id("d")}.md`]: item("Other", "Body of other", { id: id("d"), parent_id: id("b"), type_: 1 }),
    [`${id("9")}.md`]: item("Other", "Same title", { id: id("9"), parent_id: id("b"), type_: 1 }),
    [`${id("e")}.md`]: item("photo.png", "", { id: id("e"), mime: "image/png", file_extension: "png", type_: 4 }),
    [`${id("f")}.md`]: item("urgent", "", { id: id("f"), type_: 5 }),
    [`${id("1")}.md`]: item("", "", { id: id("1"), note_id: id("c"), tag_id: id("f"), type_: 6 }),
    [`resources/${id("e")}.png`]: "PNG",
  });
  it("tar lesen", () => {
    expect(isTar(jex)).toBe(true);
    expect(isTar(enc.encode("not a tar"))).toBe(false);
    expect(extractTar(jex)!.readText(`resources/${id("e")}.png`)).toBe("PNG");
  });
  it("Notizbücher → Seiten, Dateien und Links zwischen Notizen, gleiche Titel bleiben getrennt", () => {
    const { s, r } = load({ "backup.jex": jex }, ["backup.jex"]);
    expect(r.warnings.join(" ")).toContain("Joplin: 3 notes in 2 notebooks");
    expect(outline(s, "w")).toEqual([
      "page: backup", "  page: Work", "    page: Sub", "      page: Other", "        text: Body of other", "      page: Other", "        text: Same title",
      "    page: Meeting: notes?", "      text: Tags: #urgent", "      image: ", "      text: See other.",
    ]);
    const meeting = kids(s, "b:" + named(s, "Meeting: notes?").id);
    expect(meeting[1]!.props?.asset?.name).toBe("photo.png");
    const other = [...s.blocks.values()].find((b) => b.type === "page" && plainText(b.text) === "Other" && titles(s, "b:" + b.id)[0] === "Body of other")!;
    expect(JSON.stringify(meeting[2]!.text)).toContain(other.id);
    expect(r.assets).toBe(1);
  });
});

describe("Roam Research (JSON)", () => {
  it("Seiten mit Blöcken, Links, Aufgaben, Block-Verweise", () => {
    const graph = [
      { title: "November 18th, 2026", children: [
        { string: "{{[[TODO]]}} Call [[Anna Smith]] about #[[Project X]] and #idea and #nopage", uid: "abcDEF123", children: [{ string: "^^important^^ and __italic__", uid: "abcDEF124" }] },
        { string: "{{[[DONE]]}} done thing", uid: "abcDEF125" },
        { string: "See ((abcDEF124))", uid: "abcDEF126" },
        { string: "A heading", heading: 2, uid: "h1" },
      ] },
      { title: "Anna Smith", children: [{ string: "Engineer", uid: "r1" }] },
      { title: "Project X" }, { title: "idea" }, { title: "ns/child" },
    ];
    const { s, r } = load({ "graph.json": JSON.stringify(graph) }, ["graph.json"]);
    expect(r.warnings.join(" ")).toContain("Roam Research graph “graph”: 5 pages");
    expect(s.databases.size).toBe(0); // vorher: eine „Datenbank“ aus JSON-Text
    expect(titles(s, "b:" + r.rootIDs[0]!).sort()).toEqual(["Anna Smith", "November 18th, 2026", "Project X", "idea", "ns/child"]);
    const day = kids(s, "b:" + named(s, "November 18th, 2026").id);
    expect(day.map((b) => [b.type, plainText(b.text)])).toEqual([
      ["todo", "Call Anna Smith about Project X and idea and #nopage"], ["todo", "done thing"], ["bulletedList", "See important and italic"], ["heading2", "A heading"],
    ]);
    const first = JSON.stringify(day[0]!.text);
    for (const t of ["Anna Smith", "Project X", "idea"]) expect(first).toContain(named(s, t).id);
    expect(day[1]!.props?.checked).toBe(true);
  });
  it("gewöhnliche JSON-Tabellen bleiben eine Datenbank", () => {
    const { s } = load({ "people.json": JSON.stringify([{ title: "Ada", email: "ada@example.com" }, { title: "Bob", email: "bob@example.com" }]) }, ["people.json"]);
    expect(s.databases.size).toBe(1);
  });
});

describe("Google Keep, Simplenote, Standard Notes", () => {
  it("Keep (Takeout, Ordnername übersetzt): Notizen als Datenbank, Listen als Aufgaben, Text bleibt Text", () => {
    const zip = zipSync({
      "Takeout/Notizen/Note one.json": enc.encode(JSON.stringify({ title: "Note one", textContent: "body *not italic*\n# not a heading", isPinned: true, isArchived: false, isTrashed: false, labels: [{ name: "Home" }], attachments: [{ filePath: "pic.jpeg", mimetype: "image/jpeg" }], userEditedTimestampUsec: 1700000000000000, createdTimestampUsec: 1700000000000000 })),
      "Takeout/Notizen/Note one.html": enc.encode("<html><body>ignored</body></html>"),
      "Takeout/Notizen/pic.jpg": enc.encode("JPG"),
      "Takeout/Notizen/List.json": enc.encode(JSON.stringify({ title: "", listContent: [{ text: "milk", isChecked: true }, { text: "eggs", isChecked: false }], isTrashed: false, userEditedTimestampUsec: 1600000000000000 })),
      "Takeout/Notizen/Old.json": enc.encode(JSON.stringify({ title: "Old", textContent: "x", isTrashed: true, userEditedTimestampUsec: 1 })),
      "Takeout/archive_browser.html": enc.encode("<html></html>"),
    });
    const { s, r } = load({ "takeout.zip": zip }, ["takeout.zip"]);
    expect(r.warnings.join(" ")).toContain("Google Keep: 2 notes (1 in the trash left out)");
    const db = dbNamed(s, "Google Keep");
    expect(db.properties.map((p) => [p.name, p.type])).toEqual([["Note", "title"], ["Labels", "multiSelect"], ["Created", "date"], ["Edited", "date"], ["Pinned", "checkbox"], ["Archived", "checkbox"]]);
    const rows = kids(s, "d:" + db.id);
    expect(rows.map((b) => plainText(b.text))).toEqual(["Note one", "Untitled"]);
    expect(outline(s, "b:" + rows[0]!.id)).toEqual(["image: ", "text: body *not italic*", "text: # not a heading"]);
    expect(kids(s, "b:" + rows[1]!.id).map((b) => [b.type, b.props?.checked, plainText(b.text)])).toEqual([["todo", true, "milk"], ["todo", false, "eggs"]]);
    expect(value(s, "Google Keep", rows[0]!, "Pinned")).toEqual({ checkbox: { _0: true } });
    expect(r.assets).toBe(1);
  });

  it("Simplenote: erste Zeile ist der Titel, Tags, Papierkorb bleibt draußen, die .txt-Kopien zählen nicht doppelt", () => {
    const zip = zipSync({
      "source/notes.json": enc.encode(JSON.stringify({ activeNotes: [{ id: "1", content: "Groceries\n- milk\n# not heading", creationDate: "2026-01-01T10:00:00.000Z", lastModified: "2026-01-02T10:00:00.000Z", tags: ["home"], pinned: true }, { id: "2", content: "# MD note\n\n**bold**", markdown: true }], trashedNotes: [{ id: "3", content: "x" }] })),
      "Groceries.txt": enc.encode("Groceries\n- milk"),
    });
    const { s, r } = load({ "notes.zip": zip }, ["notes.zip"]);
    expect(r.pages).toBe(2);
    const rows = kids(s, "d:" + dbNamed(s, "Simplenote").id);
    expect(rows.map((b) => plainText(b.text))).toEqual(["Groceries", "MD note"]);
    expect(outline(s, "b:" + rows[0]!.id)).toEqual(["bulletedList: milk", "text: # not heading"]);
    expect(prop(s, "Simplenote", "Tags").options?.map((o) => o.name)).toEqual(["home"]);
  });

  it("Standard Notes: entschlüsselte Sicherung mit Tags; verschlüsselte Notizen werden gemeldet", () => {
    const backup = { version: "004", items: [
      { uuid: "n1", content_type: "Note", created_at: "2026-01-01T10:00:00.000Z", updated_at: "2026-01-02T10:00:00.000Z", content: { title: "Idea", text: "Some **md** text" } },
      { uuid: "n2", content_type: "Note", content: "004:abcdef" },
      { uuid: "t1", content_type: "Tag", content: { title: "work", references: [{ uuid: "n1", content_type: "Note" }] } },
    ] };
    const { s, r } = load({ "Standard Notes Backup and Import File.txt": JSON.stringify(backup) }, ["Standard Notes Backup and Import File.txt"]);
    // eine einzelne .txt geht den gewöhnlichen Weg; als ZIP (so kommt die Sicherung) wird sie erkannt
    expect(r.pages).toBe(1);
    const z = load({ "sn.zip": zipSync({ "Standard Notes Backup and Import File.txt": enc.encode(JSON.stringify(backup)) }) }, ["sn.zip"]);
    expect(z.r.warnings.join(" ")).toContain("1 are encrypted");
    expect(kids(z.s, "d:" + dbNamed(z.s, "Standard Notes").id).map((b) => plainText(b.text))).toEqual(["Idea"]);
    expect(prop(z.s, "Standard Notes", "Tags").options?.map((o) => o.name)).toEqual(["work"]);
    void s;
  });
});

describe("ChatGPT und Claude", () => {
  it("ChatGPT: der sichtbare Zweig, ohne Werkzeugaufrufe und versteckte Nachrichten", () => {
    const msg = (role: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({ author: { role }, content: { content_type: "text", parts }, recipient: "all", ...extra });
    const mapping = {
      root: { id: "root", parent: null, children: ["sys"], message: null },
      sys: { id: "sys", parent: "root", children: ["u1"], message: msg("system", [""], { metadata: { is_visually_hidden_from_conversation: true } }) },
      u1: { id: "u1", parent: "sys", children: ["a-old", "tool"], message: msg("user", ["Hi"]) },
      "a-old": { id: "a-old", parent: "u1", children: [], message: msg("assistant", ["an answer the user regenerated"]) },
      tool: { id: "tool", parent: "u1", children: ["a1"], message: { author: { role: "assistant" }, content: { content_type: "code", text: "search()" }, recipient: "browser" } },
      a1: { id: "a1", parent: "tool", children: [], message: msg("assistant", ["Hello **there** \uE200cite\uE202turn0search1\uE201"]) },
    };
    const zip = zipSync({
      "conversations.json": enc.encode(JSON.stringify([{ title: "Chat 1", create_time: 1700000000, update_time: 1700000100, default_model_slug: "gpt-5", mapping, current_node: "a1" }, { title: "Empty", mapping: { r: { id: "r", parent: null, children: [], message: null } }, current_node: "r" }])),
      "chat.html": enc.encode("<html><body><script>var jsonData = []</script></body></html>"),
      "user.json": enc.encode("{}"),
    });
    const { s, r } = load({ "chatgpt.zip": zip }, ["chatgpt.zip"]);
    expect(r.warnings.join(" ")).toContain("1 ChatGPT chats");
    const rows = kids(s, "d:" + dbNamed(s, "ChatGPT").id);
    expect(rows.map((b) => plainText(b.text))).toEqual(["Chat 1"]);
    expect(outline(s, "b:" + rows[0]!.id)).toEqual(["text: You", "text: Hi", "divider: ", "text: ChatGPT", "text: Hello there"]);
    expect(prop(s, "ChatGPT", "Model").options?.map((o) => o.name)).toEqual(["gpt-5"]);
    expect(value(s, "ChatGPT", rows[0]!, "Created")!.date).toBeDefined();
    expect([...s.blocks.values()].some((b) => plainText(b.text) === "chat")).toBe(false); // chat.html ist keine Seite
  });

  it("Claude: Unterhaltungen als Datenbank, Antworten als Markdown, Projekt-Dokumente als Seiten", () => {
    const zip = zipSync({
      "conversations.json": enc.encode(JSON.stringify([
        { uuid: "1", name: "Plan trip", created_at: "2026-10-01T10:00:00.000000Z", updated_at: "2026-10-01T11:00:00.000000Z", chat_messages: [
          { sender: "human", text: "Where to?", content: [{ type: "text", text: "Where to?" }], attachments: [{ file_name: "map.pdf" }] },
          { sender: "assistant", text: "", content: [{ type: "tool_use", name: "web_search", input: {} }, { type: "text", text: "## Options\n\n1. Rome\n2. Oslo" }] },
        ] },
        { uuid: "2", name: "", chat_messages: [] },
      ])),
      "projects.json": enc.encode(JSON.stringify([{ uuid: "p", name: "Based", docs: [{ filename: "spec.md", content: "# Spec\n\ntext" }] }])),
      "users.json": enc.encode("[]"),
    });
    const { s, r } = load({ "data.zip": zip }, ["data.zip"]);
    expect(r.warnings.join(" ")).toContain("1 Claude chats, 1 project documents");
    const rows = kids(s, "d:" + dbNamed(s, "Claude").id);
    expect(outline(s, "b:" + rows[0]!.id)).toEqual(["text: You", "text: Where to?", "text: Attached: map.pdf", "divider: ", "text: Claude", "heading2: Options", "numberedList: Rome", "numberedList: Oslo"]);
    expect(outline(s, "b:" + named(s, "Claude projects").id)).toEqual(["page: Based", "  page: Spec", "    text: text"]);
  });
});

describe("BSD-611: Notion „Markdown & CSV“ ein zweites Mal importiert", () => {
  const csv = "Name,Status,Points\nWrite report,In progress,3\nNo file row,Done,5\n";
  const md = {
    [`Home ${H}.md`]: `# Home\n\nIntro paragraph\n\n[Tasks](Home%20${H}/Tasks%20${T}.csv)\n\n[Sub](Home%20${H}/Sub%20${S}.md)\n`,
    [`Home ${H}/Sub ${S}.md`]: "# Sub\n\nSub body\n",
    [`Home ${H}/Tasks ${T}.csv`]: csv,
    [`Home ${H}/Tasks ${T}_all.csv`]: csv,
    [`Home ${H}/Tasks ${T}/Write report ${R1}.md`]: "# Write report\n\nStatus: In progress\n\nRow body\n",
  };
  const zipOf = (m: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, enc.encode(v)])));
  const whole = zipOf(md);
  const part = zipOf(md); // dasselbe Export als Teil-Archiv („…-Part-1.zip“)
  const live = (s: WorkspaceStore) => [...s.blocks.values()].filter((b) => b.trashedAt === undefined);
  const counts = (s: WorkspaceStore) => ({
    blocks: live(s).length,
    pages: live(s).filter((b) => b.type === "page").length,
    databases: s.databases.size,
    rows: live(s).filter((b) => b.parent.startsWith("d:")).length,
  });
  const run = (s: WorkspaceStore, m: Record<string, Uint8Array>, path: string) => importNotionItems(s, [{ files: files(m), path }], { assets: new MemoryAssetSink() });
  const fresh = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });

  it("zweimal (ZIP, Teil-Archiv, ZIP): gleiche Zahl Seiten, Datenbanken und Zeilen, Meldung „Updated …“; IDs wie im HTML-Weg", () => {
    const s = fresh();
    run(s, { "Export-x.zip": whole }, "Export-x.zip");
    const first = counts(s);
    expect(first).toEqual({ blocks: 8, pages: 4, databases: 1, rows: 2 });
    // Seiten tragen die Notion-ID, die Datenbank die abgeleitete ID des HTML-Wegs.
    expect(named(s, "Home").id).toBe(dash(H));
    expect(named(s, "Write report").id).toBe(dash(R1));
    expect(s.blocks.get(dash(T))?.type).toBe("databaseInline");
    expect(dbNamed(s, "Tasks").id).toBe(derivedID(dash(T), "database"));
    expect(live(s).every((b) => typeof (b as Record<string, unknown>).importFingerprint === "string")).toBe(true);
    const r2 = run(s, { "Export-x-Part-1.zip": part }, "Export-x-Part-1.zip");
    expect(counts(s)).toEqual(first);
    expect(r2.warnings.find((w) => w.startsWith("Updated"))).toMatch(/^Updated \d+ existing blocks/);
    expect(r2.pages).toBe(3); expect(r2.rows).toBe(2); expect(r2.databases).toBe(1);
    run(s, { "Export-x.zip": whole }, "Export-x.zip");
    expect(counts(s)).toEqual(first);
    expect(outline(s, "w")).toEqual(["page: Home", "  text: Intro paragraph", "  databaseInline: ", "  page: Sub", "    text: Sub body"]);
  });

  it("in Based Geändertes bleibt: Zeilenwert, Absatz und hinzugefügter Block", () => {
    const s = fresh();
    run(s, { "Export-x.zip": whole }, "Export-x.zip");
    const db = dbNamed(s, "Tasks");
    const points = db.properties.find((p) => p.name === "Points")!.id;
    const row = named(s, "No file row");
    const intro = kids(s, "b:" + dash(H)).find((b) => plainText(b.text) === "Intro paragraph")!;
    s.transact("edit", (tx) => {
      tx.update(row.id, (b) => { b.values = { ...b.values, [points]: { number: { _0: 42 } } as never }; });
      tx.update(intro.id, (b) => { b.text = "Intro edited in Based"; });
    });
    s.transact("add", (tx) => tx.put({ kind: "block", data: { id: "local-1", type: "text", parent: "b:" + dash(S), sk: "zz", text: "added in Based", createdAt: 1, updatedAt: 1 } as Block }));
    const before = counts(s);
    const r = run(s, { "Export-x.zip": whole }, "Export-x.zip");
    expect(counts(s)).toEqual(before);
    expect((s.blocks.get(row.id)!.values?.[points] as { number: { _0: number } }).number._0).toBe(42);
    expect(plainText(s.blocks.get(intro.id)!.text)).toBe("Intro edited in Based");
    expect(titles(s, "b:" + dash(S))).toEqual(["Sub body", "added in Based"]);
    expect(r.keptLocalChanges).toBeGreaterThan(0);
  });

  it("derselbe Export erst als HTML, dann als Markdown & CSV: aktualisiert statt doppelt", () => {
    const page = (id: string, title: string, body: string) => `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>${title}</title></head><body><article id="${dash(id)}" class="page sans"><header><h1 class="page-title">${title}</h1></header><div class="page-body">${body}</div></article></body></html>`;
    const html = zipSync({
      [`Home ${H}.html`]: enc.encode(page(H, "Home", `<p>Intro paragraph</p><div id="${dash(T)}" class="collection-content"><h4 class="collection-title">Tasks</h4><table class="collection-content"><thead><tr><th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th><th><span class="icon property-icon"><svg class="typesText"></svg></span>Status</th><th><span class="icon property-icon"><svg class="typesNumber"></svg></span>Points</th></tr></thead><tbody><tr id="${dash(R1)}"><td class="cell-title"><a href="Home%20${H}/Tasks%20${T}/Write%20report%20${R1}.html">Write report</a></td><td>In progress</td><td>3</td></tr><tr><td class="cell-title">No file row</td><td>Done</td><td>5</td></tr></tbody></table></div><figure class="link-to-page"><a href="Home%20${H}/Sub%20${S}.html">Sub</a></figure>`)),
      [`Home ${H}/Sub ${S}.html`]: enc.encode(page(S, "Sub", "<p>Sub body</p>")),
      [`Home ${H}/Tasks ${T}/Write report ${R1}.html`]: enc.encode(page(R1, "Write report", "<p>Row body</p>")),
    });
    const s = fresh();
    run(s, { "Export-h.zip": html }, "Export-h.zip");
    const fromHTML = counts(s);
    const dbID = dbNamed(s, "Tasks").id;
    const r = run(s, { "Export-x.zip": whole }, "Export-x.zip");
    // Seiten, Datenbank und Zeilen sind dieselben Records (gleiche IDs); nur die Inhaltsblöcke werden ersetzt.
    expect(counts(s)).toEqual(fromHTML);
    expect(s.databases.size).toBe(1);
    expect(dbNamed(s, "Tasks").id).toBe(dbID);
    expect(r.warnings.some((w) => w.startsWith("Updated"))).toBe(true);
    expect(titles(s, "b:" + dash(S))).toEqual(["Sub body"]);
  });

  it("gewöhnliche Markdown-Ordner bleiben wie bisher (kein Reimport-Schutz, keine Fingerabdrücke)", () => {
    const s = fresh();
    const plain = { "Notes/A.md": "# A\n\ntext\n", "Notes/B.md": "# B\n" };
    run(s, plain as never, "Notes");
    expect(live(s).some((b) => "importFingerprint" in b)).toBe(false);
    const n = live(s).length;
    const sf = files(plain);
    importNotionItems(s, [{ files: sf, path: "Notes" }]);
    expect(live(s).length).toBe(2 * n);
  });
});
