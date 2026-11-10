// BSD-245: Plan-Modus und Pfad-Regeln (Claude-Code-Stil) – reine Auswertung, Engine-Verhalten, Plan ausführen.
import { createPage, createTeamspace, MemoryPersistence, WorkspaceStore } from "@based/core";
import { describe, expect, it } from "vitest";
import {
  executeTool, ModelEngine, pagePathCandidates, parseLayer, parseMode, pathGlobMatch, Permissions, PLAN_MODE_PROMPT, PLANNED_RESULT, plannedSteps,
  PlanRecorder, runPlan, runTurn, targetPage, WorkspaceTools, type ChatEvent, type ToolHost, type ToolPolicy,
} from "../src/index.js";
import { collect, ScriptedProvider } from "./helpers.js";

const never = new AbortController().signal;

describe("Pfad-Muster", () => {
  it("** über Abschnitte, * in einem Abschnitt, ohne Groß/Klein, Ordner selbst zählt", () => {
    expect(pathGlobMatch("Privat/**", "Privat")).toBe(true);
    expect(pathGlobMatch("Privat/**", "privat/Tagebuch/2026")).toBe(true);
    expect(pathGlobMatch("Privat/**", "Privatsache/x")).toBe(false);
    expect(pathGlobMatch("Projekte/*", "Projekte/Alpha")).toBe(true);
    expect(pathGlobMatch("Projekte/*", "Projekte/Alpha/Notizen")).toBe(false);
    expect(pathGlobMatch("**/Notizen", "Projekte/Alpha/Notizen")).toBe(true);
    expect(pathGlobMatch("**/Notizen", "Notizen")).toBe(true);
    expect(pathGlobMatch("/Projekte/A?pha/", "Projekte/Alpha")).toBe(true);
    expect(pathGlobMatch("Pro(jekte)/**", "Pro(jekte)/x")).toBe(true);
  });

  it("Regeln mit path: – Vorrang deny > ask > allow, Grund nennt die spezifischste Regel, Projekt-Schicht", () => {
    const global = Permissions.from("allow based.*(path:Projekte/**)\ndeny based.*(path:Privat/**)\nask based.create_page(path:Projekte/Kunden/**)", "askEdits");
    const call = (tool: string, path: string) => ({ tool, paths: [path] });
    expect(global.decide(call("based.append_markdown", "Projekte/Alpha"), true)).toEqual({ effect: "allow", reason: "rule “allow based.*(path:Projekte/**)”" });
    expect(global.decide(call("based.append_markdown", "Privat/Tagebuch"), true).effect).toBe("deny");
    expect(global.decide(call("based.read_page", "Privat/Tagebuch"), false).effect).toBe("deny");
    expect(global.decide(call("based.create_page", "Projekte/Kunden/ACME"), true)).toEqual({ effect: "ask", reason: "rule “ask based.create_page(path:Projekte/Kunden/**)”" });
    // Ohne Pfad (unbekannte Seite) greifen Pfad-Regeln nicht: Modus entscheidet.
    expect(global.decide({ tool: "based.append_markdown" }, true).effect).toBe("ask");
    // Projekt-Schicht: zusätzliche deny-Regel schlägt die globale allow-Regel.
    const project = global.layered("deny based.replace_page_content(path:Projekte/Alpha/**)");
    expect(project.decide(call("based.replace_page_content", "Projekte/Alpha/Plan"), true).effect).toBe("deny");
    expect(project.decide(call("based.replace_page_content", "Projekte/Beta"), true).effect).toBe("allow");
    // Bereich davor: „Private/…“ trifft über den zweiten Pfad-Kandidaten.
    const sec = Permissions.from("deny based.*(path:Private/**)");
    expect(sec.decide({ tool: "based.read_page", paths: ["Tagebuch", "Private/Tagebuch"] }, false).effect).toBe("deny");
  });

  it("Seitenpfade aus dem Store: Titel der Vorfahren, mit und ohne Bereich; Teamspace-Name", () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence([]), node: "t" });
    const privat = createPage(store, { title: "Privat" });
    const tagebuch = createPage(store, { title: "Tagebuch", parent: privat });
    const ts = createTeamspace(store, "Firma");
    const proj = createPage(store, { title: "Projekte", section: { kind: "teamspace", id: ts } });
    const slash = createPage(store, { title: "A/B", parent: proj });
    expect(pagePathCandidates(store, tagebuch)).toEqual(["Privat/Tagebuch", "Private/Privat/Tagebuch"]);
    expect(pagePathCandidates(store, slash)).toEqual(["Projekte/A∕B", "Firma/Projekte/A∕B"]);
    expect(pagePathCandidates(store, "gibt-es-nicht")).toEqual([]);
    expect(targetPage({ parent_id: privat, title: "x" })).toBe(privat);
    expect(targetPage({ page_id: tagebuch })).toBe(tagebuch);
  });

  it("Modus „plan“ lesen und schreiben (Text und Claude-Code-JSON)", () => {
    expect(parseMode("Plan")).toBe("plan");
    expect(parseMode("plan mode")).toBe("plan");
    expect(parseLayer("mode plan\ndeny based.*(path:Privat/**)").mode).toBe("plan");
    expect(parseLayer('{"permissions":{"defaultMode":"plan","deny":["based.*(path:Privat/**)"]}}')).toMatchObject({ mode: "plan", rules: [{ effect: "deny", tool: "based.*", pattern: "path:Privat/**" }] });
    expect(Permissions.from("", "plan").decide({ tool: "based.create_page" }, true).effect).toBe("deny");
    expect(Permissions.from("", "plan").decide({ tool: "based.search" }, false).effect).toBe("allow");
  });
});

function fakeHost(calls: string[]): ToolHost {
  return {
    specs: [{ name: "search", description: "s", inputSchema: {} }, { name: "create_page", description: "c", inputSchema: {} }],
    isWrite: (n) => n === "create_page",
    call: async (name, input) => {
      calls.push(name + JSON.stringify(input));
      return { text: name + " ok", isError: false };
    },
  };
}

describe("Plan-Modus in der Engine", () => {
  it("Lesen läuft, Schreiben wird gesammelt statt ausgeführt; System-Prompt sagt es dem Modell", async () => {
    const calls: string[] = [];
    const plan = new PlanRecorder();
    const p = new ScriptedProvider([
      { text: "", calls: [{ id: "a", name: "search", arguments: { query: "x" } }, { id: "b", name: "create_page", arguments: { title: "Neu" } }], stop: "tool_use" },
      { text: "1. Seite „Neu“ anlegen", stop: "end_turn" },
    ]);
    const engine = new ModelEngine({ provider: p, model: "m", tools: fakeHost(calls), policy: { mode: "plan", onPlanned: plan.record } });
    const events = await collect(runTurn(engine, { prompt: "plane" }, never));
    expect(calls).toEqual(['search{"query":"x"}']);
    expect(plan.steps).toEqual([{ name: "create_page", arguments: { title: "Neu" } }]);
    expect(p.seen[0]![0]!.content).toContain(PLAN_MODE_PROMPT);
    const results = events.filter((e): e is Extract<ChatEvent, { type: "toolResult" }> => e.type === "toolResult");
    expect(results.map((r) => [r.output, r.isError])).toEqual([["search ok", false], [PLANNED_RESULT, false]]);
    // Aus dem gespeicherten Turn lassen sich die Schritte wieder lesen.
    expect(plannedSteps(events, PLANNED_RESULT)).toEqual(plan.steps);
  });

  it("deny-Regel bleibt im Plan-Modus ein Fehler (wird nicht als Schritt gesammelt)", async () => {
    const plan = new PlanRecorder();
    const policy: ToolPolicy = { mode: "plan", rules: async () => "deny" as const, onPlanned: plan.record };
    const r = await executeTool(fakeHost([]), { id: "x", name: "create_page", arguments: {} }, policy, never, () => {});
    expect(r.isError).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it("Plan ausführen: Schritte laufen nach der Freigabe, ask-Regeln gelten als beantwortet, deny blockiert", async () => {
    const calls: string[] = [];
    const events: ChatEvent[] = [];
    const steps = [{ name: "create_page", arguments: { title: "A" } }, { name: "create_page", arguments: { title: "Privat" } }, { name: "create_page", arguments: { title: "B" } }];
    let n = 0;
    const out = await runPlan(fakeHost(calls), steps, { rules: (c) => ((c.arguments as { title: string }).title === "Privat" ? "deny" : "ask") }, never, (e) => events.push(e), () => `s${++n}`);
    expect(calls).toEqual(['create_page{"title":"A"}', 'create_page{"title":"B"}']);
    expect(out.map((x) => x.result.isError)).toEqual([false, true, false]);
    expect(events.map((e) => e.type)).toEqual(["toolUse", "toolResult", "toolUse", "toolResult", "toolUse", "toolResult"]);
  });

  it("mit echten Workspace-Werkzeugen: Pfad-Regel verweigert das Schreiben unter „Privat“", async () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence([]), node: "t" });
    const privat = createPage(store, { title: "Privat" });
    const offen = createPage(store, { title: "Offen" });
    const tools = new WorkspaceTools(store);
    const perms = Permissions.from("deny based.*(path:Privat/**)", "free");
    const policy: ToolPolicy = {
      mode: perms.mode,
      rules: (c) => {
        const t = targetPage(c.arguments);
        return perms.ruleVerdict({ tool: "based." + c.name, paths: t ? pagePathCandidates(store, t) : undefined })?.effect;
      },
    };
    const denied = await executeTool(tools, { id: "1", name: "create_page", arguments: { title: "Geheim", parent_id: privat } }, policy, never, () => {});
    expect(denied).toEqual({ text: "A permission rule blocks this action.", isError: true });
    const ok = await executeTool(tools, { id: "2", name: "create_page", arguments: { title: "Sichtbar", parent_id: offen } }, policy, never, () => {});
    expect(ok.isError).toBe(false);
    expect(store.children("b:" + privat)).toEqual([]);
    expect(store.children("b:" + offen)).toHaveLength(1);
  });
});
