// BSD-381 (ADR 0016, E0): Testseite für den neuen Block-Editor, gebaut wie Elijas „Second Brain“ – zwei
// Inline-Datenbanken nebeneinander in Spalten, Callout, Zitat, Listen, Überschriften und eine lange Tabelle. Sie
// stellt die Fälle nach, an denen der alte Editor hakte (Spalten mit Datenbanken, lange Seiten), und dient in
// Unit-Tests (`blockFixtureOutline`) und E2E (Worker-Befehl `seedBlockFixture`) als gemeinsame Grundlage.
// Keine React-Abhängigkeit: der Worker baut die Seite direkt im Store.
import { createDatabase, createPage, keysBetween, makeBlock, makeRecordID, type Block, type RichText, type WorkspaceStore } from "@based/core";

export const BLOCK_FIXTURE_TITLE = "Block editor test page";

/** Zeilen der langen Tabelle (genug, dass die Seite sicher scrollt). */
export const FIXTURE_TABLE_ROWS = 40;

interface Spec {
  type: Block["type"];
  text?: RichText;
  props?: Block["props"];
  children?: Spec[];
  /** Platzhalter für eine Inline-Datenbank (wird nach der Struktur angelegt). */
  database?: { title: string; rows: string[] };
}

const t = (s: string): RichText => s;

function fixtureSpec(): Spec[] {
  const tableRows: Spec[] = [
    { type: "tableRow", props: { cells: [t("Week"), t("Focus"), t("Notes")] } },
    ...Array.from({ length: FIXTURE_TABLE_ROWS - 1 }, (_, i): Spec => ({
      type: "tableRow", props: { cells: [t(`W${String(i + 1).padStart(2, "0")}`), t(["Writing", "Reading", "Building", "Resting"][i % 4]!), t(i % 5 === 0 ? "Review the week and plan the next one" : "")] },
    })),
  ];
  return [
    { type: "heading1", text: t("Second Brain") },
    { type: "text", text: [{ t: "Everything in one place: " }, { t: "projects", m: { b: true } }, { t: ", areas and " }, { t: "notes", m: { i: true } }, { t: "." }] },
    { type: "callout", text: t("Start here: capture first, sort later."), props: { icon: "" }, children: [
      { type: "bulletedList", text: t("Inbox gets everything new") },
      { type: "bulletedList", text: t("Weekly review empties it") },
    ] },
    { type: "columnList", children: [
      { type: "column", props: { ratio: 0.5 }, children: [
        { type: "text", text: t("What I am working on.") },
        { type: "databaseInline", database: { title: "Projects", rows: ["Based beta", "Garden", "Tax return", "Trip to Lisbon", "Read 12 books"] } },
      ] },
      { type: "column", props: { ratio: 0.5 }, children: [
        { type: "text", text: t("Everything I captured.") },
        { type: "databaseInline", database: { title: "Notes", rows: ["Meeting with Anna", "Ideas for the shop", "Book: Deep Work"] } },
      ] },
    ] },
    { type: "quote", text: t("Your mind is for having ideas, not holding them.") },
    { type: "heading2", text: t("Lists") },
    { type: "bulletedList", text: t("Areas"), children: [
      { type: "bulletedList", text: t("Health") },
      { type: "bulletedList", text: t("Work"), children: [{ type: "bulletedList", text: t("Based") }] },
    ] },
    { type: "bulletedList", text: t("Resources") },
    { type: "numberedList", text: t("Capture") },
    { type: "numberedList", text: t("Organize") },
    { type: "numberedList", text: t("Distill") },
    { type: "numberedList", text: t("Express") },
    { type: "heading3", text: t("Today") },
    { type: "todo", text: t("Water the plants"), props: { checked: true } },
    { type: "todo", text: t("Call the bank") },
    { type: "toggle", text: t("Weekly review checklist"), children: [
      { type: "text", text: t("Empty the inbox, check the calendar, pick three priorities.") },
    ] },
    { type: "heading2", text: t("Long table") },
    { type: "table", props: { tableColumns: 3, tableHeaderRow: true }, children: tableRows },
    { type: "divider" },
    { type: "code", text: t("const brain = capture(everything);"), props: { language: "typescript" } },
    { type: "text", text: t("End of page.") },
  ];
}

/**
 * Legt die Testseite an (unter `parent` oder oben in der Seitenleiste) und gibt ihre ID zurück. Struktur in einem
 * Schritt, jede Datenbank in einem eigenen (wie „/Database – inline“).
 */
export function buildBlockFixture(store: WorkspaceStore, opts: { parent?: string; title?: string } = {}): string {
  const pageID = createPage(store, { title: opts.title ?? BLOCK_FIXTURE_TITLE, ...(opts.parent ? { parent: opts.parent } : {}) });
  const pending: { parent: string; sk: string; database: NonNullable<Spec["database"]> }[] = [];
  store.transact("Test page", (tx) => {
    const now = store.now();
    const put = (parentID: string, specs: readonly Spec[]) => {
      const keys = keysBetween(specs.length, undefined, undefined);
      specs.forEach((s, i) => {
        if (s.database) {
          pending.push({ parent: parentID, sk: keys[i]!, database: s.database });
          return;
        }
        const id = makeRecordID();
        tx.put({ kind: "block", data: makeBlock({ id, type: s.type, parent: "b:" + parentID, sk: keys[i]!, text: s.text, props: s.props, createdBy: store.userID }, now) });
        if (s.children?.length) put(id, s.children);
      });
    };
    put(pageID, fixtureSpec());
  });
  for (const p of pending) {
    const made = createDatabase(store, { parent: "b:" + p.parent, inline: true, title: p.database.title, sampleRows: 0, undoable: false });
    store.transact("Test page", (tx) => {
      tx.update(made.blockID, (b) => { b.sk = p.sk; });
      const now = store.now();
      const keys = keysBetween(p.database.rows.length, undefined, undefined);
      p.database.rows.forEach((title, i) => {
        tx.put({ kind: "block", data: makeBlock({ id: makeRecordID(), type: "page", parent: "d:" + made.databaseID, sk: keys[i]!, text: title, createdBy: store.userID }, now) });
      });
    }, { undoable: false });
  }
  return pageID;
}

/** Erwartete Gliederung der Testseite („Tiefe · Typ“, wie `outlineOf`). */
export function blockFixtureOutline(): string[] {
  const walk = (specs: readonly Spec[], depth: number): string[] =>
    specs.flatMap((s) => [`${"  ".repeat(depth)}${s.type}`, ...(s.type === "table" ? [] : walk(s.children ?? [], depth + 1))]);
  return walk(fixtureSpec(), 0);
}
