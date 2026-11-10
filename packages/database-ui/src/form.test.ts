// Formular-Ansicht: Fragen aus der Ansicht, Einstellungen in `view.form` (Swift-kompatibel), Prüfen je Typ, Absenden.
import { describe, expect, it } from "vitest";
import {
  MemoryPersistence, WorkspaceStore, movePropertyInView, parseRecord, encodeRecord, pv, rowsOf, setPropertyVisible, valueCase, values,
  type DatabaseView, type WireRecord,
} from "@based/core";
import {
  answersToRow, formConfig, formDescription, formQuestions, formTitle, hiddenFormProperties, parseFormDate, placeRaw, setFormDescription,
  setFormTitle, setQuestionDescription, setQuestionRequired, submitForm, validateAnswer, validateForm, type FormQuestion,
} from "./logic/form.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const opts = [{ id: "a", name: "Alpha", color: "gray" }, { id: "b", name: "Beta", color: "blue" }];

function setup(view: Partial<DatabaseView> = {}) {
  const records: WireRecord[] = [
    { kind: "block", data: { id: "blk", type: "databasePage", parent: "w", sk: "a0", props: { databaseID: "db" }, createdAt: 0, updatedAt: 0, stamp } },
    { kind: "database", data: { id: "db", blockID: "blk", title: "Feedback", summary: "Tell us", createdAt: 0, updatedAt: 0, stamp, properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "mail", name: "Email", type: "email" },
      { id: "n", name: "Rating", type: "number" },
      { id: "sel", name: "Team", type: "select", options: opts },
      { id: "tags", name: "Topics", type: "multiSelect", options: opts },
      { id: "when", name: "When", type: "date" },
      { id: "ok", name: "Consent", type: "checkbox" },
      { id: "site", name: "Website", type: "url" },
      { id: "tel", name: "Phone", type: "phone" },
      { id: "where", name: "Where", type: "place" },
      { id: "f", name: "Calc", type: "formula", formula: "1" },
      { id: "rel", name: "Rel", type: "relation", relation: { databaseID: "db" } },
    ] } },
    { kind: "view", data: { id: "v", databaseID: "db", blockID: "blk", name: "Form", type: "form", sortKey: "a0", createdAt: 0, updatedAt: 0, stamp, ...view } },
  ];
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" });
  return { store, view: () => store.views.get("v")!, db: () => store.databases.get("db")! };
}

const allVisible = { properties: ["title", "mail", "n", "sel", "tags", "when", "ok", "site", "tel", "where", "f", "rel"].map((id) => ({ id, visible: true })) };
const q = (s: ReturnType<typeof setup>, id: string): FormQuestion => formQuestions(s.view(), s.db()).find((x) => x.prop.id === id)!;

describe("Fragen", () => {
  it("ohne Einstellungen: nur der Titel, Pflicht; Titel = Ansichtsname, Beschreibung = Datenbank", () => {
    const s = setup();
    expect(formQuestions(s.view(), s.db()).map((x) => [x.prop.id, x.required])).toEqual([["title", true]]);
    expect(formTitle(s.view())).toBe("Form");
    expect(formDescription(s.view(), s.db())).toBe("Tell us");
  });

  it("ein-/ausblenden und Reihenfolge über view.properties; nicht unterstützte Typen fehlen", () => {
    const s = setup(allVisible);
    expect(formQuestions(s.view(), s.db()).map((x) => x.prop.id)).toEqual(["title", "mail", "n", "sel", "tags", "when", "ok", "site", "tel", "where"]);
    setPropertyVisible(s.store, "v", "mail", false);
    movePropertyInView(s.store, "v", "n", 0);
    expect(formQuestions(s.view(), s.db()).map((x) => x.prop.id).slice(0, 3)).toEqual(["n", "title", "sel"]);
    expect(hiddenFormProperties(s.view(), s.db()).map((p) => p.id)).toEqual(["mail"]);
  });

  it("Pflicht, Beschreibung, Titel/Beschreibung des Formulars in view.form; leer → Feld verschwindet", () => {
    const s = setup(allVisible);
    setQuestionRequired(s.store, "v", "mail", true);
    setQuestionRequired(s.store, "v", "title", false);
    setQuestionDescription(s.store, "v", "mail", "Work address");
    setFormTitle(s.store, "v", "Give feedback");
    setFormDescription(s.store, "v", "");
    expect(q(s, "mail")).toMatchObject({ required: true, description: "Work address" });
    expect(q(s, "title").required).toBe(false);
    expect(formTitle(s.view())).toBe("Give feedback");
    expect(formDescription(s.view(), s.db())).toBe("");
    setFormTitle(s.store, "v", "  ");
    setFormDescription(s.store, "v", undefined);
    setQuestionDescription(s.store, "v", "mail", "");
    expect(formConfig(s.view())).toEqual({ questions: { mail: { required: true }, title: { required: false } } });
    expect(formTitle(s.view())).toBe("Form");
  });

  it("Wire-Format: `form` wird mitgeschrieben und kein Pflichtfeld kommt hinzu", () => {
    const s = setup();
    setQuestionRequired(s.store, "v", "title", false);
    const r = s.store.record("view:v")!;
    const round = parseRecord(JSON.parse(encodeRecord(r)));
    expect((round.data as { form?: unknown }).form).toEqual({ questions: { title: { required: false } } });
    const { form: _, ...withoutForm } = round.data as Record<string, unknown>;
    expect(() => parseRecord({ kind: "view", data: withoutForm })).not.toThrow();
    // unbekannte Felder in view.form (neuere Version) bleiben erhalten
    const s2 = setup({ form: { future: 1, questions: { title: { required: true, color: "x" } } } } as never);
    setFormTitle(s2.store, "v", "T");
    expect((s2.view() as { form?: unknown }).form).toEqual({ future: 1, title: "T", questions: { title: { required: true, color: "x" } } });
  });
});

describe("Prüfen je Typ", () => {
  const s = setup(allVisible);
  const check = (id: string, a: unknown, required = false) => validateAnswer({ ...q(s, id), required }, a as never);
  it("Pflicht", () => {
    expect(check("title", "", true)).toBe("This question is required");
    expect(check("title", "  ", true)).toBe("This question is required");
    expect(check("ok", false, true)).toBe("Check this box to continue");
    expect(check("tags", [], true)).toBe("This question is required");
    expect(check("where", { name: " " }, true)).toBe("This question is required");
    expect(check("title", "", false)).toBeUndefined();
  });
  it("Zahl, E-Mail, Link, Telefon", () => {
    expect(check("n", "1,234.5")).toBeUndefined();
    expect(check("n", "zwölf")).toBe("Enter a number");
    expect(check("mail", "a@b.co")).toBeUndefined();
    expect(check("mail", "a@b")).toBe("Enter an email address");
    expect(check("site", "based.so/x")).toBeUndefined();
    expect(check("site", "https://example.com")).toBeUndefined();
    expect(check("site", "not a link")).toBe("Enter a link");
    expect(check("tel", "+43 1 234-56")).toBeUndefined();
    expect(check("tel", "call me")).toBe("Enter a phone number");
  });
  it("Datum und Optionen", () => {
    expect(check("when", "2026-02-28")).toBeUndefined();
    expect(check("when", "2026-02-30")).toBe("Enter a valid date");
    expect(check("when", "2026-02-28T25:00")).toBe("Enter a valid date");
    expect(check("sel", "a")).toBeUndefined();
    expect(check("sel", "zzz")).toBe("Choose an option");
    expect(check("tags", ["a", "b"])).toBeUndefined();
    expect(check("tags", ["a", "x"])).toBe("Choose from the options");
  });
  it("Ort: Koordinaten paarweise und im Bereich", () => {
    expect(check("where", { name: "Office" })).toBeUndefined();
    expect(check("where", { lat: "48.2" })).toBe("Enter both latitude and longitude");
    expect(check("where", { lat: "48,2", lon: "16.37" })).toBeUndefined();
    expect(check("where", { lat: "91", lon: "0" })).toBe("Latitude must be between −90 and 90");
    expect(check("where", { lat: "1", lon: "-181" })).toBe("Longitude must be between −180 and 180");
    expect(check("where", { lat: "a", lon: "1" })).toBe("Coordinates must be numbers");
  });
  it("validateForm sammelt alle Fehler", () => {
    expect(validateForm(formQuestions(s.view(), s.db()), { n: "x", mail: "y" })).toEqual({ title: "This question is required", n: "Enter a number", mail: "Enter an email address" });
  });
});

describe("Antworten → Zeile", () => {
  it("Datum lokal, mit und ohne Uhrzeit", () => {
    expect(parseFormDate("2026-06-10")).toEqual({ start: values.fromJSDate(new Date(2026, 5, 10)), includeTime: false });
    expect(parseFormDate("2026-06-10T09:30")).toEqual({ start: values.fromJSDate(new Date(2026, 5, 10, 9, 30)), includeTime: true });
  });
  it("Ort wie Swift PlaceValue.raw", () => {
    expect(placeRaw({ name: "Café" })).toBe("Café");
    expect(placeRaw({ name: "Café", lat: "48.2", lon: "16.37" })).toBe('{"lat":48.2,"lon":16.37,"name":"Café"}');
    expect(placeRaw({ address: "Ring 1" })).toBe('{"address":"Ring 1"}');
    expect(placeRaw({})).toBeUndefined();
  });
  it("Werte je Typ", () => {
    const s = setup(allVisible);
    const r = answersToRow(formQuestions(s.view(), s.db()), {
      title: " Ada ", mail: "ada@x.io", n: "1,5", sel: "b", tags: ["a", "a", "b"], when: "2026-06-10", ok: true, site: "x.io", tel: "+1 555", where: { name: "Home", lat: "1", lon: "2" },
    });
    expect(r.title).toBe("Ada");
    expect(r.values).toEqual({
      mail: pv("email", "ada@x.io"), n: pv("number", 15), sel: pv("select", "b"), tags: pv("multiSelect", ["a", "b"]),
      when: pv("date", { start: values.fromJSDate(new Date(2026, 5, 10)), includeTime: false }), ok: pv("checkbox", true),
      site: pv("url", "x.io"), tel: pv("phone", "+1 555"), where: pv("place", '{"lat":1,"lon":2,"name":"Home"}'),
    });
  });
});

describe("Absenden", () => {
  it("legt bei gültigen Antworten genau eine Zeile an (ein Undo-Schritt)", () => {
    const s = setup(allVisible);
    const bad = submitForm(s.store, s.view(), { n: "x" });
    expect(bad).toEqual({ ok: false, errors: { title: "This question is required", n: "Enter a number" } });
    expect(rowsOf(s.store, "db")).toHaveLength(0);
    const ok = submitForm(s.store, s.view(), { title: "Grace", n: "3", sel: "a" });
    expect(ok.ok).toBe(true);
    const rows = rowsOf(s.store, "db");
    expect(rows.map((r) => r.text)).toEqual(["Grace"]);
    expect(valueCase(rows[0]!.values!.n)).toEqual(["number", 3]);
    s.store.undo();
    expect(rowsOf(s.store, "db")).toHaveLength(0);
  });
  it("gesperrte Datenbank nimmt nichts an", () => {
    const s = setup();
    s.store.transact("Lock", (tx) => tx.put({ kind: "database", data: { ...s.db(), locked: true } }));
    expect(submitForm(s.store, s.view(), { title: "x" }).ok).toBe(false);
  });
});
