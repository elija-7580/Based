// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Kurze Werkzeugliste (docs/mcp.md „Token“): Ein Client lädt die Liste aller Werkzeuge in jedes Gespräch. Based hat
// rund 70; ihre Beschreibungen und Schemas kosten ~10.000 Token, bevor ein Agent etwas getan hat. In der kurzen
// Liste stehen deshalb nur die Kernwerkzeuge (`core`) und zwei Zugänge zum Rest:
//   more_tools  – was es sonst gibt (nach Bereich oder Stichwort), auf Wunsch mit Schema
//   run_tool    – eines davon aufrufen
// Dasselbe Muster wie Anthropics Tool Search (`defer_loading`) und GitHubs „dynamic toolsets“, nur ohne dass der
// Client etwas können muss. Rechte und Rückfragen gelten für das gemeinte Werkzeug, nicht für `run_tool`: der Host
// packt den Aufruf mit `unwrap` aus, bevor er prüft.
import type { JSONValue } from "@based/core";
import { ToolError, type ToolDef, type ToolGroup } from "./base.js";

export const MORE_TOOLS = "more_tools";
export const RUN_TOOL = "run_tool";

const GROUP_TITLES: Record<ToolGroup, string> = {
  pages: "Pages, workspace, trash, history, meetings, sharing", blocks: "Page editor", boards: "Whiteboards", files: "Files, export",
  databases: "Databases", brain: "Agent Brain (memory, skills)", agents: "Agents, runs, projects, schedules",
};

const firstSentence = (s: string) => {
  const line = s.split("\n")[0]!;
  const m = /^(.*?[.!?])(\s|$)/.exec(line);
  return (m ? m[1]! : line).slice(0, 160);
};

/** `run_tool {name, args}` → gemeintes Werkzeug; alles andere unverändert. */
export function unwrap(name: string, input: JSONValue): { name: string; input: JSONValue } {
  if (name !== RUN_TOOL) return { name, input };
  const a = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, JSONValue>;
  const inner = typeof a.name === "string" ? a.name : "";
  if (inner === RUN_TOOL || inner === MORE_TOOLS) return { name: MORE_TOOLS, input: {} };
  let args: JSONValue = a.args ?? {};
  // Manche Clients schicken die Argumente als JSON-Text.
  if (typeof args === "string") { try { args = (JSON.parse(args) as JSONValue) ?? {}; } catch { /* das Werkzeug meldet es */ } }
  return { name: inner, input: args };
}

/** Die zwei Zugänge und welche Werkzeuge in der kurzen Liste stehen. */
export function gatewayTools(all: () => readonly ToolDef[]): ToolDef[] {
  const extended = () => all().filter((d) => !d.core && d.spec.name !== MORE_TOOLS && d.spec.name !== RUN_TOOL);
  return [
    {
      group: "pages", write: false, core: true,
      spec: {
        name: MORE_TOOLS,
        description: "Based has many more tools than this list shows (database schema and views, whiteboards, trash, history, meetings, export, sharing, projects, schedules …). Without arguments: all of them by area, one line each. `query`: only matching ones. `names`: their full descriptions and argument schemas. Call them with run_tool.",
        inputSchema: { type: "object", additionalProperties: false, required: [], properties: { query: { type: "string", description: "Words to look for" }, names: { type: "array", items: { type: "string" }, description: "Tools to describe in full" } } },
      },
      run: (a) => {
        const defs = extended();
        const names = Array.isArray(a.names) ? (a.names as string[]) : [];
        if (names.length) {
          return names.map((n) => {
            const d = all().find((x) => x.spec.name === n);
            if (!d) return `${n}: no such tool.`;
            return `## ${d.spec.name}${d.write ? (d.destructive ? " (writes, can discard data)" : " (writes)") : ""}\n${d.spec.description}\nArguments: ${JSON.stringify((d.spec.inputSchema as { properties?: unknown }).properties ?? {})}${((d.spec.inputSchema as { required?: string[] }).required ?? []).length ? `\nRequired: ${(d.spec.inputSchema as { required: string[] }).required.join(", ")}` : ""}`;
          }).join("\n\n");
        }
        const words = typeof a.query === "string" ? a.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
        const hit = (d: ToolDef) => words.length === 0 || words.some((w) => d.spec.name.includes(w) || d.spec.description.toLowerCase().includes(w));
        const found = defs.filter(hit);
        if (found.length === 0) return `No tool matches “${a.query as string}”. Call more_tools without arguments to see all.`;
        const out: string[] = [];
        for (const g of Object.keys(GROUP_TITLES) as ToolGroup[]) {
          const mine = found.filter((d) => d.group === g);
          if (mine.length === 0) continue;
          out.push(`${GROUP_TITLES[g]}:`, ...mine.map((d) => `- ${d.spec.name}: ${firstSentence(d.spec.description)}`));
        }
        out.push("", "Full description and arguments: more_tools {names: […]}. Call: run_tool {name, args}.");
        return out.join("\n");
      },
    },
    {
      group: "pages", write: true, core: true,
      spec: {
        name: RUN_TOOL,
        description: "Call a tool that more_tools lists. Read its arguments with more_tools {names: [name]} first.",
        inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" }, args: { type: "object", description: "The tool's arguments" } } },
      },
      // Der Host packt aus (`unwrap`), bevor er Rechte prüft; hier kommt nur an, wer das nicht getan hat.
      run: () => { throw new ToolError("run_tool has to be unwrapped by the host before it runs."); },
    },
  ];
}
