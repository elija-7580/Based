// BSD-410: Golden Fixtures Agent Brain – LineDiff, Zitate (Teil 1), Kontextbudget (Teil 2). Die Fälle in
// fixtures/agents/linediff.json, citations.json und context.json erzeugt der Swift-Export (legacy/Swift/BasedBrain/Tests/BasedBrainTests/AgentFixtureExport.swift);
// dieser Runner spielt sie gegen den TS-Port ab. Bewusste Abweichungen stehen in DEVIATIONS (mit Grund und dem, was
// TS stattdessen liefert); jeder andere Unterschied ist ein Fehler.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { citationMarkers, compactionNotice, ContextBudget, lineCounts, lineOps, parseUnified, renderCitations, streamingSafe, unifiedDiff, type ChatMessage, type Citation } from "../src/index.js";

interface Case<I = Record<string, unknown>, O = Record<string, unknown>> { name: string; input: I; output: O }
const load = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/agents/${f}`, import.meta.url)), "utf8")) as { module: string; cases: Case[] };

/** Bewusste Abweichungen: Fallname → warum und was TS liefert. */
const DEVIATIONS: Record<string, { why: string; output: Record<string, unknown> }> = {
  "tokens: Emoji mit Hautfarbe": {
    why: "Swift zählt Grapheme (3), TS die UTF-16-Länge (12) – TS schätzt so eher zu viel, das Kontextfenster läuft nie über.",
    output: { tokens: 4 },
  },
  "LineDiff: CRLF bleibt in der Zeile": {
    why: "Swift zählt \"\\r\\n\" als ein Zeichen und trennt CRLF-Text gar nicht (ganze Datei = eine Zeile); TS trennt an \\n, \\r bleibt am Zeilenende – ein Diff von Windows-Dateien zeigt so die geänderte Zeile.",
    output: {"ops": [["same", "a\r"], ["removed", "b"], ["added", "c"]], "added": 1, "removed": 1, "unified": "@@ -1,2 +1,2 @@\n a\r\n-b\n+c", "parsed": [{"kind": "hunk", "text": "@@ -1,2 +1,2 @@"}, {"kind": "same", "old": 1, "new": 1, "text": "a\r"}, {"kind": "removed", "old": 2, "text": "b"}, {"kind": "added", "new": 2, "text": "c"}]},
  },
  "render: Seite und Blöcke": {
    why: "TS escapt im Quellen-Titel auch „[“ (Swift nur „]“), sonst öffnet „[draft]“ in manchen Renderern einen zweiten Link.",
    output: {"markdown": "See[¹](based://page/p2),[²](based://page/p1?block=b2) and[³](based://page/p3?block=b3).\n\n**Sources**\n\n1. [Untitled](based://page/p2)\n2. [Budget 2027](based://page/p1?block=b2)\n3. [Notes \\[draft\\]](based://page/p3?block=b3) — Ship it", "citations": [{"pageID": "p2", "snippet": "", "title": "", "number": 1}, {"blockID": "b2", "pageID": "p1", "snippet": "", "title": "Budget 2027", "number": 2}, {"blockID": "b3", "pageID": "p3", "snippet": "Ship it", "title": "Notes [draft]", "number": 3}]},
  },
  "render: Titel mit ]": {
    why: "wie oben: „[“ im Titel escapt.",
    output: {"markdown": "From notes[¹](based://page/p3?block=b3).\n\n**Sources**\n\n1. [Notes \\[draft\\]](based://page/p3?block=b3) — Ship it", "citations": [{"blockID": "b3", "pageID": "p3", "snippet": "Ship it", "title": "Notes [draft]", "number": 1}]},
  },
};

const report = new Map<string, { green: number; deviating: number; total: number }>();
const tally = (module: string, deviating: boolean) => {
  const r = report.get(module) ?? { green: 0, deviating: 0, total: 0 };
  r.total += 1;
  if (deviating) r.deviating += 1; else r.green += 1;
  report.set(module, r);
};
afterAll(() => {
  for (const [m, r] of report) console.info(`${m}: ${r.green}/${r.total} grün${r.deviating ? ` (${r.deviating} bewusst abweichend)` : ""}`);
});

function check(module: string, c: Case, actual: Record<string, unknown>) {
  const dev = DEVIATIONS[c.name];
  if (dev) {
    expect(actual, dev.why).toEqual(dev.output);
    expect(actual, "Abweichung ist keine mehr – aus DEVIATIONS streichen").not.toEqual(c.output);
  } else expect(actual).toEqual(c.output);
  tally(module, dev !== undefined);
}

describe("fixtures/agents/linediff.json", () => {
  const file = load("linediff.json");
  for (const c of file.cases) {
    it(c.name, () => {
      const i = c.input as { old?: string; new?: string; context?: number; firstLine?: number; oldGen?: [string, number]; newGen?: [string, number] };
      if (i.oldGen && i.newGen) {
        const gen = ([p, n]: [string, number]) => Array.from({ length: n }, (_, k) => p + k).join("\n");
        const ops = lineOps(gen(i.oldGen), gen(i.newGen));
        const counts = lineCounts(ops);
        check(file.module, c, { firstOps: ops.slice(0, 3), count: ops.length, added: counts.added, removed: counts.removed });
        return;
      }
      const ops = lineOps(i.old!, i.new!);
      const counts = lineCounts(ops);
      const unified = unifiedDiff(i.old!, i.new!, i.context, i.firstLine);
      check(file.module, c, { ops, added: counts.added, removed: counts.removed, unified, parsed: parseUnified(unified) });
    });
  }
});

/** Swift-Link (PageLink.url + ?block=) – TS nimmt in der App `based-cite:`, das Format ist austauschbar. */
const swiftLink = (page: string, block?: string) => `based://page/${page}${block ? `?block=${block}` : ""}`;

describe("fixtures/agents/citations.json", () => {
  const file = load("citations.json");
  for (const c of file.cases) {
    it(c.name, () => {
      const i = c.input as { kind: string; text: string; streaming?: boolean; known?: Record<string, Citation> };
      if (i.kind === "markers") return check(file.module, c, { markers: citationMarkers(i.text).map((m) => [m.kind, m.id]) });
      if (i.kind === "streamingSafe") return check(file.module, c, { text: streamingSafe(i.text) });
      const known = i.known ?? {};
      const r = renderCitations(i.text, (kind, id) => {
        const k = known[`${kind}:${id}`];
        if (!k) return undefined;
        const { number: _n, ...rest } = k;
        return rest;
      }, { streaming: i.streaming === true, link: swiftLink });
      check(file.module, c, { markdown: r.markdown, citations: r.citations });
    });
  }
});

describe("fixtures/agents/context.json", () => {
  const file = load("context.json");
  for (const c of file.cases) {
    it(c.name, async () => {
      const i = c.input as { kind: string; model?: string; text?: string; window?: number; messages?: ChatMessage[]; summarize?: boolean; force?: boolean };
      if (i.kind === "window") return check(file.module, c, { window: ContextBudget.windowFor(i.model!) });
      if (i.kind === "tokens") return check(file.module, c, { tokens: ContextBudget.tokensOfText(i.text!) });
      const budget = new ContextBudget(i.window!);
      const summarizer = i.summarize ? async (text: string) => `SUMMARY of ${[...new Intl.Segmenter().segment(text)].length} chars` : undefined;
      const { messages, report } = await budget.fit(i.messages!, summarizer, i.force === true);
      const r: Record<string, unknown> = { before: report.before, after: report.after, shortenedToolResults: report.shortenedToolResults,
        summarizedMessages: report.summarizedMessages, droppedMessages: report.droppedMessages, shortenedMessages: report.shortenedMessages };
      if (report.summary !== undefined) r.summary = report.summary;
      const notice = compactionNotice(report);
      if (notice) r.notice = notice;
      check(file.module, c, { messages: messages.map((m) => ({ role: m.role, content: m.content })), report: r });
    });
  }
});
