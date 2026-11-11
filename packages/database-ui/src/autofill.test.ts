// BSD-225 Teil 2: Autofill – Prompt, Antwort → Wert je Typ, ein Undo-Schritt, Abbruch.
import { createDatabase, MemoryPersistence, WorkspaceStore, type PropertySchema } from "@based/core";
import { describe, expect, it } from "vitest";
import { autofillPrompt, autofillValue, rowContext, runAutofill } from "./logic/autofill.js";

const sel: PropertySchema = { id: "s", name: "Area", type: "select", options: [{ id: "o1", name: "Work", color: "blue" }, { id: "o2", name: "Home", color: "green" }] };

describe("Autofill: Antwort → Wert", () => {
  it("Select/Status nach Optionsnamen (Groß/klein, Anführungszeichen egal), sonst nichts", () => {
    expect(autofillValue(sel, "\"work\".")).toEqual({ select: { _0: "o1" } });
    expect(autofillValue({ ...sel, type: "status" }, "Home")).toEqual({ status: { _0: "o2" } });
    expect(autofillValue(sel, "Garden")).toBeUndefined();
  });
  it("Multi-Select kommagetrennt, „none“ leert; Checkbox ja/nein; Text erste Zeile", () => {
    expect(autofillValue({ ...sel, type: "multiSelect" }, "Work, home, Work")).toEqual({ multiSelect: { _0: ["o1", "o2"] } });
    expect(autofillValue({ ...sel, type: "multiSelect" }, "none")).toBeNull();
    expect(autofillValue({ id: "c", name: "Urgent", type: "checkbox" }, "Yes.")).toEqual({ checkbox: { _0: true } });
    expect(autofillValue({ id: "c", name: "Urgent", type: "checkbox" }, "maybe")).toBeUndefined();
    expect(autofillValue({ id: "t", name: "Summary", type: "text" }, "\n  Short summary\nmore")).toEqual({ text: { _0: "Short summary" } });
  });
  it("Prompt nennt Property, Optionen und Zeilentext", () => {
    const p = autofillPrompt(sel, "Buy milk");
    expect(p).toContain("Property: Area");
    expect(p).toContain("Work, Home");
    expect(p).toContain("Buy milk");
  });
});

describe("Autofill: alle Zeilen, ein Undo-Schritt", () => {
  it("füllt jede Zeile, schreibt einmal, Undo nimmt alles zurück; Abbruch schreibt das bisher Gefüllte", async () => {
    let t = 0;
    const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), now: () => (t += 1) });
    const made = createDatabase(store, { parent: "w", title: "Tasks", sampleRows: 3, undoable: false });
    const db0 = structuredClone(store.databases.get(made.databaseID)!);
    db0.properties.push(sel);
    store.transact("schema", (tx) => tx.put({ kind: "database", data: db0 }), { undoable: false });
    const db = store.databases.get(made.databaseID)!;
    const rows = store.children("d:" + db.id);
    expect(rows.length).toBe(3);
    expect(rowContext(store, rows[0]!)).toBeTruthy();
    const answers = ["Work", "Home", "Garden"];
    let i = 0;
    const ai = { available: () => true, write: async () => answers[i++]! };
    const seen: number[] = [];
    const r = await runAutofill(store, db, sel, ai, new AbortController().signal, (s) => seen.push(s.done));
    expect(r).toEqual({ done: 3, total: 3, filled: 2 });
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(rows.map((id) => store.blocks.get(id)!.values?.s)).toEqual([{ select: { _0: "o1" } }, { select: { _0: "o2" } }, undefined]);
    store.undo();
    expect(rows.map((id) => store.blocks.get(id)!.values?.s)).toEqual([undefined, undefined, undefined]);

    const c = new AbortController();
    i = 0;
    const r2 = await runAutofill(store, db, sel, { available: () => true, write: async () => { const a = answers[i++]!; if (i === 1) c.abort(); return a; } }, c.signal);
    expect(r2.filled).toBe(1);
    expect(store.blocks.get(rows[0]!)!.values?.s).toEqual({ select: { _0: "o1" } });
  });
});
