import { createPage, deleteForever, plainText, trashPages, type WorkspaceStore } from "@based/core";
import { describe, expect, it } from "vitest";
import {
  AgentBrain, BrainTools, chunkTexts, citationMarkers, citationTarget, combineToolHosts, deletableIDs, encodeSkill, LocalSemanticIndex, memorySuggestionsOf,
  parseMemorySuggestions, renderCitations, similarTitles, streamingSafe, WorkspaceTools, looksSensitive,
} from "../src/index.js";
import { memoryStore } from "./helpers.js";

const enc = (s: string) => new TextEncoder().encode(s);

function pageWith(store: WorkspaceStore, title: string, md: string): string {
  const id = createPage(store, { title });
  const tools = new WorkspaceTools(store);
  if (md) tools.callSync("append_markdown", { page_id: id, markdown: md });
  return id;
}

describe("Agent Brain store (BSD-163)", () => {
  it("is created on demand with About me, Memories and Skills as real databases", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    expect(brain.exists).toBe(false);
    const ids = brain.ensure();
    expect(plainText(store.blocks.get(ids.root)!.text)).toBe("Agent Brain");
    expect(plainText(store.databases.get(ids.memoriesDB)!.title)).toBe("Memories");
    expect(store.databases.get(ids.skillsDB)!.properties.map((p) => p.name)).toEqual(["Name", "Description", "Enabled", "Frontmatter"]);
    expect(store.databases.get(ids.memoriesDB)!.properties.find((p) => p.name === "Type")!.options!.map((o) => o.name)).toEqual(["Profile", "Preference", "Work", "People", "Notes"]);
    expect(brain.about()).toContain("## Role");
    // Ein zweites Objekt findet denselben Brain (z. B. nach Neustart).
    expect(new AgentBrain(store).find()).toEqual(ids);
    expect(brain.ensure()).toEqual(ids);
  });

  it("can't be deleted: trash and delete-forever skip it, repair restores what got trashed anyway", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    const ids = brain.ensure();
    const other = createPage(store, { title: "Other" });
    const { allowed, refused } = deletableIDs(store, [ids.root, other, ids.about]);
    expect(allowed).toEqual([other]);
    expect(refused).toEqual([ids.root, ids.about]);
    // Trotzdem in den Papierkorb (älterer Client, Sync) → repair holt es zurück.
    trashPages(store, [ids.root]);
    expect(brain.repair()).toBe(true);
    expect(store.blocks.get(ids.root)!.trashedAt).toBeUndefined();
    expect(brain.repair()).toBe(false);
  });

  it("re-attaches a database whose block was deleted in the editor, keeping its rows", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    brain.saveSkill({ name: "Keep me", description: "d", body: "b" });
    const ids = brain.find()!;
    const host = store.databases.get(ids.skillsDB)!.blockID!;
    deleteForever(store, [host]); // entfernt Block, Ansichten und Datenbank-Record
    // Datenbank-Record ist mit weg → repair legt eine neue an (Zeilen des alten Records sind verloren, wie Swift).
    expect(brain.repair()).toBe(true);
    expect(brain.find()).toBeDefined();
    // Nur der Block weg (Editor), Record noch da → derselbe Record kommt zurück.
    const brain2 = new AgentBrain(store);
    brain2.saveSkill({ name: "Second", description: "d", body: "b" });
    const ids2 = brain2.find()!;
    const host2 = store.databases.get(ids2.skillsDB)!.blockID!;
    store.transact("Delete block", (tx) => tx.remove(`block:${host2}` as never));
    expect(brain2.find()).toBeUndefined();
    expect(brain2.repair()).toBe(true);
    expect(brain2.find()!.skillsDB).toBe(ids2.skillsDB);
    expect(brain2.skills().map((s) => s.name)).toEqual(["Second"]);
  });

  it("adopts a brain synced from the Mac app (by title)", () => {
    const store = memoryStore();
    const a = new AgentBrain(store).ensure();
    // Markierungen entfernen, als käme der Brain aus Swift.
    for (const id of [a.root, a.about, store.databases.get(a.memoriesDB)!.blockID!, store.databases.get(a.skillsDB)!.blockID!]) {
      store.transact("strip", (tx) => tx.update(id, (b) => { delete (b.props as Record<string, unknown>).brain; }));
    }
    expect(new AgentBrain(store).find()).toEqual(a);
  });

  it("skills: save, update by name, enable, import with files and export back", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    const s1 = brain.saveSkill({ name: "Weekly review", description: "Reflect on the week", body: "## Steps\n\n1. Wins\n2. Problems" });
    expect(s1.created).toBe(true);
    expect(brain.saveSkill({ name: "weekly review", description: "Reflect, plan", body: "Just do it." })).toEqual({ id: s1.id, created: false });
    expect(brain.skills()).toEqual([{ id: s1.id, name: "Weekly review", description: "Reflect, plan", enabled: true, body: "Just do it.", extraFrontmatter: "" }]);
    brain.setSkillEnabled(s1.id, false);
    expect(brain.skills(true)).toEqual([]);

    const folder = { name: "pdf", files: { "SKILL.md": enc("---\nname: pdf-forms\ndescription: Fill PDF forms\nlicense: MIT\n---\n\n# PDF\n\nRun the script.\n"), "scripts/fill.py": enc("print('fill')\n"), "logo.bin": new Uint8Array([0, 1, 2, 255]) } };
    const r = brain.importSkill(folder);
    expect(r).toMatchObject({ name: "pdf-forms", created: true, files: 2 });
    const out = brain.exportSkill(r.id)!;
    expect(out.name).toBe("pdf-forms");
    expect(new TextDecoder().decode(out.files["scripts/fill.py"])).toBe("print('fill')\n");
    expect([...out.files["logo.bin"]!]).toEqual([0, 1, 2, 255]);
    expect(new TextDecoder().decode(out.files["SKILL.md"])).toBe("---\nname: pdf-forms\ndescription: Fill PDF forms\nlicense: MIT\n---\n\n# PDF\n\nRun the script.\n");
    // Erneuter Import ersetzt, statt zu verdoppeln.
    expect(brain.importSkill(encodeSkill({ name: "pdf-forms", description: "Fill PDF forms v2", body: "New.", extraFrontmatter: "", files: { "scripts/fill.py": enc("v2") } })).created).toBe(false);
    expect(brain.skills().filter((s) => s.name === "pdf-forms")).toHaveLength(1);
    expect(new TextDecoder().decode(brain.exportSkill(r.id)!.files["scripts/fill.py"])).toBe("v2");
  });

  it("memories: saved only through saveMemory; similar title extends; People names for redaction", () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    expect(brain.memories()).toEqual([]);
    const id = brain.saveMemory({ title: "Writing style", kind: "Preference", body: "Short sentences." });
    expect(brain.saveMemory({ title: "writing style", kind: "Notes", body: "No emojis." })).toBe(id);
    brain.saveMemory({ title: "Anna Schmidt", kind: "People", body: "Designer, works on Based." });
    const mems = brain.memories();
    expect(mems.find((m) => m.id === id)).toMatchObject({ kind: "Preference", body: "Short sentences.\n\nNo emojis." });
    expect(brain.personNames()).toEqual(["Anna Schmidt"]);
  });
});

describe("memory suggestions", () => {
  const existing = [{ id: "m1", title: "Writing style", kind: "Preference" as const, body: "Short sentences." }];
  it("parses the model's JSON (fenced), maps similar titles to updates, drops known facts, caps at 3", () => {
    const answer = "```json\n" + JSON.stringify({ memories: [
      { title: "writing style", type: "preference", body: "Prefers no emojis." },
      { title: "Writing Style", type: "Preference", body: "Short sentences." },
      { title: "Project Based", type: "Work", body: "Builds a notes app." },
      { title: "Gesundheit", type: "Profile", body: "Hat eine Diagnose." },
      { title: "Coffee", type: "Preference", body: "Drinks espresso." },
      { title: "Extra", type: "Notes", body: "Too many." },
    ] }) + "\n```";
    const s = parseMemorySuggestions(answer, existing);
    expect(s.map((x) => x.title)).toEqual(["Writing style", "Project Based", "Gesundheit"]);
    expect(s[0]).toMatchObject({ updates: "m1", kind: "Preference" });
    expect(s[2]!.sensitive).toBe(true);
    expect(parseMemorySuggestions("nothing here", existing)).toEqual([]);
    expect(similarTitles("Project Based", "Based project")).toBe(true);
    expect(looksSensitive("my salary")).toBe(true);
  });

  it("folds suggestion and decision events from a transcript", () => {
    const s = { title: "Coffee", kind: "Preference" as const, body: "Espresso", sensitive: false };
    const folded = memorySuggestionsOf([
      { type: "memorySuggestion", id: "a", suggestion: s },
      { type: "memorySuggestion", id: "b", suggestion: { ...s, title: "Tea" } },
      { type: "memoryDecision", id: "a", decision: "saved", memoryID: "m9" },
      { type: "text" },
    ]);
    expect(folded).toEqual([{ id: "a", suggestion: s, state: "saved", memoryID: "m9" }, { id: "b", suggestion: { ...s, title: "Tea" }, state: "pending" }]);
  });
});

describe("citations (BSD-61)", () => {
  const resolve = (kind: "block" | "page", id: string) =>
    id === "gone" ? undefined : kind === "page" ? { pageID: id, title: "Plan", snippet: "" } : { pageID: "p1", blockID: id, title: "Notes [draft]", snippet: `text of ${id}` };

  it("numbers sources, reuses numbers, drops unknown ids, appends the list", () => {
    const r = renderCitations("Budget is 5k [[block:b1]]. Due Friday [[block:b2]] and again [[block:b1]]. Old [[block:gone]]. See [[page:p2]].", resolve);
    expect(r.citations.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(r.markdown).toBe(
      "Budget is 5k[¹](based-cite:p1/b1). Due Friday[²](based-cite:p1/b2) and again[¹](based-cite:p1/b1). Old. See[³](based-cite:p2).\n\n**Sources**\n\n" +
      "1. [Notes \\[draft\\]](based-cite:p1/b1) — text of b1\n2. [Notes \\[draft\\]](based-cite:p1/b2) — text of b2\n3. [Plan](based-cite:p2)",
    );
    expect(citationTarget("based-cite:p1/b1")).toEqual({ pageID: "p1", blockID: "b1" });
    expect(citationTarget("https://x")).toBeUndefined();
    expect(citationMarkers("a [[block:x]] [[page: y ]]")).toEqual([{ kind: "block", id: "x" }, { kind: "page", id: "y" }]);
  });

  it("hides a marker that is still streaming", () => {
    expect(streamingSafe("Answer [[blo")).toBe("Answer");
    expect(streamingSafe("Answer [[block:12ab")).toBe("Answer");
    expect(streamingSafe("Answer [[block:1]] done [")).toBe("Answer [[block:1]] done ");
    expect(streamingSafe("Array [[1, 2")).toBe("Array [[1, 2");
    expect(renderCitations("x [[block:b1]] y [[bl", resolve, { streaming: true }).markdown).toContain("y\n\n**Sources**");
  });
});

describe("local semantic index and brain tools", () => {
  it("finds pages by meaning (best section) and related pages", () => {
    const idx = new LocalSemanticIndex();
    idx.setPage("a", "Garden plan", ["Tomatoes and basil need sun. Water the tomatoes every morning."]);
    idx.setPage("b", "Tomato harvest", ["Harvest tomatoes when red; basil pesto recipe."]);
    idx.setPage("c", "Quarterly budget", ["Revenue, costs and the budget for Q4."]);
    expect(idx.search("watering tomato plants")[0]!.pageID).toBe("a");
    expect(idx.related("a").map((h) => h.pageID)).toEqual(["b"]);
    idx.removePage("b");
    expect(idx.related("a")).toEqual([]);
    expect(chunkTexts(["a".repeat(500), "b".repeat(500), "c"], 800)).toHaveLength(2);
  });

  it("BrainTools: load_skill, read_page_blocks with ids, combined with the workspace tools", async () => {
    const store = memoryStore();
    const brain = new AgentBrain(store);
    brain.saveSkill({ name: "Weekly review", description: "Reflect", body: "Do the review." });
    const page = pageWith(store, "Budget", "Budget is **5k**.\n\nDue Friday.");
    const idx = new LocalSemanticIndex();
    idx.setPage(page, "Budget", ["Budget is 5k. Due Friday."]);
    const tools = new BrainTools(store, brain, () => idx);
    expect(tools.call("load_skill", { name: "weekly review" }).text).toContain("Do the review.");
    expect(tools.call("load_skill", { name: "nope" })).toMatchObject({ isError: true });
    const read = tools.call("read_page_blocks", { page_id: page }).text;
    const blockIDs = [...read.matchAll(/\[block:([^\]]+)\]/g)].map((m) => m[1]);
    expect(blockIDs).toHaveLength(2);
    expect(read).toContain("Budget is **5k**.");
    expect(tools.call("semantic_search", { query: "when is it due" }).text).toContain(`id: ${page}`);
    const host = combineToolHosts(new WorkspaceTools(store), { specs: tools.specs, isWrite: () => false, call: async (n, i) => tools.call(n, i) });
    expect(host.specs.some((s) => s.name === "load_skill") && host.specs.some((s) => s.name === "create_page")).toBe(true);
    expect(host.isWrite("load_skill")).toBe(false);
    expect((await host.call("read_page", { page_id: page })).text).toContain("Due Friday");
  });
});
