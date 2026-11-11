// BSD-317: Hybrid-Import (Inhalt aus dem ZIP, Struktur aus der API) gegen eine Fixture-Welt, aus der beide Quellen
// entstehen (test/fixtures/hybrid-world.ts): Struktur zuerst, kein blocks/children, Abweichungen ZIP↔API als Warnung,
// Relationen über Teilbäume, Abbruch + Fortsetzen, Idempotenz, Delta-Abgleich.
import { describe, expect, it } from "vitest";
import {
  HybridImportError, HybridNotionImport, MemoryHybridState, MemoryPersistence, NotionClient, WorkspaceStore, hybridDeviationWarnings, hybridDiagnosticReport,
  hybridPending, importPendingSource, openNotionExport, storeHybridTarget, writeZip, ZIP_ONLY_ROOT,
} from "../src/index.js";
import type { Block, HybridImportOptions, HybridMode } from "../src/index.js";
import { IDS, smallWorld, uid, type World } from "./fixtures/hybrid-world.js";

const plain = (t: Block["text"]) => (typeof t === "string" ? t : (t ?? []).map((r) => r.t ?? "").join(""));

function setup(w: World) {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const state = new MemoryHybridState();
  let clock = new Date("2026-11-05T10:00:00Z");
  const make = (o: { zip?: Uint8Array | null; options?: HybridImportOptions } = {}) => {
    const client = new NotionClient("secret_x", w.transport(), { requestsPerSecond: 0, sleep: async () => {} });
    const index = o.zip === null ? undefined : openNotionExport(o.zip ?? w.zip());
    return new HybridNotionImport(client, index, storeHybridTarget(store, state), undefined, { clock: () => clock, ...o.options });
  };
  const run = (mode: HybridMode, o: { zip?: Uint8Array | null; options?: HybridImportOptions } = {}) => make(o).run(mode);
  return { store, state, run, make, at: (iso: string) => { clock = new Date(iso); } };
}

/** Baum als Text: Typ und Titel/Text, eingerückt; Zeilen einer Datenbank unter ihrem Block. */
function outline(store: WorkspaceStore, parent = "w", depth = 0): string[] {
  return store.children(parent).flatMap((id) => {
    const b = store.blocks.get(id)!;
    if (b.trashedAt !== undefined) return [];
    const db = b.props?.databaseID;
    const own = db !== undefined && store.databases.get(db)?.blockID === id;
    const label = `${"  ".repeat(depth)}${b.type}:${plain(b.text) || (db !== undefined ? plain(store.databases.get(db)?.title) : "")}`;
    return [label, ...outline(store, "b:" + id, depth + 1), ...(own ? outline(store, "d:" + db, depth + 1) : [])];
  });
}

const kinds = (list: { kind: string }[]) => [...new Set(list.map((d) => d.kind))].sort();

describe("Notion-Hybrid-Import (BSD-317)", () => {
  it("Struktur zuerst: Baum, Datenbanken, Ansichten und Zeilenwerte stehen, bevor Inhalt geladen ist", async () => {
    const w = smallWorld();
    const { store, run, state } = setup(w);
    let structureDone = false;
    const s2 = { store, state, make: setup(w).make };
    void run;
    const fresh = setup(w);
    s2.store = fresh.store; s2.state = fresh.state; s2.make = fresh.make;
    const job = s2.make({ options: { isCancelled: () => structureDone } });
    job.onProgress = (p) => { if (p.phase === "structure" && p.fraction === 1) structureDone = true; };
    const rep = await job.run("full");
    expect(rep.cancelled).toBe(true);
    expect(s2.state.state?.phase).toBe("content");
    expect(outline(s2.store)).toEqual([
      "page:Home",
      "  page:Spec",
      "    page:Deep",
      "  page:Notes",
      "  page:Nested in toggle",
      "  databaseInline:Tasks",
      "    page:Write docs",
      "    page:Plan",
      "page:Other tree",
      "  databaseInline:People",
      "    page:Ada",
      "    page:Bob",
    ]);
    // Alle Seiten warten auf Inhalt, keine einzige Inhaltsanfrage ging hinaus.
    expect(hybridPending(s2.store)).toHaveLength(10);
    expect(w.get("children")).toBe(0);
    // Ansichten mit Filter und Sortierung, Eigenschaftstypen, Relation über Teilbäume.
    const tasks = s2.store.databases.get(IDS.TASKS_DS)!;
    expect(tasks.properties.map((p) => `${p.name}:${p.type}`).sort()).toEqual(["Done:checkbox", "Name:title", "Owner:relation"]);
    expect(tasks.properties.find((p) => p.name === "Owner")?.relation?.databaseID).toBe(IDS.PEOPLE_DS);
    const views = [...s2.store.views.values()].filter((v) => v.databaseID === IDS.TASKS_DS);
    expect(views.map((v) => `${v.name}:${v.type}`).sort()).toEqual(["All:table", "Open:board"]);
    const open = views.find((v) => v.name === "Open")!;
    expect(open.filter).toBeDefined();
    expect(open.sorts?.length).toBe(1);
    const owner = tasks.properties.find((p) => p.name === "Owner")!.id;
    expect(s2.store.blocks.get(IDS.T1)!.values![owner]).toEqual({ relation: { _0: [IDS.ADA] } });
  });

  it("voller Lauf: Inhalt aus dem ZIP an der richtigen Stelle, kein blocks/children, Format aus dem Export", async () => {
    const w = smallWorld();
    const { store, run } = setup(w);
    const r = await run("full");
    expect(r.remaining).toBe(0);
    expect(r.state.phase).toBe("done");
    expect(w.get("children")).toBe(0);
    expect(outline(store)).toEqual([
      "page:Home",
      "  text:Welcome home",
      "  page:Spec",
      "    text:Spec body",
      "    page:Deep",
      "      text:Deep body",
      "  text:Between spec and tasks",
      "  databaseInline:Tasks",
      "    page:Write docs",
      "      text:Row body",
      "    page:Plan",
      "  toggle:More",
      "    text:Inside toggle",
      "    page:Nested in toggle",
      "      text:Nested body",
      "  page:Notes",
      "    text:Notes body",
      "  text:The end",
      "page:Other tree",
      "  text:Other body",
      "  databaseInline:People",
      "    page:Ada",
      "      text:Ada body",
      "    page:Bob",
    ]);
    expect(store.blocks.get(IDS.HOME)!.props?.format?.fullWidth).toBe(true);
    expect(r.state.done.fromZip).toBe(10);
    expect(r.state.done.viaApi).toBe(0);
    expect(r.state.deviations).toEqual([]);
    expect([...store.blocks.values()].some((b) => importPendingSource(b) !== undefined)).toBe(false);
  });

  it("idempotent: ein zweiter voller Lauf legt nichts doppelt an und lädt nichts neu", async () => {
    const w = smallWorld();
    const { store, run } = setup(w);
    await run("full");
    const before = outline(store);
    const count = store.blocks.size;
    const again = await run("full");
    expect(store.blocks.size).toBe(count);
    expect(outline(store)).toEqual(before);
    expect(again.state.totals.content).toBe(0);
    expect(again.state.done.fromZip).toBe(0);
  });

  it("Abweichungen ZIP↔API: nach dem Export geändert, im ZIP fehlend, nur im ZIP, Titel anders – alles im Bericht", async () => {
    const w = smallWorld();
    // Nach dem Export in Notion geändert: neuer Text, den nur die API kennt.
    const spec = w.pages.get(IDS.SPEC)!;
    spec.zipBody = spec.body;
    spec.body = [{ t: "p", id: uid(0xb, 10), text: "Spec body, edited after the export" }, { t: "sub", id: IDS.DEEP }];
    spec.edited = "2026-11-02T09:00:00.000Z";
    // Fehlt im Export.
    w.pages.get(IDS.NOTES)!.inZip = false;
    // Nur im Export: nicht mit der Integration geteilt (unter einer bekannten Seite und ganz oben).
    const SECRET = uid(1, 50), LONELY = uid(1, 51);
    w.page(SECRET, "Secret plans", { parent: IDS.HOME, shared: false, body: [{ t: "p", id: uid(0xb, 60), text: "Only in the ZIP" }] });
    w.pages.get(IDS.HOME)!.body.push({ t: "sub", id: SECRET });
    w.page(LONELY, "Lonely", { shared: false, body: [{ t: "p", id: uid(0xb, 61), text: "No parent known" }] });
    // Titel im Export anders als in Notion (ohne dass die Seite als geändert gilt).
    w.pages.get(IDS.DEEP)!.zipTitle = "Deep (old name)";
    const { store, run } = setup(w);
    const r = await run("full");
    expect(r.remaining).toBe(0);
    expect(kinds(r.state.deviations)).toEqual(["editedAfterExport", "missingInZip", "onlyInZip", "titleDiffers"]);
    const by = (k: string) => r.state.deviations.filter((d) => d.kind === k).map((d) => d.title).sort();
    expect(by("editedAfterExport")).toEqual(["Spec"]);
    expect(by("missingInZip")).toEqual(["Notes"]);
    expect(by("onlyInZip")).toEqual(["Lonely", "Secret plans"]);
    expect(r.state.deviations.find((d) => d.kind === "titleDiffers")).toMatchObject({ title: "Deep", detail: "Deep (old name)" });
    // Genau die zwei betroffenen Seiten kamen über die API – sonst keine Inhaltsanfrage.
    expect(w.get("children")).toBe(2);
    expect(r.state.done.viaApi).toBe(2);
    const o = outline(store);
    expect(o).toContain("    text:Spec body, edited after the export");
    expect(o).not.toContain("    text:Spec body");
    expect(o).toContain("    text:Notes body");
    expect(o).toContain("  page:Secret plans");
    expect(o).toContain("    text:Only in the ZIP");
    expect(plain(store.blocks.get(IDS.DEEP)!.text)).toBe("Deep");
    // Ohne bekannte Elternseite: unter der Sammelseite, nicht verloren.
    expect(store.blocks.get(LONELY)!.parent).toBe("b:" + ZIP_ONLY_ROOT);
    const lines = hybridDeviationWarnings(r.state.deviations);
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("“Notes”");
    expect(hybridDiagnosticReport(r.state)).toContain("missingInZip");
    expect(hybridDiagnosticReport(r.state)).not.toContain("secret_x");
  });

  it("Relationen über Teilbäume; Ziele außerhalb des Imports werden gemeldet, nicht verschluckt", async () => {
    const w = smallWorld();
    w.pages.get(IDS.BOB)!.shared = false;
    const { store, run } = setup(w);
    const r = await run("full");
    const tasks = store.databases.get(IDS.TASKS_DS)!;
    const owner = tasks.properties.find((p) => p.name === "Owner")!;
    expect(owner.type).toBe("relation");
    expect(owner.relation?.databaseID).toBe(IDS.PEOPLE_DS);
    expect(store.blocks.get(IDS.T1)!.values![owner.id]).toEqual({ relation: { _0: [IDS.ADA] } });
    expect(store.blocks.get(IDS.ADA)!.parent).toBe("d:" + IDS.PEOPLE_DS);
    const dangling = r.state.deviations.filter((d) => d.kind === "danglingRelation");
    expect(dangling.map((d) => d.title)).toEqual(["Plan"]);
    // Bob steht im ZIP, ist aber nicht geteilt: aus dem ZIP gerettet und gemeldet.
    expect(r.state.deviations.some((d) => d.kind === "onlyInZip" && d.title === "Bob")).toBe(true);
    expect(store.blocks.has(IDS.BOB)).toBe(true);
  });

  it("Inline-Datenbank, deren Block im Export eine andere ID trägt, wird über den Zeilenordner zugeordnet", async () => {
    const w = smallWorld();
    w.databases.get(IDS.TASKS)!.divID = uid(0xb, 99);
    const { store, run } = setup(w);
    const r = await run("full");
    const home = outline(store).slice(0, 8);
    expect(home[6]).toBe("  text:Between spec and tasks");
    expect(home[7]).toBe("  databaseInline:Tasks");
    expect(r.state.deviations).toEqual([]);
  });

  it("Abbruch und Fortsetzen: nach einem Neustart geht es dort weiter, ohne Doppelimport", async () => {
    const reference = setup(smallWorld());
    await reference.run("full");
    const w = smallWorld();
    const { store, state, run } = setup(w);
    let batches = 0;
    const first = await run("full", { options: { zipBatch: 2, isCancelled: () => batches >= 2, yield: async () => { batches += 1; } } });
    expect(first.cancelled).toBe(true);
    expect(first.state.phase).toBe("content");
    expect(first.remaining).toBeGreaterThan(0);
    expect(first.remaining).toBeLessThan(10);
    const searches = w.get("search");
    // „Neustart“: neuer Lauf, gleicher Store und gespeicherter Stand.
    expect(state.load()?.phase).toBe("content");
    const second = await run("resume");
    expect(second.cancelled).toBe(false);
    expect(second.remaining).toBe(0);
    expect(second.state.phase).toBe("done");
    // Die Struktur wurde nicht noch einmal geholt.
    expect(w.get("search")).toBe(searches);
    expect(second.state.done.fromZip).toBe(10);
    expect(outline(store)).toEqual(outline(reference.store));
    expect(store.blocks.size).toBe(reference.store.blocks.size);
  });

  it("Fortsetzen ohne ZIP wartet auf das ZIP statt Inhalt zu verlieren; Abbruch mitten in der Struktur beginnt die Struktur neu", async () => {
    const w = smallWorld();
    const { store, run } = setup(w);
    let batches = 0;
    await run("full", { options: { zipBatch: 3, isCancelled: () => batches >= 1, yield: async () => { batches += 1; } } });
    const waiting = await run("resume", { zip: null });
    expect(waiting.remaining).toBe(7);
    expect(waiting.waitingForZip).toBe(7);
    expect(waiting.state.phase).toBe("content");
    const done = await run("resume");
    expect(done.remaining).toBe(0);

    const w2 = smallWorld();
    const s2 = setup(w2);
    w2.failAfter = 3;
    await expect(s2.run("full")).rejects.toThrow();
    expect(s2.state.load()?.phase).toBe("structure");
    expect(s2.store.blocks.size).toBe(0);
    w2.failAfter = undefined;
    const ok = await s2.run("resume");
    expect(ok.remaining).toBe(0);
    expect(outline(s2.store)).toEqual(outline(store));
  });

  it("geöffnete Seite wird vorgezogen", async () => {
    const w = smallWorld();
    const { store, make } = setup(w);
    let batches = 0;
    const job = make({ options: { zipBatch: 1, isCancelled: () => batches >= 1, yield: async () => { batches += 1; } } });
    job.prioritize(IDS.DEEP);
    await job.run("full");
    expect(importPendingSource(store.blocks.get(IDS.DEEP))).toBeUndefined();
    expect(store.children("b:" + IDS.DEEP).map((id) => plain(store.blocks.get(id)!.text))).toEqual(["Deep body"]);
    expect(hybridPending(store)).toHaveLength(9);
  });

  it("Delta-Abgleich: holt nur Änderungen seit dem letzten Lauf; Based gewinnt bei Konflikten; nichts wird gelöscht", async () => {
    const w = smallWorld();
    const { store, run, at } = setup(w);
    await run("full");
    const count = store.blocks.size;
    for (const k of [...w.requests.keys()]) w.requests.set(k, 0);

    // Nichts geändert: eine Suchanfrage, sonst nichts.
    at("2026-11-06T10:00:00Z");
    const idle = await run("delta", { zip: null });
    expect(idle.state.totals.content).toBe(0);
    expect(w.get("search")).toBe(1);
    expect(w.get("children") + w.get("rows") + w.get("database")).toBe(0);
    expect(store.blocks.size).toBe(count);

    // In Notion: Notes bekommt neuen Text, eine Zeile wird abgehakt und umbenannt, Deep zieht nach ganz oben um,
    // eine neue Unterseite entsteht. In Based: Spec wird bearbeitet – und in Notion ebenfalls (Konflikt).
    const notes = w.pages.get(IDS.NOTES)!;
    notes.body = [{ t: "p", id: uid(0xb, 12), text: "Notes body v2" }, { t: "p", id: uid(0xb, 70), text: "Added in Notion" }];
    notes.edited = "2026-11-06T12:00:00.000Z";
    const t2 = w.pages.get(IDS.T2)!;
    t2.title = "Plan v2";
    t2.values!.Done = { id: "dn", type: "checkbox", checkbox: true };
    t2.edited = "2026-11-06T12:05:00.000Z";
    const deep = w.pages.get(IDS.DEEP)!;
    deep.parent = undefined;
    deep.edited = "2026-11-06T12:10:00.000Z";
    const FRESH = uid(1, 80);
    w.page(FRESH, "Fresh page", { parent: IDS.HOME, edited: "2026-11-06T12:20:00.000Z", inZip: false, body: [{ t: "p", id: uid(0xb, 71), text: "Fresh body" }] });
    const spec = w.pages.get(IDS.SPEC)!;
    spec.body = [{ t: "p", id: uid(0xb, 10), text: "Spec changed in Notion" }];
    spec.edited = "2026-11-06T12:30:00.000Z";
    store.setText(store.children("b:" + IDS.SPEC)[0]!, "Spec changed in Based");
    // In Based gelöscht: bleibt gelöscht, auch wenn Notion die Seite anfasst.
    store.deleteBlocks([IDS.OTHER]);
    w.pages.get(IDS.OTHER)!.edited = "2026-11-06T12:40:00.000Z";

    at("2026-11-07T10:00:00Z");
    const r = await run("delta", { zip: null });
    expect(r.remaining).toBe(0);
    const o = outline(store);
    expect(o).toContain("    text:Notes body v2");
    expect(o).toContain("    text:Added in Notion");
    expect(o).not.toContain("    text:Notes body");
    expect(plain(store.blocks.get(IDS.T2)!.text)).toBe("Plan v2");
    const done = store.databases.get(IDS.TASKS_DS)!.properties.find((p) => p.name === "Done")!.id;
    expect(store.blocks.get(IDS.T2)!.values![done]).toEqual({ checkbox: { _0: true } });
    expect(store.blocks.get(IDS.DEEP)!.parent).toBe("w");
    expect(store.blocks.get(FRESH)!.parent).toBe("b:" + IDS.HOME);
    expect(o).toContain("    text:Fresh body");
    // Konflikt: Based gewinnt und es steht im Bericht.
    expect(o).toContain("    text:Spec changed in Based");
    expect(o).not.toContain("    text:Spec changed in Notion");
    expect(r.state.deviations.filter((d) => d.kind === "conflict").map((d) => d.title)).toEqual(["Spec"]);
    expect(store.blocks.get(IDS.OTHER)!.trashedAt).toBeDefined();
    // Unveränderte Seiten wurden nicht angefasst: Inhalt nur für geänderte Seiten geholt.
    expect(w.get("children")).toBe(5);
    expect(plain(store.blocks.get(store.children("b:" + IDS.HOME)[0]!)!.text)).toBe("Welcome home");

    // In Notion gelöscht: bleibt in Based, ein voller Lauf meldet es.
    w.pages.delete(IDS.NESTED);
    at("2026-11-08T10:00:00Z");
    const full = await run("full");
    expect(store.blocks.get(IDS.NESTED)!.trashedAt).toBeUndefined();
    expect(full.state.deviations.filter((d) => d.kind === "deletedInNotion").map((d) => d.title)).toContain("Nested in toggle");
  });

  it("Markdown-&-CSV-Export wird mit klarer Meldung abgelehnt; Delta ohne früheren Import ebenso", async () => {
    const enc = new TextEncoder();
    const md = writeZip([{ path: "Export/Home 11111111111111111111111111111111.md", data: enc.encode("# Home\n") }]);
    expect(() => openNotionExport(md)).toThrowError(HybridImportError);
    expect(() => openNotionExport(md)).toThrowError(/HTML export/);
    const { run } = setup(smallWorld());
    await expect(run("delta", { zip: null })).rejects.toThrow(/no earlier Notion import/);
    await expect(run("full", { zip: null })).rejects.toThrow(/needs the Notion HTML export/);
  });
});
