// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { createPage } from "@based/core";
import { describe, expect, it } from "vitest";
import {
  AgentBrain, emptyLearnState, LEARN_MAX_PER_HOUR, LEARN_REMOTE_SETTLE_MS, LEARN_SETTLE_MS, learnBudgetLeft, learnPrompt, markLearned, markStyle, nextLearnPage, parseLearnState,
  parseStyle, personalContext, relevantMemories, STYLE_REFRESH_MS, STYLE_TITLE, styleDue, learnHash, type LearnCandidate, type MemoryRecord,
} from "../src/index.js";
import { memoryStore } from "./helpers.js";

const long = (s: string) => (s + " ").repeat(80);
const cand = (id: string, text: string, editedAt: number, remote = false): LearnCandidate => ({ id, title: id, text, editedAt, ...(remote ? { remote } : {}) });
const NOW = 10_000_000_000;

describe("learning from notes: which page is next", () => {
  it("waits until a page has settled and skips short pages", () => {
    const s = emptyLearnState();
    expect(nextLearnPage([cand("a", long("I run Based."), NOW - 1000)], s, NOW)).toBeUndefined();
    expect(nextLearnPage([cand("a", "milk, eggs", NOW - LEARN_SETTLE_MS)], s, NOW)).toBeUndefined();
    expect(nextLearnPage([cand("a", long("I run Based."), NOW - LEARN_SETTLE_MS)], s, NOW)?.id).toBe("a");
  });

  it("gives the device that wrote a page time to learn first", () => {
    const c = cand("a", long("Synced."), NOW - LEARN_SETTLE_MS * 2, true);
    expect(nextLearnPage([c], emptyLearnState(), NOW)).toBeUndefined();
    expect(nextLearnPage([{ ...c, editedAt: NOW - LEARN_REMOTE_SETTLE_MS }], emptyLearnState(), NOW)?.id).toBe("a");
  });

  it("reads a version once, the oldest change first, and again only after the text changed", () => {
    const a = cand("a", long("Alpha"), NOW - LEARN_SETTLE_MS * 3), b = cand("b", long("Beta"), NOW - LEARN_SETTLE_MS * 5);
    let s = emptyLearnState();
    expect(nextLearnPage([a, b], s, NOW)?.id).toBe("b");
    s = markLearned(s, "b", b.text, NOW);
    expect(nextLearnPage([a, b], s, NOW)?.id).toBe("a");
    s = markLearned(s, "a", a.text, NOW);
    expect(nextLearnPage([a, b], s, NOW)).toBeUndefined();
    expect(nextLearnPage([{ ...a, text: long("Alpha two") }, b], s, NOW)?.id).toBe("a");
  });

  it("stops at the hourly budget and recovers an hour later", () => {
    let s = emptyLearnState();
    for (let i = 0; i < LEARN_MAX_PER_HOUR; i++) s = markLearned(s, "p" + i, "x" + i, NOW);
    expect(learnBudgetLeft(s, NOW)).toBe(0);
    const c = cand("new", long("New"), NOW - LEARN_SETTLE_MS);
    expect(nextLearnPage([c], s, NOW)).toBeUndefined();
    expect(nextLearnPage([{ ...c, editedAt: NOW }], s, NOW + 3_600_001 + LEARN_SETTLE_MS)?.id).toBe("new");
    // Zu kurze Seiten merken kostet kein Budget.
    expect(learnBudgetLeft(markLearned(emptyLearnState(), "s", "short", NOW, false), NOW)).toBe(LEARN_MAX_PER_HOUR);
  });

  it("keeps its state through storage and ignores broken values", () => {
    const s = markStyle(markLearned({ ...emptyLearnState(), seeded: true }, "a", "text", NOW), "samples", NOW);
    expect(parseLearnState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseLearnState("nope")).toEqual(emptyLearnState());
    expect(parseLearnState({ pages: { a: { hash: 1 } }, runs: ["x", 5] })).toEqual({ v: 1, pages: {}, runs: [5] });
  });

  it("sends the note, capped, with the titles of what is already known", () => {
    const p = learnPrompt({ title: "Ideas", text: "x".repeat(10_000) }, [{ id: "m", title: "Project Based", kind: "Work", body: "" }]);
    expect(p).toContain("- Project Based (Work)");
    expect(p).toContain("Note “Ideas”");
    expect(p.length).toBeLessThan(6200);
  });
});

describe("writing style", () => {
  it("is read once there is enough text and refreshed weekly when the samples changed", () => {
    const samples = long("Ich schreibe kurz und direkt.").repeat(3);
    let s = emptyLearnState();
    expect(styleDue(s, "too short", NOW)).toBe(false);
    expect(styleDue(s, samples, NOW)).toBe(true);
    s = markStyle(s, samples, NOW);
    expect(styleDue(s, samples + " more", NOW + 1000)).toBe(false);
    expect(styleDue(s, samples, NOW + STYLE_REFRESH_MS)).toBe(false);
    expect(styleDue(s, samples + " more", NOW + STYLE_REFRESH_MS)).toBe(true);
    expect(learnHash(samples)).not.toBe(learnHash(samples + " more"));
  });

  it("keeps only the bullets of the answer", () => {
    expect(parseStyle("Here is the style:\n- Short sentences.\n* German, informal\n\nHope this helps!")).toBe("- Short sentences.\n- German, informal");
    expect(parseStyle("- a\n".repeat(9)).split("\n")).toHaveLength(6);
    expect(parseStyle("No bullets at all.")).toBe("");
  });

  it("lives in one memory whose body is replaced", () => {
    const brain = new AgentBrain(memoryStore());
    const id = brain.setStyle("- Short sentences.");
    expect(brain.setStyle("- Long sentences.")).toBe(id);
    const m = brain.memories().filter((x) => x.title === STYLE_TITLE);
    expect(m).toHaveLength(1);
    expect(m[0]!.body).toBe("- Long sentences.");
    expect(m[0]!.kind).toBe("Preference");
  });
});

describe("what was learned is saved without asking, private topics wait", () => {
  it("links the page it came from and extends a memory with a similar title", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    const page = createPage(store, { title: "Ideas" });
    const id = brain.saveLearned({ title: "Project Based", kind: "Work", body: "Building a notes app.", sensitive: false }, page);
    expect(brain.saveLearned({ title: "Project Based", kind: "Work", body: "Wants it to replace Notion.", sensitive: false }, page)).toBe(id);
    const m = brain.activeMemories().find((x) => x.id === id)!;
    expect(m.body).toContain("Building a notes app.");
    expect(m.body).toContain("Wants it to replace Notion.");
    expect(m.body).toContain(`Learned from: [Ideas](based://page/${page})`);
  });

  it("puts sensitive facts into “To review”, where they don't count yet", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    const page = createPage(store, { title: "Journal" });
    const id = brain.saveLearned({ title: "Health", kind: "Profile", body: "Sees a doctor monthly.", sensitive: true }, page);
    expect(brain.memories().find((m) => m.id === id)!.status).toBe("To review");
    expect(brain.activeMemories()).toHaveLength(0);
    // Eine Quelle, die es nicht (mehr) gibt, verhindert das Merken nicht.
    expect(brain.saveLearned({ title: "Money", kind: "Profile", body: "Has a loan.", sensitive: true }, "missing")).toBeTruthy();
  });

  it("can be forgotten as a whole – what the user saved stays", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    const page = createPage(store, { title: "Ideas" });
    const own = brain.saveMemory({ title: "Role", kind: "Profile", body: "Founder." });
    brain.saveLearned({ title: "Project Based", kind: "Work", body: "Building a notes app.", sensitive: false }, page);
    brain.saveLearned({ title: "Health", kind: "Profile", body: "Sees a doctor monthly.", sensitive: true }, page);
    brain.setStyle("- Short.");
    expect(brain.learnedMemories()).toHaveLength(3);
    expect(brain.forgetLearned()).toBe(3);
    expect(brain.memories().map((m) => m.id)).toEqual([own]);
    expect(brain.forgetLearned()).toBe(0);
  });
});

describe("personal context for writing", () => {
  const mem = (title: string, kind: MemoryRecord["kind"], body: string): MemoryRecord => ({ id: title, title, kind, body });
  const memories = [
    mem(STYLE_TITLE, "Preference", "- Short, direct sentences.\n- German."),
    mem("Project Based", "Work", "A notes app that should replace Notion.\n\nLearned from: [Ideas](based://page/p1)"),
    mem("Anna", "People", "Designs the website."),
    mem("Role", "Profile", "Solo founder."),
  ];

  it("is empty when nothing is known", () => {
    expect(personalContext({ about: "## Role\n\n## Current work\n", memories: [], query: "write a mail" })).toBe("");
  });

  it("carries the voice, the profile and what matches the request – without link lines", () => {
    const c = personalContext({ about: "## Role\nFounder of Based", memories, query: "Write a short update about Based for the website" });
    expect(c).toContain("How the user writes");
    expect(c).toContain("- Short, direct sentences.");
    expect(c).toContain("Founder of Based");
    expect(c).toContain("- Project Based: A notes app that should replace Notion.");
    expect(c).toContain("- Anna: Designs the website.");
    expect(c).toContain("- Role: Solo founder.");
    expect(c).not.toContain("Learned from:");
    expect(c.length).toBeLessThanOrEqual(2400);
  });

  it("ranks by shared words and returns nothing for an unrelated request", () => {
    expect(relevantMemories(memories, "Based").map((m) => m.title)).toEqual(["Project Based"]);
    expect(relevantMemories(memories, "the and of")).toEqual([]);
  });
});
