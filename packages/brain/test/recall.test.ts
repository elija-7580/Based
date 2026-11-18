// BSD-541: Abruf für Agenten – Relationen als Graph, kleiner Vektor-Index, recall, remember.
import { addProperty, addRow, attachSearchIndex, createDatabase, createPage, plainText, trashPages, type PropertyValue, type WorkspaceStore } from "@based/core";
import { describe, expect, it } from "vitest";
import {
  AgentBrain, pageSections, Recall, RelationGraph, RememberError, sameFact, SemanticIndexer, textHash, VectorIndex, WorkspaceTools,
  type EmbedKind, type TextEmbedder,
} from "../src/index.js";
import { fixture, memoryStore } from "./helpers.js";

function pageWith(store: WorkspaceStore, title: string, md = "", parent?: string): string {
  const id = createPage(store, { title, ...(parent ? { parent } : {}) });
  if (md) new WorkspaceTools(store).callSync("append_markdown", { page_id: id, markdown: md });
  return id;
}

const link = (store: WorkspaceStore, id: string) => `[${plainText(store.blocks.get(id)!.text)}](based://page/${id})`;

/** Kleines „Modell“: jede Begriffsgruppe ist eine Richtung – Synonyme und Sprachen fallen zusammen. */
const CONCEPTS: string[][] = [
  ["sync", "synchron", "abgleich", "devices", "gerate"], ["invoice", "rechnung", "billing", "payment"], ["dog", "hund", "terrier", "puppy"],
  ["meeting", "besprechung", "call"], ["editor", "block", "typing", "tippen"], ["server", "hosting", "deploy"], ["language", "sprache", "german", "deutsch"],
  ["short", "kurz", "concise", "brief"],
];
class ConceptEmbedder implements TextEmbedder {
  readonly id = "concepts@1";
  calls = 0;
  embedded: string[] = [];
  constructor(readonly dim = 32) {}
  async embed(texts: readonly string[], _signal?: AbortSignal, _kind: EmbedKind = "passage"): Promise<Float32Array[]> {
    this.calls += 1;
    this.embedded.push(...texts);
    return texts.map((t) => {
      const v = new Float32Array(this.dim).fill(-0.02);
      const s = t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
      CONCEPTS.forEach((words, i) => { if (words.some((w) => s.includes(w))) v[i] = 1; });
      return v;
    });
  }
}

function setup() {
  const store = memoryStore();
  const brain = new AgentBrain(store);
  const { index } = attachSearchIndex(store);
  const { graph } = RelationGraph.attach(store);
  return { store, brain, index, graph, recall: new Recall(store, brain, { search: () => index, graph: () => graph }) };
}

describe("RelationGraph", () => {
  it("kennt Relationen in beide Richtungen, Erwähnungen, Eltern und Kinder – und folgt Änderungen", () => {
    const { store, graph } = setup();
    const projects = createDatabase(store, { parent: "w", title: "Projects", sampleRows: 0 });
    const tasks = createDatabase(store, { parent: "w", title: "Tasks", sampleRows: 0 });
    const rel = addProperty(store, tasks.databaseID, "Project", "relation")!;
    const based = addRow(store, projects.databaseID, { title: "Based" })!;
    const task = addRow(store, tasks.databaseID, { title: "Ship beta", values: { [rel]: { relation: { _0: [based] } } as PropertyValue } })!;
    const adr = pageWith(store, "ADR 0017");
    const plan = pageWith(store, "Sync plan", `See ${link(store, adr)} for the format.`);
    const sub = pageWith(store, "Open questions", "", plan);

    expect(graph.neighbors(task).find((n) => n.id === based)).toEqual({ id: based, kind: "relation", out: true, label: "Project" });
    expect(graph.neighbors(based).find((n) => n.id === task)).toEqual({ id: task, kind: "relation", out: false, label: "Project" });
    expect(graph.neighbors(plan).map((n) => [n.id, n.kind, n.out])).toEqual([[adr, "mention", true], [sub, "child", true]]);
    expect(graph.neighbors(adr)).toEqual([{ id: plan, kind: "mention", out: false }]);
    expect(graph.neighbors(sub)).toEqual([{ id: plan, kind: "parent", out: true }]);
    expect(graph.describe(task)).toContain("Project: Based");
    expect(graph.describe(based)).toContain("Project of: Ship beta");

    // Papierkorb: der Nachbar verschwindet, ohne dass der Graph neu gebaut wird.
    trashPages(store, [adr]);
    expect(graph.neighbors(plan).map((n) => n.id)).toEqual([sub]);
    // Neue Erwähnung nach dem Anhängen
    const later = pageWith(store, "Later", `Depends on ${link(store, plan)}.`);
    expect(graph.neighbors(plan).some((n) => n.id === later && n.kind === "mention" && !n.out)).toBe(true);
  });
});

describe("VectorIndex", () => {
  const unit = (dim: number, seed: number) => {
    let x = seed * 2654435761 >>> 0;
    const v = new Float32Array(dim);
    let n = 0;
    for (let i = 0; i < dim; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; v[i] = x / 0xffffffff - 0.5; n += v[i]! * v[i]!; }
    n = Math.sqrt(n);
    for (let i = 0; i < dim; i++) v[i] = v[i]! / n;
    return v;
  };
  const near = (v: Float32Array, seed: number, noise: number) => {
    const r = unit(v.length, seed);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i]! + noise * r[i]!;
    return out;
  };

  it("findet die ähnlichsten Abschnitte (zwei Stufen) und stimmt mit dem genauen Kosinus überein", () => {
    const dim = 384, n = 4000;
    const idx = new VectorIndex(dim, "m");
    const vs: Float32Array[] = [];
    for (let i = 0; i < n; i++) { vs.push(unit(dim, i + 1)); idx.setPage("p" + i, [i], [vs[i]]); }
    expect(idx.size).toBe(n);
    expect(idx.bytes / n).toBeLessThanOrEqual(450); // Float32 wären 1 536 Byte
    let agree = 0;
    for (let t = 0; t < 40; t++) {
      const target = (t * 97) % n;
      const q = near(vs[target]!, 9000 + t, 0.6);
      const cos = (a: Float32Array, b: Float32Array) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < dim; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / Math.sqrt(na * nb); };
      const exact = vs.map((v, i) => ({ i, s: cos(q, v) })).sort((a, b) => b.s - a.s)[0]!;
      const hit = idx.search(q, 5)[0]!;
      if (hit.pageID === "p" + exact.i) agree += 1;
      expect(Math.abs(hit.score - cos(q, vs[Number(hit.pageID.slice(1))]!))).toBeLessThan(0.02);
    }
    expect(agree).toBe(40);
  });

  it("echte E5-Vektoren (alle in derselben Ecke des Raums): die Vorauswahl über Bits trifft, weil sie um den Mittelwert nimmt", () => {
    // Fixture: 480 Abschnitte und 8 Anfragen, eingebettet mit multilingual-e5-small (18.11.2026), als int8.
    // Bei 313 von 384 Dimensionen haben über 90 % dieser Vektoren dasselbe Vorzeichen – rohe Vorzeichen-Bits fanden
    // den besten Treffer in der Messung nur 62 von 68 Mal, um den Mittelwert genommen 68 von 68 Mal.
    const raw = fixture("e5-vectors.bin");
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const n = dv.getUint32(0, true), nq = dv.getUint32(4, true), dim = dv.getUint32(8, true);
    const row = (r: number) => Float32Array.from(new Int8Array(raw.buffer, raw.byteOffset + 12 + r * dim, dim));
    const vs = Array.from({ length: n }, (_, i) => row(i));
    const cos = (a: Float32Array, b: Float32Array) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < dim; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / Math.sqrt(na * nb); };
    const build = () => {
      const index = new VectorIndex(dim, "e5", 256, 100);
      vs.forEach((v, i) => index.setPage("p" + i, [i], [v]));
      return index;
    };
    const queries = [...Array.from({ length: nq }, (_, k) => ({ q: row(n + k), self: -1 })), ...vs.filter((_, i) => i % 8 === 0).map((q, k) => ({ q, self: k * 8 }))];
    const found = (index: VectorIndex) => queries.filter(({ q, self }) => {
      const exact = vs.map((v, i) => ({ i, s: cos(q, v) })).filter((x) => x.i !== self).sort((a, b) => b.s - a.s)[0]!;
      // Vorauswahl 5 % (im Betrieb sind es weniger als 1 %): der beste Treffer muss dabei sein.
      return index.search(q, 2, { preselect: 24, filter: (id) => id !== "p" + self })[0]!.pageID === "p" + exact.i;
    }).length;
    const index = build();
    expect(queries).toHaveLength(68);
    expect(found(index)).toBeGreaterThanOrEqual(67);
    expect(found(VectorIndex.deserialize(index.serialize(), { dim, model: "e5" })!)).toBeGreaterThanOrEqual(67);
  });

  it("ersetzt Seiten, behält unveränderte Abschnitte, übersteht Speichern und Laden", () => {
    const dim = 64;
    const idx = new VectorIndex(dim, "m", 256);
    idx.setPage("a", [1, 2], [unit(dim, 1), unit(dim, 2)]);
    idx.setPage("b", [3], [unit(dim, 3)]);
    // Abschnitt 2 bleibt (kein neuer Vektor nötig), 1 fällt weg, 9 kommt dazu.
    idx.setPage("a", [2, 9], [undefined, unit(dim, 9)]);
    expect(idx.hashesOf("a")).toEqual([2, 9]);
    expect(idx.size).toBe(3);
    expect(() => idx.setPage("a", [2, 77], [undefined, undefined])).toThrow(/no vector/);
    expect(idx.search(unit(dim, 2), 1)[0]).toMatchObject({ pageID: "a", chunk: 0 });
    idx.removePage("b");
    expect(idx.search(unit(dim, 3), 3).some((h) => h.pageID === "b")).toBe(false);

    const bytes = idx.serialize();
    expect(idx.dirty).toBe(false);
    const back = VectorIndex.deserialize(bytes, { dim, model: "m" })!;
    expect(back.size).toBe(2);
    expect(back.hashesOf("a")).toEqual([2, 9]);
    expect(back.search(unit(dim, 9), 1)[0]).toMatchObject({ pageID: "a", chunk: 1 });
    // Anderes Modell oder beschädigte Datei: kein Index (wird neu berechnet), kein Absturz.
    expect(VectorIndex.deserialize(bytes, { dim, model: "other" })).toBeUndefined();
    expect(VectorIndex.deserialize(bytes.subarray(0, bytes.length - 5), { dim, model: "m" })).toBeUndefined();
    expect(VectorIndex.deserialize(new Uint8Array(8), { dim, model: "m" })).toBeUndefined();
  });
});

describe("SemanticIndexer", () => {
  it("teilt Seiten entlang der Blöcke, stellt Titel und Überschrift voran, bettet nur Geändertes neu ein", async () => {
    const { store } = setup();
    const id = pageWith(store, "Sync plan", "Intro about devices.\n\n## Format\n\nRecords are compact.\n\n## Server\n\nHosting in the EU.");
    const sections = pageSections(store, id);
    expect(sections.map((s) => s.text)).toEqual(["Sync plan\nIntro about devices.", "Sync plan › Format\nFormat\nRecords are compact.", "Sync plan › Server\nServer\nHosting in the EU."]);
    expect(sections.every((s) => s.blockID)).toBe(true);
    expect(pageSections(store, pageWith(store, "Empty")).map((s) => s.text)).toEqual(["Empty"]);

    const embedder = new ConceptEmbedder();
    const idx = new VectorIndex(embedder.dim, embedder.id);
    const indexer = new SemanticIndexer(store, embedder, idx);
    indexer.enqueueAll();
    await indexer.drain();
    expect(idx.hashesOf(id)).toEqual(sections.map((s) => textHash(s.text)));
    const before = embedder.embedded.length;

    const stop = indexer.follow();
    new WorkspaceTools(store).callSync("append_markdown", { page_id: id, markdown: "The meeting is on Monday." });
    expect(indexer.pending).toBe(1);
    await indexer.drain();
    // Nur der Abschnitt „Server“ hat sich geändert (der neue Absatz hängt an ihm).
    expect(embedder.embedded.slice(before)).toEqual(["Sync plan › Server\nServer\nHosting in the EU.\nThe meeting is on Monday."]);
    trashPages(store, [id]);
    await indexer.drain();
    expect(idx.has(id)).toBe(false);
    stop();
  });
});

describe("remember (AgentBrain)", () => {
  it("eine Zeile je Tatsache, verknüpft; nichts doppelt; ersetzen statt überschreiben; heikel wartet", () => {
    const { store, brain, graph } = setup();
    const based = pageWith(store, "Based");
    const r1 = brain.remember({ fact: "The Mac beta of Based ships on 23 November 2026.", kind: "Work", about: [based], source: based });
    expect(r1).toMatchObject({ outcome: "saved", status: "Active", title: "The Mac beta of Based ships on 23 November 2026." });
    expect(brain.memories()[0]).toMatchObject({ id: r1.id, kind: "Work", status: "Active" });
    // Die Verknüpfung ist eine echte Erwähnung: Kante im Graphen, Backlink an der Seite.
    expect(graph.neighbors(r1.id).some((n) => n.id === based && n.kind === "mention" && n.out)).toBe(true);
    expect(graph.neighbors(based).some((n) => n.id === r1.id && !n.out)).toBe(true);

    // Dieselbe Aussage in anderen Worten: nichts Neues; eine neue Verknüpfung wird ergänzt.
    const other = pageWith(store, "Release plan");
    expect(brain.remember({ fact: "the mac beta of based ships on 23 november 2026" })).toMatchObject({ id: r1.id, outcome: "duplicate" });
    expect(brain.remember({ fact: "The Based Mac beta ships on November 23, 2026", about: [other] })).toMatchObject({ id: r1.id, outcome: "linked" });
    expect(brain.remember({ fact: "The Based Mac beta ships on November 23, 2026", about: [other, based] })).toMatchObject({ id: r1.id, outcome: "duplicate" });
    expect(brain.memories()[0]!.about).toEqual([based, other]);
    expect(brain.memories()).toHaveLength(1);
    expect(sameFact("Prefers tea", "Prefers coffee")).toBe(false);

    // Überholt: die alte Zeile bleibt, mit Status „Superseded“.
    const r2 = brain.remember({ fact: "The Mac beta of Based ships on 30 November 2026.", kind: "Work", replaces: r1.id });
    expect(r2.outcome).toBe("saved");
    expect(brain.memories().find((m) => m.id === r1.id)!.status).toBe("Superseded");
    expect(brain.activeMemories().map((m) => m.id)).toEqual([r2.id]);

    const r3 = brain.remember({ fact: "Has a doctor's appointment every month.", review: true });
    expect(r3.status).toBe("To review");
    expect(brain.activeMemories().some((m) => m.id === r3.id)).toBe(false);

    expect(() => brain.remember({ fact: "  " })).toThrow(RememberError);
    expect(() => brain.remember({ fact: "x y z", about: ["nope"] })).toThrow(/No page with id nope/);
    expect(() => brain.remember({ fact: "x y z", replaces: based })).toThrow(/No memory with id/);
    // Lange Tatsachen: kurzer Titel, alles im Rumpf.
    const long = "Elija wants the storage format to be compact. " + "It should run on old devices and in the browser. ".repeat(6);
    const r4 = brain.remember({ fact: long });
    expect(r4.title.length).toBeLessThanOrEqual(161);
    expect(brain.memories().find((m) => m.id === r4.id)!.body).toContain("old devices");
  });
});

describe("recall", () => {
  it("führt Wörter und Nachbarn zusammen: Memories zuerst, Seiten mit Auszug und Kanten, Verbundenes", async () => {
    const { store, brain, recall } = setup();
    const adr = pageWith(store, "ADR 0017", "Storage decisions.");
    const plan = pageWith(store, "Sync plan", `Devices sync through the server. Format in ${link(store, adr)}.`);
    const proto = pageWith(store, "Protocol v4", `Compact records for sync, see ${link(store, adr)}.`);
    pageWith(store, "Dog training", "The terrier learns to sit.");
    brain.ensure();
    brain.saveSkill({ name: "sync-helper", description: "Helps with sync", body: "Always check the sync status." });
    const mem = brain.remember({ fact: "Sync must work fully offline on every device.", kind: "Preference", about: [plan] });
    brain.remember({ fact: "Sync may skip old devices.", review: true });

    const r = await recall.run("what did we decide about sync?");
    expect(r.semantic).toBe(false);
    expect(r.memories.map((m) => m.id)).toEqual([mem.id]);
    expect(r.memories[0]!.aboutTitles).toEqual(["Sync plan"]);
    expect(r.pages.map((p) => p.id).sort()).toEqual([plan, proto].sort());
    expect(r.pages.find((p) => p.id === plan)!.links).toContain("mentions: ADR 0017");
    // ADR 0017 enthält „sync“ nicht, hängt aber an beiden Treffern.
    expect(r.connected).toEqual([{ id: adr, title: "ADR 0017", via: expect.arrayContaining(["Sync plan", "Protocol v4"]) as unknown as string[] }]);
    const text = Recall.format(r);
    expect(text).toContain("## Memories\n- Sync must work fully offline on every device. (Preference; about: Sync plan; id: " + mem.id + ")");
    expect(text).toContain("## Connected\n- ADR 0017");
    expect(text).not.toContain("sync-helper");
    expect(text).toContain("search by meaning is off");
    // Tippfehler tragen wie in Quick Find.
    expect((await recall.run("protocoll")).pages.map((p) => p.id)).toEqual([proto]);
    expect(Recall.format(await recall.run("zebra"))).toBe("Nothing found for “zebra”.");
  });

  it("`about` ohne Anfrage zeigt das Umfeld; mit Anfrage zählt das Umfeld stärker", async () => {
    const { store, recall } = setup();
    const a = pageWith(store, "Alpha notes", "editor work");
    const b = pageWith(store, "Beta notes", "editor work");
    const hub = pageWith(store, "Hub", `Links: ${link(store, b)}`);
    const around = await recall.run("", { about: hub });
    expect(around.pages.map((p) => p.id)).toEqual([b]);
    expect(Recall.format(around)).toContain("## Around “Hub”");
    const scoped = await recall.run("editor", { about: hub });
    expect(scoped.pages[0]!.id).toBe(b);
    expect(scoped.pages.map((p) => p.id)).toContain(a);
  });

  it("mit Modell findet recall nach Bedeutung, auch ohne gemeinsames Wort und über Sprachen", async () => {
    const { store, brain, index, graph } = setup();
    const rechnung = pageWith(store, "Rechnung März", "Die Rechnung vom Tierarzt ist bezahlt.");
    pageWith(store, "Editor ideas", "Typing should feel instant.");
    const pref = brain.remember({ fact: "Antworten bitte auf Deutsch und kurz.", kind: "Preference" });
    const embedder = new ConceptEmbedder();
    const vectors = new VectorIndex(embedder.dim, embedder.id);
    const indexer = new SemanticIndexer(store, embedder, vectors);
    indexer.enqueueAll();
    await indexer.drain();
    const recall = new Recall(store, brain, { search: () => index, graph: () => graph, vectors: () => ({ index: vectors, embedder }) });

    const r = await recall.run("invoice payment");
    expect(r.semantic).toBe(true);
    expect(r.pages[0]).toMatchObject({ id: rechnung, snippet: "Die Rechnung vom Tierarzt ist bezahlt." });
    expect(r.pages[0]!.blockID).toBeTruthy();
    const m = await recall.run("which language should replies be in, concise?");
    expect(m.memories.map((x) => x.id)).toEqual([pref.id]);
    expect(Recall.format(m)).not.toContain("search by meaning is off");
  });
});
