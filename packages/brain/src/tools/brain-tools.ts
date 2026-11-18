// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Agent Brain (BSD-541): Abruf mit Relationen, Profil, Skills, Tatsachen merken. Alles liegt in gewöhnlichen Seiten.
import { MEMORY_KINDS, looksSensitive } from "../memory/suggestions.js";
import { Recall } from "../recall/recall.js";
import { needStr, obj, optStr, pageID, str, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";

export function brainTools(ctx: ToolCtx): ToolDef[] {
  return [
    {
      group: "brain", write: false,
      spec: {
        name: "recall",
        description:
          "Context in one call – use this first. Returns what Based remembers about the user (memories), matching pages and rows with a passage and block id, " +
          "each hit's neighbours by kind of link (relation column, mentions, parent), and pages that connect several hits. Whole questions work; typos are fine. " +
          "`about`: a page id to stay around that page (empty query = just its surroundings).",
        inputSchema: obj({ query: str("What you need to know; may be empty together with `about`"), about: str("Page id to search around"), limit: { type: "integer", minimum: 1, maximum: 30, description: "Max pages (default 8)" } }, []),
      },
      run: async (a) => {
        const query = optStr(a, "query") ?? "";
        const about = optStr(a, "about");
        if (about !== undefined) ctx.page(about, true);
        if (!query.trim() && about === undefined) throw new ToolError("Give a query, or `about` with a page id.");
        return Recall.format(await ctx.recall().run(query, { about, limit: typeof a.limit === "number" ? a.limit : undefined }));
      },
    },
    {
      group: "brain", write: false,
      spec: {
        name: "related",
        description: "A page's neighbours with ids, grouped by kind of link: database relations (with the column name, both directions), mentions and backlinks, parent, sub-pages.",
        inputSchema: obj({ id: pageID, limit: { type: "integer", minimum: 1, maximum: 100, description: "Max per kind (default 20)" } }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        ctx.page(id, true);
        const groups = new Map<string, string[]>();
        for (const nb of ctx.graph().neighbors(id, typeof a.limit === "number" ? a.limit : 20)) {
          const key = nb.kind === "relation" ? (nb.out ? `Relation “${nb.label ?? "related"}”` : `Related from (“${nb.label ?? "related"}”)`) : nb.kind === "mention" ? (nb.out ? "Mentions" : "Mentioned by") : nb.kind === "parent" ? "In" : "Sub-pages";
          const list = groups.get(key) ?? [];
          list.push(ctx.line(nb.id));
          groups.set(key, list);
        }
        if (groups.size === 0) return "No connections.";
        return [...groups].map(([k, lines]) => `${k}:\n${lines.join("\n")}`).join("\n\n");
      },
    },
    {
      group: "brain", write: false,
      spec: { name: "about_me", description: "The user's profile (“About me” in the Agent Brain) and their standing preferences. Read it once at the start of a task that depends on who the user is.", inputSchema: obj({}) },
      run: () => {
        const brain = ctx.brain();
        // Die Vorlage („## Role“ …) ohne eigenen Text ist kein Profil.
        const raw = brain.about().trim();
        const about = raw.split("\n").some((l) => l.trim() && !/^#{1,6}\s/.test(l.trim())) ? raw : "";
        const prefs = brain.activeMemories().filter((m) => m.kind === "Profile" || m.kind === "Preference").slice(0, 25);
        const out = [about ? `# About me\n${about}` : "", prefs.length ? `# Profile and preferences\n${prefs.map((m) => `- ${m.title} (${m.kind}; id: ${m.id})`).join("\n")}` : ""].filter(Boolean).join("\n\n");
        return out || "Nothing saved about the user yet.";
      },
    },
    {
      group: "brain", write: false,
      spec: { name: "list_skills", description: "The user's skills (reusable instructions) that are switched on, with their descriptions. Load one with `load_skill` before following it.", inputSchema: obj({}) },
      run: () => {
        const skills = ctx.brain().skills(true);
        return skills.length ? skills.map((sk) => `- ${sk.name}${sk.description ? ` — ${sk.description}` : ""}`).join("\n") : "No skills yet.";
      },
    },
    {
      group: "brain", write: false,
      spec: { name: "load_skill", description: "The full instructions of one skill, by name.", inputSchema: obj({ name: { type: "string", minLength: 1 } }, ["name"]) },
      run: (a) => {
        const name = needStr(a, "name");
        const sk = ctx.brain().skillByName(name);
        if (!sk || !sk.enabled) throw new ToolError(`No skill named “${name}”. Skills: ${ctx.brain().skills(true).map((x) => x.name).join(", ") || "(none)"}`);
        return `# Skill: ${sk.name}\n${sk.description}\n\n${sk.body}`;
      },
    },
    {
      group: "brain", write: true,
      spec: {
        name: "remember",
        description:
          "Save one durable fact about the user, their projects or people as a memory (one sentence that makes sense on its own). Call `recall` first. " +
          "The same fact is never stored twice. If a fact changed, pass the old memory's id as `replaces`. Private facts (health, money) wait for the user's review.",
        inputSchema: obj({
          fact: { type: "string", minLength: 1, maxLength: 2000 },
          type: { type: "string", enum: [...MEMORY_KINDS], description: "Profile, Preference, Work, People or Notes (default Notes)" },
          about: { type: "array", maxItems: 10, items: { type: "string" }, description: "Ids of the pages this fact concerns (person, project, topic)" },
          source: str("Id of the page the fact comes from"),
          replaces: str("Id of the memory this one supersedes"),
          detail: { type: "string", maxLength: 4000, description: "More context as Markdown" },
        }, ["fact"]),
      },
      run: (a) => {
        const fact = needStr(a, "fact");
        const detail = optStr(a, "detail");
        const replaces = optStr(a, "replaces");
        const r = ctx.brain().remember({
          fact, kind: optStr(a, "type") as (typeof MEMORY_KINDS)[number] | undefined, about: Array.isArray(a.about) ? (a.about as string[]) : undefined, source: optStr(a, "source"), replaces, detail,
          review: looksSensitive(`${fact} ${detail ?? ""}`),
        });
        if (r.outcome === "duplicate") return `Already remembered: “${r.title}” (id: ${r.id}). Nothing added.`;
        if (r.outcome === "linked") return `Already remembered: “${r.title}” (id: ${r.id}). Added the new links.`;
        return `Remembered (id: ${r.id})${r.status === "To review" ? " as “To review”: it looks private, so it only counts once the user sets it to Active in Based" : ""}${replaces ? `; the old memory is now Superseded` : ""}.`;
      },
    },
  ];
}
