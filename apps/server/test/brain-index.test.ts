// BSD-541: Suche nach Bedeutung auf dem Server – Index folgt dem Workspace, übersteht einen Neustart, recall nutzt ihn.
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPage } from "@based/core";
import type { EmbedKind, TextEmbedder } from "@based/brain";
import { createApp } from "../src/index.js";
import { Recall } from "@based/brain";
import { TOKEN } from "./helpers.js";

const GROUPS = [["sync", "abgleich", "gerate", "devices"], ["invoice", "rechnung", "payment", "bezahlt"], ["dog", "hund", "terrier"]];
class FakeEmbedder implements TextEmbedder {
  readonly id = "fake@1";
  texts: string[] = [];
  async embed(texts: readonly string[], _s?: AbortSignal, _k: EmbedKind = "passage"): Promise<Float32Array[]> {
    this.texts.push(...texts);
    return texts.map((t) => {
      const v = new Float32Array(32).fill(-0.02);
      const s = t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
      GROUPS.forEach((g, i) => { if (g.some((w) => s.includes(w))) v[i] = 1; });
      return v;
    });
  }
}

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

describe("BrainIndex", () => {
  it("ohne Modell: Stand sagt es, recall läuft über Wörter", async () => {
    const app = createApp({ token: TOKEN });
    cleanup.push(() => app.close());
    expect(await app.brain.state()).toMatchObject({ installed: false, ready: false, sections: 0, model: { id: "multilingual-e5-small" } });
    expect(app.pages.vectors?.()).toBeUndefined();
  });

  it("baut den Index, folgt Änderungen, speichert und lädt ihn – nach dem Neustart wird nichts neu eingebettet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-brain-"));
    const db = join(dir, "based.sqlite"), indexFile = join(dir, "based.vectors");
    const e1 = new FakeEmbedder();
    const app = createApp({ token: TOKEN, db, brain: { indexFile, embedder: async () => e1, pauseMs: 0 } });
    const store = app.pages.store;
    const rechnung = createPage(store, { title: "Rechnung März" });
    app.pages.append(rechnung, "Die Rechnung vom Tierarzt ist bezahlt.");
    createPage(store, { title: "Hund" });
    await app.brain.start();
    await app.brain.idle();
    const st = await app.brain.state();
    expect(st).toMatchObject({ ready: true, pending: 0 });
    expect(st.sections).toBeGreaterThanOrEqual(2);

    const out = Recall.format(await app.pages.recall().run("invoice payment"));
    expect(out).toContain("Rechnung März");
    expect(out).not.toContain("search by meaning is off");

    // Neue Seite kommt ohne Zutun in den Index.
    const sync = createPage(store, { title: "Abgleich der Geräte" });
    await app.brain.idle();
    expect(Recall.format(await app.pages.recall().run("how do devices sync"))).toContain("Abgleich der Geräte");
    void sync;
    await app.close();
    expect(existsSync(indexFile)).toBe(true);
    expect(statSync(indexFile).size).toBeLessThan(4096);

    const e2 = new FakeEmbedder();
    const again = createApp({ token: TOKEN, db, brain: { indexFile, embedder: async () => e2, pauseMs: 0 } });
    cleanup.push(() => again.close());
    await again.brain.start();
    await again.brain.idle();
    expect((await again.brain.state()).sections).toBe(st.sections + 1);
    expect(e2.texts).toEqual(["ok"]); // nur die Probe für die Breite
    expect(Recall.format(await again.pages.recall().run("invoice"))).toContain("Rechnung März");
  });
});
