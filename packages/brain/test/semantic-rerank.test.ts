// BSD-231 Teil 3b: Suche nach Bedeutung – TF-IDF liefert Kandidaten, ein Embedding-Modell ordnet sie neu (bester
// Abschnitt je Seite); Vektoren werden zwischengespeichert; ohne Modell oder bei Fehlern bleibt es bei TF-IDF.
import { describe, expect, it } from "vitest";
import { createPage, type WorkspaceStore } from "@based/core";
import { AgentBrain, BrainTools, chunkTexts, EmbeddingCache, LocalSemanticIndex, relatedByMeaning, rerankByMeaning, type TextEmbedder } from "../src/index.js";
import { memoryStore } from "./helpers.js";

/** Doppel: Vektor = [Anteil „Reise“-Wörter, Anteil „Geld“-Wörter, 1 − beide]; zählt Aufrufe. */
function fakeEmbedder(id = "fake") {
  const calls: { texts: string[]; kind: string | undefined }[] = [];
  const travel = /reise|trip|flug|zug|urlaub|travel/gi, money = /kosten|euro|budget|preis|geld/gi;
  const e: TextEmbedder & { calls: typeof calls } = {
    id, calls,
    async embed(texts, _signal, kind) {
      calls.push({ texts: [...texts], kind });
      return texts.map((t) => {
        const a = (t.match(travel) ?? []).length, b = (t.match(money) ?? []).length, n = t.split(/\s+/).length || 1;
        const v = Float32Array.from([a / n, b / n, Math.max(0, 1 - (a + b) / n) * 0.1]);
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
  return e;
}

describe("Neuordnen nach Bedeutung (BSD-231 Teil 3b)", () => {
  it("bester Abschnitt je Seite, Anfrage als query, Abschnitte als passage; Cache spart die zweite Runde", async () => {
    const e = fakeEmbedder();
    const cache = new EmbeddingCache(100, e.id);
    const cands = [
      { pageID: "budget", chunks: ["Budget Notizen", "Kosten 300 Euro Preis"] },
      { pageID: "reise", chunks: ["Reise nach Wien mit dem Zug", "Packliste"] },
    ];
    const hits = await rerankByMeaning(e, "Kosten Euro Preis", cands, { cache });
    expect(hits.map((h) => h.pageID)).toEqual(["budget", "reise"]);
    expect(hits[0]!.snippet).toBe("Kosten 300 Euro Preis");
    expect(e.calls.map((c) => c.kind)).toEqual(["passage", "query"]);
    expect(e.calls[0]!.texts).toHaveLength(4);
    await rerankByMeaning(e, "Zug Reise", cands, { cache });
    expect(e.calls.slice(2).map((c) => c.kind)).toEqual(["query"]); // alles aus dem Cache
    expect(await rerankByMeaning(e, "  ", cands)).toEqual([]);
    const small = new EmbeddingCache(2);
    small.set("a", new Float32Array(1)); small.set("b", new Float32Array(1)); small.get("a"); small.set("c", new Float32Array(1));
    expect([small.get("a") !== undefined, small.get("b") !== undefined, small.size]).toEqual([true, false, 2]);
  });

  it("BrainTools.callAsync: semantic_search ordnet mit Modell neu, ohne Modell oder bei Fehler wie bisher", async () => {
    const store: WorkspaceStore = memoryStore();
    const page = (title: string, text: string) => {
      const id = createPage(store, { title });
      const now = store.now();
      store.transact("t", (tx) => tx.put({ kind: "block", data: { id: id + "-p", type: "text", parent: "b:" + id, sk: "a0", text, createdAt: now, updatedAt: now } as never }));
      return id;
    };
    const money = page("Notizen Wien", "Die Reise kostet 39 Euro, Budget passt");
    const trip = page("Wien Reise", "Wien Reise Zug Reise Urlaub Wien Wien");
    const index = new LocalSemanticIndex();
    for (const [id, title, t] of [[money, "Notizen Wien", "Die Reise kostet 39 Euro, Budget passt"], [trip, "Wien Reise", "Wien Reise Zug Reise Urlaub Wien Wien"]] as const) index.setPage(id, title, chunkTexts([t]));
    const brain = new AgentBrain(store);
    const plain = new BrainTools(store, brain, () => index);
    const query = { query: "Wien Euro Kosten", limit: 2 };
    const before = plain.call("semantic_search", query).text;
    expect(await plain.callAsync("semantic_search", query)).toEqual(plain.call("semantic_search", query));

    const e = fakeEmbedder();
    const withModel = new BrainTools(store, brain, () => index, async () => e);
    const r = await withModel.callAsync("semantic_search", query);
    expect(r.isError).toBe(false);
    expect(r.text.split("\n")[0]).toContain(`id: ${money}`);
    expect(e.calls.length).toBeGreaterThan(0);
    // andere Werkzeuge unverändert
    expect((await withModel.callAsync("related_pages", { page_id: trip })).isError).toBe(false);

    const broken = new BrainTools(store, brain, () => index, async () => ({ id: "x", embed: async () => { throw new Error("model gone"); } }));
    expect((await broken.callAsync("semantic_search", query)).text).toBe(before);
    const none = new BrainTools(store, brain, () => index, async () => undefined);
    expect((await none.callAsync("semantic_search", query)).text).toBe(before);
  });

  it("verwandte Seiten nach Bedeutung: Mittel der eigenen Abschnitte gegen den besten Abschnitt der Kandidaten", async () => {
    const e = fakeEmbedder();
    const hits = await relatedByMeaning(e, ["Reise nach Wien", "Zug und Urlaub"], [
      { pageID: "geld", chunks: ["Kosten Euro Budget"] },
      { pageID: "reise", chunks: ["Packliste", "Flug Reise Urlaub"] },
    ], { cache: new EmbeddingCache(100, e.id) });
    expect(hits.map((h) => h.pageID)).toEqual(["reise", "geld"]);
    expect(hits[0]!.snippet).toBe("Flug Reise Urlaub");
    expect(await relatedByMeaning(e, [], [{ pageID: "x", chunks: ["a"] }])).toEqual([]);
  });
});
