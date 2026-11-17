// Suchqualität: ein fester kleiner Workspace (deutsch/englisch) und Anfragen, wie man sie wirklich tippt – mit
// Tippfehlern, Wortteilen, Begriffen über mehrere Absätze, Zeilen über Relation/Person/Option. Gezählt wird, ob die
// erwartete Seite unter den ersten fünf steht: einmal wie Quick Find (`extended`), einmal wie die MCP-Suche.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keysBetween, MemoryPersistence, SearchIndex, WorkspaceStore, type WireRecord } from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "s" };
let n = 0;
const records: WireRecord[] = [];
const sk = keysBetween(400, undefined, undefined);
const block = (id: string, type: string, parent: string, text: unknown, extra: Record<string, unknown> = {}) => {
  records.push({ kind: "block", data: { id, type, parent, sk: sk[n++]!, text, createdAt: 0, updatedAt: 0, stamp, ...extra } } as never);
  return id;
};
function page(id: string, title: string, lines: (string | [string, string])[], parent = "w") {
  block(id, "page", parent, title);
  lines.forEach((l, i) => (typeof l === "string" ? block(`${id}-${i}`, "text", "b:" + id, l) : block(`${id}-${i}`, l[0], "b:" + id, l[1])));
}

page("budget", "Budgetplanung 2027", ["Die Marketingausgaben steigen um zwölf Prozent.", ["heading2", "Personalkosten"], "Zwei neue Stellen im Vertrieb, eine in der Entwicklung.", "Die Reisekosten bleiben unverändert."]);
page("notiz", "Besprechungsnotiz Quartalsabschluss", ["Teilnehmer: Anna Berger, Jonas Weiß und Frau Müller.", "Beschluss: Die Umsatzprognose wird nach oben korrigiert.", "Offene Frage zur Lieferkette in Österreich."]);
page("arch", "Sync Architecture", ["The server keeps a change log with sequence numbers.", "Conflicts are resolved with hybrid logical clocks.", "Tombstones are garbage collected after ninety days."]);
page("rezept", "Kürbissuppe", ["Hokkaido, Ingwer, Kokosmilch und etwas Chili.", "Zwanzig Minuten köcheln lassen, dann pürieren.", "Dazu passt geröstetes Brot."]);
page("reise", "Reise nach Lissabon", ["Flug am Freitag, Rückflug am Dienstag.", "Unterkunft in der Alfama gebucht.", "Restaurant: Cervejaria Ramiro reservieren."]);
page("onb", "Onboarding neue Mitarbeiterinnen", ["Laptop bestellen und Zugänge einrichten.", "Einführung in das Abrechnungssystem.", ["todo", "Sicherheitsunterweisung vereinbaren"]]);
page("thesis", "Masterarbeit Gliederung", ["Kapitel eins: Einleitung und Forschungsfrage.", "Kapitel zwei: Methodik der Einzelzellsequenzierung.", "Kapitel drei: Ergebnisse und Diskussion."]);
page("ideas", "Product ideas", ["Whiteboard with handwriting recognition.", "Offline first, every device holds the workspace.", "Agents that remember decisions across meetings."]);
page("mention", "Wochenplan", [], "w");
block("mention-0", "text", "b:mention", [{ t: "Siehe " }, { t: "Budgetplanung", mention: { page: { _0: "budget" } } }, { t: " vor dem Termin." }]);
for (let i = 0; i < 40; i++) page("fill" + i, `Notizen Woche ${i + 1}`, [`Allgemeine Aufgaben der Woche ${i + 1}.`, "Nichts Besonderes, Routine und Ablage."]);

// Datenbank „Projekte“ mit Relation auf „Kunden“, Person, Status, Datum.
records.push({ kind: "database", data: { id: "dbK", blockID: "pK", title: "Kunden", properties: [{ id: "title", name: "Name", type: "title" }], createdAt: 0, updatedAt: 0, stamp } } as never);
records.push({ kind: "database", data: { id: "dbP", blockID: "pP", title: "Projekte", createdAt: 0, updatedAt: 0, stamp, properties: [
  { id: "title", name: "Name", type: "title" },
  { id: "kunde", name: "Kunde", type: "relation", relation: { databaseID: "dbK" } },
  { id: "status", name: "Status", type: "status", options: [{ id: "o1", name: "In Arbeit" }, { id: "o2", name: "Abgeschlossen" }] },
  { id: "lead", name: "Verantwortlich", type: "person" },
  { id: "notes", name: "Notiz", type: "text" },
] } } as never);
block("pK", "databasePage", "w", "Kunden", { props: { databaseID: "dbK" } });
block("pP", "databasePage", "w", "Projekte", { props: { databaseID: "dbP" } });
block("k1", "page", "d:dbK", "Alpenmilch Genossenschaft");
block("k2", "page", "d:dbK", "Nordlicht Verlag");
block("r1", "page", "d:dbP", "Relaunch Webshop", { values: { kunde: { relation: { _0: ["k1"] } }, status: { status: { _0: "o1" } }, lead: { person: { _0: ["Anna Berger"] } }, notes: { text: { _0: "Zahlungsanbieter wechseln" } } } });
block("r2", "page", "d:dbP", "Imagebroschüre", { values: { kunde: { relation: { _0: ["k2"] } }, status: { status: { _0: "o2" } }, lead: { person: { _0: ["Jonas Weiß"] } } } });

/** Anfrage → erwartete Seite, mit der Art der Schwierigkeit. */
const CASES: [kind: string, query: string, expected: string][] = [
  ["genau: Titel", "Budgetplanung", "budget"],
  ["genau: Inhalt", "Umsatzprognose", "notiz"],
  ["Wortteil im zusammengesetzten Wort", "notiz quartal", "notiz"],
  ["Umlaut ohne Umlaut getippt", "kurbissuppe", "rezept"],
  ["ß als ss getippt", "jonas weiss", "notiz"],
  ["Tippfehler im Titel (1)", "Budgetplannung", "budget"],
  ["Tippfehler im Titel (vertauscht)", "Lissabno", "reise"],
  ["Tippfehler im Titel (2)", "Kürbisupe", "rezept"],
  ["Tippfehler im Inhalt (1)", "Umsatzprognsoe", "notiz"],
  ["Tippfehler im Inhalt (1), englisch", "tombstnes", "arch"],
  ["Tippfehler im Inhalt (2)", "Einzelzelsequenzirung", "thesis"],
  ["drei Wörter, eines falsch", "hybrid logical clokcs", "arch"],
  ["zwei Wörter, Titel + Inhalt", "lissabon alfama", "reise"],
  ["Begriffe in verschiedenen Absätzen", "ingwer brot", "rezept"],
  ["Begriffe in verschiedenen Absätzen, einer falsch", "ingwer pürriren", "rezept"],
  ["Überschrift im Inhalt", "Personalkosten", "budget"],
  ["Wortform (Plural/Beugung)", "Reisekost", "budget"],
  ["Wortform: Verb gebeugt", "garbage collection", "arch"],
  ["Zeile über Relation (Kundenname)", "Alpenmilch", "r1"],
  ["Zeile über Person", "Anna Berger", "r1"],
  ["Zeile über Status", "Abgeschlossen", "r2"],
  ["Zeile über Datenbankname + Wort", "Projekte Webshop", "r1"],
  ["Zeile über Textfeld", "Zahlungsanbieter", "r1"],
  ["Erwähnung einer Seite", "Budgetplanung Termin", "mention"],
  ["Tippfehler + Wortteil", "besprechugnsnotiz", "notiz"],
  ["fehlendes Leerzeichen", "syncarchitecture", "arch"],
];

describe("Suchqualität (Ausgangslage und Ziel)", () => {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", lazy: false, propertyRecords: false });
  const index = SearchIndex.fromSource(store);
  const top5 = (query: string, extended: boolean) => (index.run(query, { limit: 5, extended, now: 0 }) ?? []).map((h) => h.pageID);
  const run = (extended: boolean) => CASES.map(([kind, query, expected]) => ({ kind, query, expected, got: top5(query, extended), ok: top5(query, extended).includes(expected) }));

  it("erweitert (Quick Find, MCP, Agenten): jede erwartete Seite steht unter den ersten fünf", () => {
    const quick = run(true);
    const misses = quick.filter((r) => !r.ok).map((r) => `${r.kind}: „${r.query}“ → ${r.got.join(", ") || "nichts"}`);
    if (process.env.BASED_SEARCH_REPORT) writeFileSync(process.env.BASED_SEARCH_REPORT, quick.map((r) => `${r.ok ? "✓" : "✗"} ${r.kind.padEnd(48)} ${r.query}`).join("\n") + "\n");
    // Ausgangslage 17.11.: 15 von 26 in Quick Find, 9 von 26 über MCP (dort ohne `extended`).
    expect(misses).toEqual([]);
  });

  it("die schlichte Suche (wie die Swift-App) bleibt, wie sie war: 9 von 26", () => {
    expect(run(false).filter((r) => r.ok).length).toBe(9);
  });

  it("genaue Treffer stehen vor ähnlichen; Unsinn findet nichts", () => {
    expect(top5("Budgetplanung", true)[0]).toBe("budget");
    expect(top5("Lissabon", true)[0]).toBe("reise");
    expect(top5("Kunden", true)[0]).toBe("pK");
    for (const q of ["xqzvwy", "blorptang gruffelix", "9999999"]) expect(top5(q, true), q).toEqual([]);
    // ein Tippfehler holt nicht alles Mögliche: „Budgetplannung“ meint eine Seite (und die, die sie erwähnt)
    expect(top5("Budgetplannung", true).length).toBeLessThanOrEqual(2);
    // kurze Begriffe und Zahlen werden nie „ungefähr“ gesucht
    expect(index.alternatives("brot")).toEqual([]);
    expect(index.alternatives("2027")).toEqual([]);
  });

  it("der Ausschnitt zeigt die Stelle, die gemeint war", () => {
    const hit = (index.run("Umsatzprognsoe", { limit: 5, extended: true, now: 0 }) ?? []).find((h) => h.pageID === "notiz");
    expect(hit?.snippet).toContain("Umsatzprognose");
    expect(hit?.blockID).toBe("notiz-1");
  });

  it("eine Zeile folgt dem Titel ihrer Relation und dem Namen ihrer Datenbank", () => {
    const live = SearchIndex.fromSource(store);
    live.apply({ upserts: [{ kind: "block", data: { ...store.blocks.get("k1")!, text: "Bergkäse Sennerei" } }], deletions: [] });
    expect((live.run("Sennerei", { limit: 5, extended: true, now: 0 }) ?? []).map((h) => h.pageID)).toContain("r1");
    expect((live.run("Alpenmilch", { limit: 5, extended: true, now: 0 }) ?? []).map((h) => h.pageID)).not.toContain("r1");
    live.apply({ upserts: [{ kind: "database", data: { ...store.databases.get("dbP")!, title: "Vorhaben" } }], deletions: [] });
    expect((live.run("Vorhaben Webshop", { limit: 5, extended: true, now: 0 }) ?? []).map((h) => h.pageID)).toContain("r1");
  });
});
