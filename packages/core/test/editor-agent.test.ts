// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Agent-Parität 2/7: der Seiten-Editor als Text – Umriss lesen (`blockOutline`), per Skript ändern (`runBlockScript`).
import { describe, expect, it, vi } from "vitest";
import {
  blockHandles, blockOutline, BLOCK_SCRIPT_HELP, createPage, MarkdownImporter, MemoryPersistence, plainText, putMarkdownBlocks, runBlockScript, sortKeys, WorkspaceStore,
  type Block, type BoardFileInfo,
} from "../src/index.js";

const HASH = "e".repeat(64);
const FILES: Record<string, BoardFileInfo> = {
  [`based-asset:${HASH}`]: { ref: `based-asset:${HASH}`, name: "beach.jpg", mime: "image/jpeg", size: 2048, width: 1200, height: 800 },
  ["based-asset:" + "f".repeat(64)]: { ref: "based-asset:" + "f".repeat(64), name: "report.pdf", mime: "application/pdf", size: 9000 },
};

function setup(markdown: string) {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence([]), node: "n" });
  const page = createPage(store, { title: "Launch" });
  const importer = new MarkdownImporter({ resolveLink: (t) => (store.blocks.has(t.replace("based://page/", "")) ? t.replace("based://page/", "") : undefined) });
  const blocks = importer.parse(markdown);
  if (blocks.length) store.transact("seed", (tx) => putMarkdownBlocks(store, tx, blocks, "b:" + page, sortKeys(store, "b:" + page, { kind: "end" }, blocks.length)));
  store.clearUndoHistory();
  const read = (opts = {}) => blockOutline(store, page, opts);
  /** Kennung des Blocks, dessen Umriss-Zeile `needle` enthält. */
  const h = (needle: string) => {
    const line = read().split("\n").find((l) => l.includes(needle));
    if (!line) throw new Error(`no line with ${needle} in\n${read()}`);
    return line.trim().split(" ")[0]!;
  };
  const run = (script: string) => runBlockScript(store, page, script, { importer, files: (ref) => FILES[ref], linkPreview: (url) => (url === "https://example.com/article" ? { title: "An article", summary: "About things" } : undefined) });
  const ok = (script: string) => {
    const r = run(script);
    expect(r.errors).toEqual([]);
    return r;
  };
  /** Umriss ohne Kennungen (die sind zufällig). */
  const shape = () => read().split("\n").map((l) => l.replace(/^(\s*)[0-9a-f]{4,}\s/, "$1")).join("\n");
  const top = () => store.children("b:" + page).map((id) => store.blocks.get(id)!);
  return { store, page, read, h, run, ok, shape, top };
}

const DOC = "## Plan\n\nFirst paragraph with **bold**.\n\n- one\n- two\n    - nested\n\n- [ ] task\n\nLast paragraph";

describe("blockOutline", () => {
  it("eine Zeile je Block: Kennung, Art, Text; Einrückung zeigt die Verschachtelung", () => {
    const { shape, read, store, page } = setup(DOC);
    expect(shape()).toBe(['h2 "Plan"', 'text "First paragraph with **bold**."', 'bullet "one"', 'bullet "two"', '  bullet "nested"', 'todo [ ] "task"', 'text "Last paragraph"'].join("\n"));
    // Kennungen: kurz, eindeutig, Anfang der ID
    const handles = blockHandles(store, page);
    expect(new Set(handles.values()).size).toBe(handles.size);
    for (const [id, handle] of handles) {
      expect(id.toLowerCase().startsWith(handle)).toBe(true);
      expect(handle.length).toBeLessThanOrEqual(8);
    }
    expect(read().length, "knapp: die ganze Seite in rund fünfzig Token").toBeLessThan(260);
  });

  it("lange Seiten gehen seitenweise, lange Texte werden gekürzt, die leere Seite sagt es", () => {
    const { read } = setup(Array.from({ length: 30 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n\n" + "long ".repeat(100));
    const first = read({ limit: 10 }).split("\n");
    expect(first).toHaveLength(11);
    expect(first[10]).toBe("… 21 more blocks (offset: 10)");
    expect(read({ offset: 30 })).toMatch(/text "long long .*… \(\+\d+\)"$/);
    expect(read({ offset: 99 })).toBe("(no blocks from offset 99; the page has 31)");
    expect(setup("").read()).toBe("(empty page)");
  });

  it("eine normale Seite bleibt unter 2 000 Zeichen", () => {
    const { read } = setup("# Weekly review\n\n" + Array.from({ length: 12 }, (_, i) => `## Topic ${i}\n\nSome notes about topic ${i} with a [link](https://example.com).\n\n- point a\n- point b`).join("\n\n"));
    expect(read().length).toBeLessThan(2000);
  });
});

describe("runBlockScript – anlegen", () => {
  it("an einer Stelle einfügen; ohne Ortsangabe geht es hinter dem vorigen Block weiter", () => {
    const { ok, h, shape } = setup(DOC);
    const r = ok(`h2 s: Summary {after=${h("First paragraph")}}\ntext: It ships *Friday*.\nbullet: last one {before=${h('"Last')}}\ntext: at the end? no – after the bullet`);
    expect(r).toMatchObject({ added: 4, changed: 0, moved: 0, removed: 0 });
    expect(shape().split("\n")).toEqual([
      'h2 "Plan"', 'text "First paragraph with **bold**."', 'h2 "Summary"', 'text "It ships *Friday*."', 'bullet "one"', 'bullet "two"', '  bullet "nested"', 'todo [ ] "task"',
      'bullet "last one"', 'text "at the end? no – after the bullet"', 'text "Last paragraph"',
    ]);
  });

  it("ohne Anker: ans Ende der Seite; in= ist ein Abstecher und zieht die Schreibmarke nicht mit", () => {
    const { ok, shape } = setup("Intro");
    ok("toggle t: Details\ntext: hidden one {in=t}\ntext: hidden two {in=t}\ncallout c: **Note** {bg=blue icon=🚀}\ntext: after the callout");
    expect(shape().split("\n")).toEqual(['text "Intro"', 'toggle "Details"', '  text "hidden one"', '  text "hidden two"', 'callout "**Note**" {bg=blue icon=🚀}', 'text "after the callout"']);
  });

  it("alle Arten: Listen, To-do, Code, Trenner, Inhaltsverzeichnis, Gleichung, Bookmark, Tabelle, Unterseite, Datenbank, Board, Meeting", () => {
    const { ok, shape, store, page } = setup("");
    const r = ok([
      "h1: Title", "h3: Small {toggle}", "bullet: a", "number: b", "todo: c {checked}", "quote: d {color=gray}", "code: let x = {a: 1} {lang=ts wrap}", "code: plain {braces} {}",
      "divider", "toc", "equation: E = mc^2", "bookmark: https://example.com/a", "embed: https://www.youtube.com/watch?v=x",
      "table t: Name | Points\\nAda | 3\\nBob | 5", "page p: Child", "board b: Sketch", "database d: Tasks {view=board}", "meeting: Kickoff",
    ].join("\n"));
    expect(r.added).toBe(18);
    const lines = shape().split("\n");
    expect(lines.slice(0, 13)).toEqual([
      'h1 "Title"', 'h3 "Small" {toggle}', 'bullet "a"', 'number "b"', 'todo [x] "c"', 'quote "d" {color=gray}', 'code "let x = {a: 1}" {lang=typescript wrap}', 'code "plain {braces}"',
      "divider", "toc", 'equation "E = mc^2"', "bookmark https://example.com/a", "embed https://www.youtube.com/watch?v=x",
    ]);
    expect(lines.slice(13, 17)).toEqual(["table 3x2", "  | Name | Points |", "  | Ada | 3 |", "  | Bob | 5 |"]);
    expect(lines[17]).toMatch(/^page "Child" \(id: [0-9A-Fa-f-]{36}\)$/);
    expect(lines[18]).toMatch(/^page "Sketch" \(id: [0-9A-Fa-f-]{36}\) board$/);
    expect(lines[19]).toMatch(/^database "Tasks" \(id: [0-9a-f-]{36}\)$/);
    expect(lines[20]).toBe('meeting "Kickoff"');
    // die Datenbank gibt es wirklich, mit Board-Ansicht; ihre ID steht im Ergebnis
    const dbID = r.databases.get(r.names.get("d")!)!;
    expect(store.databases.get(dbID)?.properties.some((p) => p.type === "status")).toBe(true);
    // die Unterseite liegt in der Seite
    expect(store.blocks.get(r.names.get("p")!)).toMatchObject({ type: "page", parent: "b:" + page, text: "Child" });
  });

  it("md fügt beliebig viele Blöcke ein, auch verschachtelt", () => {
    const { ok, shape, h } = setup("Intro\n\nOutro");
    expect(ok(`md: ## Steps\\n\\n1. first\\n    - detail\\n2. second\\n\\n> [!NOTE] careful {after=${h("Intro")}}`).added).toBe(4);
    expect(shape().split("\n")).toEqual(['text "Intro"', 'h2 "Steps"', 'number "first"', '  bullet "detail"', 'number "second"', expect.stringMatching(/^callout "careful"/), 'text "Outro"']);
  });

  it("Bilder und Dateien: Datei-Adresse oder URL; `file` nimmt die Art aus der Datei", () => {
    const { ok, shape, store, run } = setup("Intro");
    const r = ok(`image i: based-asset:${HASH} {width=400 align=center caption="At the **beach**"}\nfile: based-asset:${"f".repeat(64)}\nfile: based-asset:${HASH}\nimage: https://example.com/p.png`);
    expect(shape().split("\n").slice(1)).toEqual([
      `image "beach.jpg" based-asset:${HASH} {width=400 align=center caption="At the **beach**"}`, `pdf "report.pdf" based-asset:${"f".repeat(64)}`, `image "beach.jpg" based-asset:${HASH}`, "image https://example.com/p.png",
    ]);
    // gespeichert wie beim Hochladen in der App: `asset` mit Name, Art, Größe
    expect(store.blocks.get(r.names.get("i")!)!.props).toMatchObject({ asset: { id: HASH, name: "beach.jpg", mime: "image/jpeg", size: 2048 }, width: 400, align: "center" });
    expect(run("image: based-asset:" + "0".repeat(64)).errors[0]).toContain("unknown file");
    expect(run("image: not a url").errors[0]).toContain("needs a file ref");
  });

  it("Erwähnungen: ein Link auf eine Seite wird eine Erwähnung und kommt als Link zurück", () => {
    const { ok, store, page, top } = setup("");
    const other = createPage(store, { title: "Roadmap" });
    ok(`text: See [Roadmap](based://page/${other}) for details`);
    expect((top()[0]!.text as { mention?: unknown }[]).some((r) => r.mention !== undefined)).toBe(true);
    expect(blockOutline(store, page, { pageLink: (id) => ({ title: "Roadmap", url: "based://page/" + id }) })).toContain(`[Roadmap](based://page/${other})`);
  });
});

describe("runBlockScript – ändern", () => {
  it("Text setzen (Formatierung aus Markdown), Farbe, Turn into, abhaken", () => {
    const { ok, h, shape, store } = setup(DOC);
    const one = h('"one"');
    const r = ok(`set ${one}: first, **edited**\nset ${one} {type=todo checked}\nset ${h('"two"')} {bg=yellow}\nset ${h("Plan")} {type=h1 toggle}\ncheck ${h("task")}\nset ${h('"Last')} {type=quote color=red}`);
    expect(r.changed).toBe(6);
    expect(shape().split("\n")).toEqual([
      'h1 "Plan" {toggle}', 'text "First paragraph with **bold**."', 'todo [x] "first, **edited**"', 'bullet "two" {bg=yellow}', '  bullet "nested"', 'todo [x] "task"', 'quote "Last paragraph" {color=red}',
    ]);
    // die ID bleibt beim Turn into (Links auf den Block bleiben gültig)
    expect([...blockHandles(store, [...store.blocks.values()].find((b) => b.type === "page")!.id).values()]).toContain(one);
    ok(`uncheck ${h("task")}\nset ${h('"two"')} {color=default}`);
    expect(shape()).toContain('todo [ ] "task"');
    expect(shape()).toContain('bullet "two"\n');
  });

  it("Turn into page: der Block wird zur Unterseite mit derselben ID", () => {
    const { ok, h, shape, store } = setup("Intro\n\nProject Atlas");
    const handle = h("Atlas");
    ok(`set ${handle} {type=page}`);
    expect(shape().split("\n")[1]).toMatch(/^page "Project Atlas" \(id: /);
    expect([...store.blocks.values()].filter((b) => b.type === "page")).toHaveLength(2);
  });

  it("verschieben: davor, danach, hinein (ans Ende), in eine andere Seite; einrücken und ausrücken", () => {
    const { ok, h, shape, store, run } = setup(DOC);
    ok(`move ${h('"Last')} {after=${h("Plan")}}\nmove ${h('"one"')} ${h("task")} {in=${h('"two"')}}`);
    expect(shape().split("\n")).toEqual(['h2 "Plan"', 'text "Last paragraph"', 'text "First paragraph with **bold**."', 'bullet "two"', '  bullet "nested"', '  bullet "one"', '  todo [ ] "task"']);
    ok(`outdent ${h('"one"')}\nmove ${h("task")} {before=${h("Plan")}}`);
    expect(shape().split("\n")).toEqual(['todo [ ] "task"', 'h2 "Plan"', 'text "Last paragraph"', 'text "First paragraph with **bold**."', 'bullet "two"', '  bullet "nested"', 'bullet "one"']);
    ok(`indent ${h('"one"')}`);
    expect(shape()).toContain('bullet "two"\n  bullet "nested"\n  bullet "one"');
    const other = createPage(store, { title: "Archive" });
    expect(ok(`move ${h('"Last')} ${h("First")} {page=${other}}`).moved).toBe(2);
    expect(store.children("b:" + other).map((id) => plainText(store.blocks.get(id)!.text))).toEqual(["Last paragraph", "First paragraph with bold."]);
    // in sich selbst geht nicht
    expect(run(`move ${h('"two"')} {in=${h("nested")}}`).errors[0]).toContain("nothing was moved");
    expect(run(`move ${h('"two"')}`).errors[0]).toContain("move needs a place");
  });

  it("Spalten: nebeneinander stellen (left/right), Spaltenliste anlegen und füllen, Breiten, wieder auflösen", () => {
    const { ok, h, shape, read } = setup("Text about the picture\n\n![pic](https://example.com/p.png)\n\nThird paragraph\n\nOutro");
    // Abnahme: „verschieb den dritten Absatz in eine zweite Spalte neben das Bild“
    ok(`move ${h("Third")} {right=${h("image")}}`);
    expect(shape().split("\n")).toEqual(['text "Text about the picture"', "cols 2", "  col", '    image https://example.com/p.png {caption="pic"}', "  col", '    text "Third paragraph"', 'text "Outro"']);
    // eine dritte Spalte daneben, direkt beim Anlegen
    ok(`callout: Side note {right=${h("Third")}}`);
    expect(shape()).toContain("cols 3");
    const list = h("cols");
    ok(`set ${list}.1 {ratio=0.5}\ntext: under the picture {in=${list}.1}`);
    expect(read()).toContain("col {ratio=0.5}");
    expect(shape()).toContain('    image https://example.com/p.png {caption="pic"}\n    text "under the picture"');
    ok(`uncols ${list}`);
    expect(shape().split("\n")).toEqual(['text "Text about the picture"', 'image https://example.com/p.png {caption="pic"}', 'text "under the picture"', 'text "Third paragraph"', 'callout "Side note"', 'text "Outro"']);
    // neue Liste mit drei Spalten; eine leer gelassene Spalte bekommt einen leeren Textblock (sonst nicht anklickbar)
    ok("cols k: 3\ntext: left {in=k.1}\ntext: right {in=k.3}");
    expect(shape().split("\n").slice(-7)).toEqual(["cols 3", "  col", '    text "left"', "  col", '    text ""', "  col", '    text "right"']);
  });

  it("duplizieren und löschen; eine Unterseite wandert beim Löschen in den Papierkorb", () => {
    const { ok, h, shape, store } = setup(DOC);
    expect(ok(`dup ${h('"two"')}`).added).toBe(1);
    expect(shape().split("\n").filter((l) => l.includes('"two"'))).toHaveLength(2);
    expect(shape().split("\n").filter((l) => l.includes('"nested"')), "Kinder gehen mit").toHaveLength(2);
    expect(ok(`del ${h("Plan")} ${h("task")}`).removed).toBe(2);
    expect(shape()).not.toContain("Plan");
    const r = ok("page p: Child");
    const child = r.names.get("p")!;
    ok(`del ${child}`);
    expect(store.blocks.get(child)?.trashedAt).toBeDefined();
  });

  it("Tabellen: Zelle setzen, Zeilen und Spalten anfügen und löschen", () => {
    const { ok, h, shape, run } = setup("| a | b |\n|---|---|\n| 1 | 2 |");
    const t = h("table");
    ok(`cell ${t} 2,1: changed\nrow ${t} add\ncol ${t} add\ncell ${t} 3,3: corner`);
    expect(shape().split("\n")).toEqual(["table 3x3", "  | a | b |  |", "  | changed | 2 |  |", "  |  |  | corner |"]);
    ok(`row ${t} del 1\ncol ${t} del 2\nset ${t} {header=false}`);
    expect(shape().split("\n")).toEqual(["table 2x2 {header=false}", "  | changed |  |", "  |  | corner |"]);
    expect(run(`cell ${t} 9,9: x`).errors[0]).toContain("the table has 2 rows and 2 columns");
  });

  it("Code: Sprache, Umbruch, Anzeige des Ergebnisses bei HTML", () => {
    const { ok, h, shape } = setup("```html\n<b>hi</b>\n```");
    ok(`set ${h("code")} {show=result}`);
    expect(shape()).toBe('code "<b>hi</b>" {lang=html show=result}');
    ok(`set ${h("code")}: <i>new</i>\\n<p>two</p> {show=both wrap}`);
    expect(shape()).toBe('code "<i>new</i>" (2 lines) {lang=html wrap show=both}');
  });
});

describe("runBlockScript – Linked view, Synced Block, Button, Datum, Bookmark-Vorschau", () => {
  it("linked: eine vorhandene Datenbank an einer Stelle zeigen, mit eigener Ansicht", () => {
    const { ok, run, shape, store, h } = setup("Intro\n\nOutro");
    const made = ok("database d: Tasks");
    const dbID = made.databases.get(made.names.get("d")!)!;
    const r = ok(`linked l: ${dbID} {view=board after=${h("Intro")}}`);
    expect(shape().split("\n")).toEqual(['text "Intro"', `database "Tasks" (id: ${dbID})`, 'text "Outro"', `database "Tasks" (id: ${dbID})`]);
    const block = store.blocks.get(r.names.get("l")!)!;
    expect(block.props?.databaseID).toBe(dbID);
    expect(store.views.get(block.props!.viewIDs![0]!)).toMatchObject({ type: "board", databaseID: dbID });
    expect(store.databases.size, "keine zweite Datenbank").toBe(1);
    expect(run("linked: nope").errors[0]).toContain("needs the id of a database");
  });

  it("sync macht aus Blöcken ein Original; synced setzt auf einer anderen Seite eine Kopie; unsync löst sie", () => {
    const { ok, run, shape, store, h, read } = setup("Shared one\n\nShared two\n\nOther");
    const r = ok(`sync ${h("Shared one")} ${h("Shared two")}`);
    expect(r.synced).toHaveLength(1);
    const original = r.synced[0]!;
    expect(shape().split("\n")).toEqual([`synced (id: ${original})`, '  text "Shared one"', '  text "Shared two"', 'text "Other"']);
    // im Original weiterschreiben
    ok(`text: Shared three {in=${original}}`);
    expect(store.children("b:" + original)).toHaveLength(3);
    // dieselbe Seite darf es nicht zweimal zeigen
    expect(run(`synced: ${original}`).errors[0]).toContain("already shows that synced block");
    const other = createPage(store, { title: "Elsewhere" });
    const importer = new MarkdownImporter();
    const copy = runBlockScript(store, other, `synced c: ${original}`, { importer });
    expect(copy.errors).toEqual([]);
    const copyID = copy.names.get("c")!;
    expect(store.blocks.get(copyID)).toMatchObject({ type: "syncedBlock", props: { syncSource: original } });
    expect(blockOutline(store, other).replace(/^[0-9a-f]+ /, "")).toBe(`synced copy of ${original}`);
    // in eine Kopie schreibt man nicht hinein
    expect(runBlockScript(store, other, `text: x {in=${copyID}}`, { importer }).errors[0]).toContain("change the original");
    expect(runBlockScript(store, other, `unsync ${copyID}`, { importer }).errors).toEqual([]);
    expect(store.blocks.get(copyID)!.props?.syncSource).toBeUndefined();
    expect(store.children("b:" + copyID).map((k) => plainText(store.blocks.get(k)!.text))).toEqual(["Shared one", "Shared two", "Shared three"]);
    expect(read()).toContain("Shared three");
  });

  it("button: Beschriftung und Schritte in der Reihenfolge der Attribute; insert nimmt die Blöcke im Button als Vorlage", () => {
    const { ok, run, shape, store } = setup("");
    const other = createPage(store, { title: "Target" });
    const db = ok("database d: Tasks");
    const dbID = db.databases.get(db.names.get("d")!)!;
    const r = ok(`button b: New task {add=${dbID} confirm="Open it?" open=${other} url=https://example.com/a}\nbutton t: Add checklist {insert}\ntodo: first step {in=t}\ntodo: second step {in=t}`);
    expect(store.blocks.get(r.names.get("b")!)!.props).toMatchObject({
      buttonLabel: "New task",
      buttonActions: [{ kind: "addPage", targetID: dbID }, { kind: "confirm", message: "Open it?" }, { kind: "openPage", targetID: other }, { kind: "openURL", url: "https://example.com/a" }],
    });
    const lines = shape().split("\n").slice(1);
    expect(lines[0]).toBe(`button "New task" {add=${dbID} confirm="Open it?" open=${other} url=https://example.com/a}`);
    expect(lines.slice(1)).toEqual(['button "Add checklist" {insert}', '  todo [ ] "first step"', '  todo [ ] "second step"']);
    ok(`set ${r.names.get("b")!}: Add task`);
    expect(store.blocks.get(r.names.get("b")!)!.props?.buttonLabel).toBe("Add task");
    expect(run("button: X {add=nope}").errors[0]).toContain("add= needs the id of a database");
    expect(run("button: X {colour=red}").errors[0]).toContain("button has no attribute colour");
  });

  it("Datum im Text wird eine Datums-Erwähnung – Tag, Uhrzeit, Bereich, Erinnerung; in Code und Links nicht", () => {
    const { ok, top, shape } = setup("");
    ok("text: Due @2026-11-20, call @2026-11-21 14:30 (remind), trip @2026-12-01 → 2026-12-05.\ncode: at @2026-11-20\ntext: mail me@2026 or `@2026-11-20`\nmd: - [ ] pay rent @2026-12-01");
    const runs = top()[0]!.text as { t: string; mention?: { date?: { _0: { start: number; end?: number; includeTime: boolean; remind?: boolean } } } }[];
    const dates = runs.filter((r) => r.mention?.date).map((r) => r.mention!.date!._0);
    expect(dates).toHaveLength(3);
    expect(dates[0]).toMatchObject({ includeTime: false });
    expect(dates[0]!.end).toBeUndefined();
    expect(dates[1]).toMatchObject({ includeTime: true, remind: true });
    expect(dates[2]!.end! - dates[2]!.start).toBe(4 * 86400);
    // so kommt es auch wieder zurück
    expect(shape().split("\n")[0]).toBe('text "Due @2026-11-20, call @2026-11-21 14:30, trip @2026-12-01 → 2026-12-05."');
    expect(top()[1]!.text).toBe("at @2026-11-20");
    expect((top()[2]!.text as { mention?: unknown }[]).some((r) => r.mention !== undefined)).toBe(false);
    expect((top()[3]!.text as { mention?: unknown }[]).some((r) => r.mention !== undefined), "auch in md").toBe(true);
  });

  it("Bookmark: hat der Host die Vorschau geholt, zeigt das neue Bookmark gleich die Karte", () => {
    const { ok, top } = setup("");
    ok("bookmark: https://example.com/article\nbookmark: https://example.com/unknown");
    expect(top()[0]!.props).toEqual({ url: "https://example.com/article", bookmark: { title: "An article", summary: "About things" } });
    expect(top()[1]!.props).toEqual({ url: "https://example.com/unknown" });
    ok(`set ${top()[0]!.id}: https://example.com/unknown`);
    expect(top()[0]!.props, "neuer Link, alte Karte weg").toEqual({ url: "https://example.com/unknown" });
  });
});

describe("runBlockScript – verlässlich", () => {
  it("ein Aufruf ist ein Undo-Schritt und ein Change, egal wie viele Zeilen", () => {
    const { ok, h, read, store } = setup(DOC);
    const before = read();
    const changes: string[] = [];
    store.observe((c) => changes.push(c.name ?? ""));
    ok(`h2: New {after=${h("Plan")}}\nmove ${h("task")} {right=${h('"Last')}}\nset ${h('"one"')} {type=todo bg=green}\ndel ${h("nested")}\ncols: 2\ndatabase: Tasks`);
    expect(changes).toEqual(["Agent: edit blocks"]);
    expect(store.undo().name).toBe("Agent: edit blocks");
    expect(read()).toBe(before);
    expect(store.databases.size, "auch die Datenbank ist wieder weg").toBe(0);
    expect(store.canUndo).toBe(false);
  });

  it("eine falsche Zeile wird mit Grund gemeldet und allein zurückgedreht, der Rest gilt", () => {
    const { run, h, shape } = setup(DOC);
    const r = run([
      "text: stays",
      "bogus thing",
      "del nope",
      `set ${h("Plan")} {colour=red}`,
      `set ${h("Plan")} {color=turquoise}`,
      // erst wird der Text gesetzt, dann scheitert das Attribut: der Text darf nicht stehen bleiben
      `set ${h("task")}: half written {lang=js}`,
      "sticker: nope",
      `text: where? {after=zzzz}`,
      `text: two places {after=${h("Plan")} before=${h("task")}}`,
      "text: also stays",
    ].join("\n"));
    expect(r).toMatchObject({ added: 2, changed: 0 });
    expect(r.errors.map((e) => e.replace(/ [0-9a-f]{4,8}(?=[ :{])/g, " H"))).toEqual([
      "line 2: bogus thing — not understood — see the statement list in the tool description",
      "line 3: del nope — no block nope on this page (read_blocks shows the handles)",
      "line 4: set H {colour=red} — a h2 block has no attribute colour",
      "line 5: set H {color=turquoise} — unknown colour turquoise — use blue, brown, gray, green, orange, pink, purple, red, yellow or default",
      "line 6: set H: half written {lang=js} — a todo block has no attribute lang",
      expect.stringContaining("unknown kind sticker"),
      "line 8: text: where? {after=zzzz} — no block zzzz on this page (read_blocks shows the handles)",
      expect.stringContaining("give one place, not after and before"),
    ]);
    expect(shape()).toContain('todo [ ] "task"');
    expect(shape().split("\n").slice(-2)).toEqual(['text "stays"', 'text "also stays"']);
  });

  it("Blöcke anderer Seiten sind nicht erreichbar; der Inhalt einer Unterseite gehört nicht zur Seite", () => {
    const { run, store, page, shape } = setup("Mine");
    const other = createPage(store, { title: "Other" });
    const child = createPage(store, { parent: page, title: "Child" });
    let foreign = "", inner = "";
    store.transact("seed", (tx) => {
      [foreign] = putMarkdownBlocks(store, tx, new MarkdownImporter().parse("secret"), "b:" + other, sortKeys(store, "b:" + other, { kind: "end" }, 1)) as [string];
      [inner] = putMarkdownBlocks(store, tx, new MarkdownImporter().parse("inside child"), "b:" + child, sortKeys(store, "b:" + child, { kind: "end" }, 1)) as [string];
    });
    expect(shape().split("\n")).toEqual(['text "Mine"', expect.stringMatching(/^page "Child"/)]);
    expect(run(`del ${foreign}`).errors[0]).toContain("no block");
    expect(run(`set ${inner}: changed`).errors[0]).toContain("no block");
    expect(store.blocks.get(foreign)?.text).toBe("secret");
    expect((store.blocks.get(inner) as Block).text).toBe("inside child");
  });

  it("Grenzen: zu langes Skript ändert nichts; Kommentare und Leerzeilen zählen nicht", () => {
    const { run, read } = setup("Intro");
    const before = read();
    expect(run("text: " + "x".repeat(200_001)).errors[0]).toContain("script too long");
    expect(read()).toBe(before);
    expect(run("# a comment\n\n   \ntext: one")).toMatchObject({ added: 1, errors: [] });
  });

  it("die Hilfe nennt jede Anweisung und die Farben aus dem Kern", () => {
    for (const word of ["set", "move", "indent", "outdent", "dup", "del", "check", "uncheck", "uncols", "cell", "row", "col", "md:", "after=", "before=", "in=", "left=", "right=", "page=", "blue", "yellow"]) expect(BLOCK_SCRIPT_HELP, word).toContain(word);
    expect(BLOCK_SCRIPT_HELP.length, "die Beschreibung kostet Token: sie steht in der Anleitung (based_guide blocks), nicht an jedem Werkzeug").toBeLessThan(3400);
  });
});

// BSD-663: Kennungen aus read_blocks gelten für die Seite, wie der Agent sie las. Ein Block, den eine frühere Zeile
// desselben Skripts anlegt, darf mit gleichem Anfang (zufällige ID) eine alte Kennung nicht mehrdeutig machen.
describe("BSD-663: neue Blöcke im Skript machen gelesene Kennungen nicht mehrdeutig", () => {
  it("die erste Zeile legt einen Block an, dessen ID mit der Kennung eines alten Blocks beginnt – move trifft den alten", () => {
    const { store, h, ok, shape } = setup("Intro\n\nThird paragraph");
    const third = h("Third");
    const intro = h("Intro");
    const real = globalThis.crypto.randomUUID.bind(globalThis.crypto);
    let first = true;
    // die nächste neue ID beginnt mit derselben Kennung wie „Third“
    const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      if (!first) return real();
      first = false;
      const r = real();
      return (third + r.slice(third.length)) as ReturnType<typeof real>;
    });
    try {
      const r = ok(`h2 s: Checklist {before=${intro}}\nmove ${third} {right=${intro}}`);
      expect(r).toMatchObject({ added: 1, moved: 1 });
      expect([...store.blocks.keys()].filter((id) => id.toLowerCase().startsWith(third))).toHaveLength(2);
    } finally { spy.mockRestore(); }
    expect(shape()).toBe(['h2 "Checklist"', "cols 2", "  col", '    text "Intro"', "  col", '    text "Third paragraph"'].join("\n"));
  });
});
