// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { LEARN_SETTLE_MS, type LearnCandidate, type LearnState, type MemorySuggestion } from "@based/brain";
import { describe, expect, it } from "vitest";
import { Learner } from "./learner.js";
import { DEFAULT_BRAIN_SETTINGS, type BrainSettings } from "./settings.js";

const NOW = 10_000_000_000;
const NOTE = "I am building Based, a notes app that should replace Notion for me. Anna (anna@example.org) designs the website. ".repeat(3);

function setup(opts: { learn?: boolean; canWrite?: boolean; redact?: boolean; candidates?: LearnCandidate[]; samples?: string; answer?: string } = {}) {
  const settings: BrainSettings = { ...DEFAULT_BRAIN_SETTINGS, redact: { ...DEFAULT_BRAIN_SETTINGS.redact, enabled: opts.redact === true }, memories: { suggest: false, learn: opts.learn !== false } };
  const calls: { system: string; prompt: string }[] = [];
  const saved: { pageID: string; suggestions: MemorySuggestion[] }[] = [];
  const styles: string[] = [];
  const seeds: boolean[] = [];
  let state: unknown;
  const learner = new Learner({
    settings: { getState: () => settings },
    canWrite: () => opts.canWrite !== false,
    now: () => NOW,
    storage: { get: () => state, set: (v: LearnState) => { state = JSON.parse(JSON.stringify(v)); } },
    write: async (system, prompt) => {
      calls.push({ system, prompt });
      return opts.answer ?? '{"memories":[{"title":"Project Based","type":"Work","body":"Building a notes app to replace Notion."}]}';
    },
    client: {
      learnCandidates: async (seed) => { seeds.push(seed); return opts.candidates ?? [{ id: "p1", title: "Ideas", text: NOTE, editedAt: NOW - LEARN_SETTLE_MS }]; },
      learnSave: async (pageID, suggestions) => { saved.push({ pageID, suggestions }); return []; },
      styleSamples: async () => opts.samples ?? "",
      saveStyle: async (body) => { styles.push(body); return "style"; },
      memories: async () => [],
      personNames: async () => [],
    },
  });
  return { learner, calls, saved, styles, seeds, state: () => state as LearnState };
}

describe("Learner (learning from notes)", () => {
  it("does nothing while the setting is off or no model is set up", async () => {
    for (const o of [{ learn: false }, { canWrite: false }]) {
      const t = setup(o);
      expect(await t.learner.tick()).toBe("off");
      expect(t.calls).toHaveLength(0);
      expect(t.seeds).toHaveLength(0);
    }
  });

  it("reads a settled page once and saves what it found with the page as source", async () => {
    const t = setup();
    expect(await t.learner.tick()).toBe("page");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.prompt).toContain("Note “Ideas”");
    expect(t.saved).toEqual([{ pageID: "p1", suggestions: [{ title: "Project Based", kind: "Work", body: "Building a notes app to replace Notion.", sensitive: false }] }]);
    // Dieselbe Fassung wird nicht noch einmal gelesen; die zuletzt bearbeiteten Seiten nur beim ersten Mal vorgemerkt.
    expect(await t.learner.tick()).toBe("idle");
    expect(t.calls).toHaveLength(1);
    expect(t.seeds).toEqual([true, false]);
  });

  it("does not retry a failed call for the same version every minute", async () => {
    const t = setup({ answer: "not json" });
    expect(await t.learner.tick()).toBe("page");
    expect(t.saved).toEqual([{ pageID: "p1", suggestions: [] }]);
    expect(await t.learner.tick()).toBe("idle");
    expect(t.calls).toHaveLength(1);
  });

  it("marks short pages as read without a model call", async () => {
    const t = setup({ candidates: [{ id: "s", title: "List", text: "milk", editedAt: NOW - LEARN_SETTLE_MS }] });
    expect(await t.learner.tick()).toBe("idle");
    expect(t.calls).toHaveLength(0);
    expect(t.state().pages.s).toBeDefined();
    expect(t.state().runs).toEqual([]);
  });

  it("sends only placeholders when redaction is on and puts the values back", async () => {
    const t = setup({ redact: true, });
    await t.learner.tick();
    expect(t.calls[0]!.prompt).not.toContain("anna@example.org");
  });

  it("reads the writing style when no page is waiting", async () => {
    const t = setup({ candidates: [], samples: "Ich schreibe kurz. ".repeat(100), answer: "- Short sentences.\n- German." });
    expect(await t.learner.tick()).toBe("style");
    expect(t.styles).toEqual(["- Short sentences.\n- German."]);
    expect(await t.learner.tick()).toBe("idle");
    expect(t.calls).toHaveLength(1);
  });
});
