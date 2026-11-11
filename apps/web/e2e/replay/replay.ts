// BSD-319: Ein Fehlerbericht („Problem melden“, ⇧⌘B) wird zum Test. Das Bündel (report.json aus
// ~/.config/based/reports/<id>/, siehe `based reports`) legt eine gleich gebaute Seite an, spielt die Aufzeichnung ab
// und liefert Endzustand und Layout zum Vergleich mit dem Zustand beim Melden.
//
//   import bundle from "./bundles/<name>.json" (oder readFileSync)
//   const r = await replayReport(page, bundle);
//   expect(r.doc).toEqual(r.expected);           // gleicher Endzustand wie beim Melden …
//   expect(r.issues).toEqual([]);                // … oder: der Fehler ist weg (Layout ohne Überdeckung)
//
// Modus „input“ (Standard) spielt Tasten, Eingaben, IME, Einfügen und Mausauswahl nach – damit fallen Fehler in der
// Eingabeverarbeitung auf. Modus „steps“ wendet die aufgezeichneten Editor-Schritte an (reproduziert den Endzustand
// auch, wenn Klicks auf Menüs dazwischen lagen).
import { expect, type Page } from "@playwright/test";
import { normalizeDoc, parseBugBundle, replayPlan, type BugBundle, type LayoutIssue, type ReplayPlan } from "@based/core";

type Hooks = {
  load(root: string, doc: unknown, sel: unknown): boolean;
  setSelection(root: string, sel: unknown): boolean;
  applySteps(root: string, steps: unknown[]): boolean;
  docJSON(root: string): unknown;
  roots(): string[];
  freeze(): { layout: unknown[]; state: { doc?: unknown } };
};
type W = { __basedReport: Hooks; __based: { client: { command(c: unknown): Promise<unknown> } } };

export interface ReplayResult {
  plan: ReplayPlan;
  /** Endzustand nach der Wiedergabe (ohne Block-IDs). */
  doc: unknown;
  /** Zustand beim Melden (ohne Block-IDs) – undefined, wenn das Bündel keinen hat. */
  expected: unknown;
  issues: LayoutIssue[];
}

/**
 * In welcher Engine ein Bündel wiedergegeben wird: in der, die es aufgezeichnet hat (Tastenbelegung wie Home/End und
 * ⌘/Strg folgt der Engine). Die Mac-App (WKWebView) und Safari → webkit, sonst chromium.
 */
export function engineOf(json: unknown): "webkit" | "chromium" {
  const ua = (json as { app?: { userAgent?: string } }).app?.userAgent ?? "";
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg/.test(ua) ? "webkit" : "chromium";
}

/** Bündel laden und wiedergeben. Erwartet eine geöffnete App (data-ready). */
export async function replayReport(page: Page, json: unknown, opts: { mode?: "input" | "steps" } = {}): Promise<ReplayResult> {
  const bundle = parseBugBundle(json) as BugBundle | undefined;
  if (!bundle) throw new Error("Not a Based problem report (format based-bug-report)");
  const plan = replayPlan(bundle, opts);
  await page.setViewportSize({ width: bundle.env.width, height: bundle.env.height });
  const id = (await page.evaluate(() => (globalThis as unknown as W).__based.client.command({ op: "createPage", title: "Replay" }))) as string;
  await page.goto(`/#page-${id}`);
  await expect.poll(() => page.evaluate((root) => (globalThis as unknown as W).__basedReport.roots().includes(root), id), { timeout: 15_000 }).toBe(true);
  expect(await page.evaluate(([root, doc, sel]) => (globalThis as unknown as W).__basedReport.load(root as string, doc, sel), [id, plan.start.doc, plan.start.sel] as const)).toBe(true);
  // Eine neue Seite setzt den Fokus ins Titelfeld – erst wenn das durch ist, die Schreibmarke in den Editor.
  // Nach dem Laden das Titelfeld verlassen (Escape/Blur), dann die Schreibmarke setzen und prüfen, dass sie bleibt.
  await page.getByLabel("Page title").waitFor();
  await page.waitForTimeout(500);
  await page.evaluate(([root, sel]) => (globalThis as unknown as W).__basedReport.setSelection(root as string, sel), [id, plan.start.sel] as const);
  await page.waitForTimeout(300);
  await page.evaluate(([root, sel]) => (globalThis as unknown as W).__basedReport.setSelection(root as string, sel), [id, plan.start.sel] as const);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
  for (const a of plan.actions) {
    switch (a.kind) {
      case "type": await page.keyboard.type(a.text); break;
      case "press": await page.keyboard.press(a.combo); break;
      case "insertText": await page.keyboard.insertText(a.text); break;
      case "select": await page.evaluate(([root, sel]) => (globalThis as unknown as W).__basedReport.setSelection(root as string, sel), [id, a.sel] as const); break;
      case "paste":
        await page.evaluate(({ plain, html }) => {
          const dt = new DataTransfer();
          if (plain) dt.setData("text/plain", plain);
          if (html) dt.setData("text/html", html);
          (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        }, { plain: a.plain, html: a.html });
        break;
      case "steps": await page.evaluate(([root, steps]) => (globalThis as unknown as W).__basedReport.applySteps(root as string, steps as unknown[]), [id, a.steps] as const); break;
    }
  }
  await page.waitForTimeout(300);
  const doc = await page.evaluate((root) => (globalThis as unknown as W).__basedReport.docJSON(root), id);
  const { layoutIssues } = await import("@based/core");
  const items = await page.evaluate(() => (globalThis as unknown as W).__basedReport.freeze().layout);
  return { plan, doc: normalizeDoc(doc), expected: plan.expected === undefined ? undefined : normalizeDoc(plan.expected), issues: layoutIssues(items as Parameters<typeof layoutIssues>[0]) };
}
