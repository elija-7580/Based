// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Lernen aus Notizen, Worker-Seite: welche Seiten der BrainHost anbietet und was er daraus speichert.
import { createPage, MemoryPersistence, WorkspaceStore } from "@based/core";
import { WorkspaceTools, type LearnCandidate } from "@based/brain";
import { describe, expect, it } from "vitest";
import { BrainHost } from "./brain.js";

function setup() {
  const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence() });
  const host = new BrainHost(store);
  store.observe((ch) => host.noteChange(ch));
  const tools = new WorkspaceTools(store);
  const page = (title: string, md: string) => {
    const id = createPage(store, { title });
    if (md) tools.callSync("append_markdown", { page_id: id, markdown: md });
    return id;
  };
  const candidates = (seed = false) => host.handle(seed ? { op: "learnCandidates", seed } : { op: "learnCandidates" }) as LearnCandidate[];
  return { store, host, page, candidates };
}

describe("BrainHost: learning from notes", () => {
  it("offers pages that were written here, with their text, and never the Agent Brain itself", () => {
    const t = setup();
    const id = t.page("Ideas", "I am building Based.\n\nIt should replace Notion.");
    t.host.handle({ op: "ensure" });
    t.host.handle({ op: "saveMemory", title: "Role", kind: "Profile", body: "Founder." });
    const c = t.candidates();
    expect(c.map((x) => x.id)).toEqual([id]);
    expect(c[0]).toMatchObject({ title: "Ideas", text: "I am building Based.\nIt should replace Notion." });
    expect(c[0]!.remote).toBeUndefined();
    expect(c[0]!.editedAt).toBeGreaterThan(0);
  });

  it("drops a page once something was learned from it and offers it again after the next edit", () => {
    const t = setup();
    const id = t.page("Ideas", "I am building Based.");
    t.host.handle({ op: "learnSave", pageID: id, suggestions: [{ title: "Project Based", kind: "Work", body: "Building a notes app.", sensitive: false }] });
    expect(t.candidates()).toEqual([]);
    const m = (t.host.handle({ op: "memories" }) as { title: string; body: string }[]).find((x) => x.title === "Project Based")!;
    expect(m.body).toContain(`Source: [Ideas](based://page/${id})`);
    new WorkspaceTools(t.store).callSync("append_markdown", { page_id: id, markdown: "More." });
    expect(t.candidates().map((x) => x.id)).toEqual([id]);
  });

  it("skips pages an agent wrote", () => {
    const t = setup();
    const ai = t.page("Report", "Written by an agent.");
    t.store.transact("origin", (tx) => tx.update(ai, (b) => { b.origin = "ai"; }));
    expect(t.candidates()).toEqual([]);
  });

  it("seeds the most recently edited pages once asked", () => {
    const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence() });
    const id = createPage(store, { title: "Before" });
    new WorkspaceTools(store).callSync("append_markdown", { page_id: id, markdown: "Written before the app started." });
    const host = new BrainHost(store);
    expect(host.handle({ op: "learnCandidates" })).toEqual([]);
    expect((host.handle({ op: "learnCandidates", seed: true }) as LearnCandidate[]).map((x) => x.id)).toEqual([id]);
  });

  it("collects writing samples and answers what a writing call should know", () => {
    const t = setup();
    t.page("Essay", "Ich schreibe kurz und direkt. ".repeat(20));
    expect(t.host.handle({ op: "styleSamples" })).toContain("Ich schreibe kurz und direkt.");
    expect(t.host.handle({ op: "personal", query: "anything" })).toBe("");
    t.host.handle({ op: "saveStyle", body: "- Short and direct." });
    expect(t.host.handle({ op: "personal", query: "anything" })).toContain("- Short and direct.");
  });
});
