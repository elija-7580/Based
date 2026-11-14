import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


// BSD-226: Meeting-Notizen (/meet). Chromium nimmt mit Playwrights Fake-Mikrofon auf
// (--use-fake-device-for-media-stream); transkribiert wird mit dem festen Test-Transcriber, zusammengefasst mit einer
// ScriptedEngine (beides über globalThis.__basedMeeting). WebKit hat unter Playwright kein Fake-Mikrofon – dort läuft
// nur der Teil ohne Aufnahme (Block anlegen, Notizen, Neuladen). Screenshots mit BASED_SCREENSHOTS=1 (Chromium):
// docs/design/screens/web-meeting-light.png / -dark.png.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-meeting-"));
    const chromium = browserName === "chromium";
    const ctx = await playwright[browserName].launchPersistentContext(dir, {
      baseURL: baseURL!, viewport: { width: 1280, height: 900 },
      ...(chromium ? { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"], permissions: ["microphone"] } : {}),
    });
    // Screenshots: Theme „System“, damit emulateMedia hell/dunkel ohne Neuladen umschaltet (Aufnahme läuft weiter).
    if (SHOTS) {
      await ctx.addInitScript(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "system", style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false })));
    }
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

// BSD-407 Teil 5: Meeting-Block im Block-Editor (Standard) – Notizen und Zusammenfassung sind Blöcke des Editors
// (`.bx2-meet-doc [data-editable-id]`), Reiter aus @based/ui/astryx (role tab), Zeitmarken als Token (role button).

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

async function fresh(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const block = (page: Page) => page.getByTestId("meeting-block");
/** Zeitmarke (Token mit unsichtbarem Knopf) – der Knopf trägt die Zeit als Namen. */
const timeButton = (scope: ReturnType<Page["getByTestId"]>) => scope.getByTestId("meeting-time").getByRole("button").first();

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expectEditable(page);
}

async function newPageWithMeeting(page: Page, title: string) {
  await command(page, { op: "createPage", title });
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
  await openPage(page, title);
  await focusEditorEnd(page);
  await page.keyboard.type("/meet");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /Meeting notes/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(block(page)).toBeVisible();
  await expect(block(page).getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
  // Die Schreibmarke steht in der ersten Notiz
  await expect(block(page).locator(".bx2-meet-doc [data-editable-id]:focus")).toHaveCount(1);
}

/** Notiz in die Notizen des Meetings schreiben (letzte Notiz, ans Ende). */
async function typeNote(page: Page, text: string) {
  const note = block(page).locator(".bx2-meet-doc [data-editable-id]").last();
  await note.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

// Checkliste: Startfenster 1280 × 820 (ohne Größe im Namen), kleinstes Fenster 900 × 600, großes 1728 × 1000.
const SIZES = [{ w: 1280, h: 820, suffix: "" }, { w: 900, h: 600, suffix: "-900x600" }, { w: 1728, h: 1000, suffix: "-1728x1000" }] as const;

async function shots(page: Page, browserName: string, name: string) {
  if (!SHOTS || browserName !== "chromium") return;
  await page.getByLabel("Page title").click(); // Block nicht ausgewählt zeigen
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await block(page).scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../../docs/design/screens/web-meeting${name}${size.suffix}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await setTheme(page, "light");
}

const settled = (page: Page) => page.waitForTimeout(800);

test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => fresh(page));

test("/meet legt einen Meeting-Block an; Titel und Notizen bleiben nach dem Neuladen", async ({ page }) => {
  await newPageWithMeeting(page, "Planning");
  const title = block(page).getByLabel("Meeting title");
  await title.fill("Planning call");
  await title.press("Enter");
  await typeNote(page, "Agenda first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ship the release on Friday");
  await shots(page, test.info().project.name, "-notes");
  // Ohne KI: ehrlicher Hinweis statt Knopf; ohne Transcriber: Hinweis im Transkript-Tab.
  await block(page).getByRole("tab", { name: "Summary" }).click();
  await expect(block(page)).toContainText("Connect an AI under Settings");
  await block(page).getByRole("tab", { name: "Transcript" }).click();
  await expect(page.getByTestId("meeting-transcript-empty")).toContainText("Transcription isn't available in this app yet");
  await settled(page);

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Planning");
  await expect(block(page).getByLabel("Meeting title")).toHaveValue("Planning call");
  await expect(block(page).locator(".bx2-meet-doc")).toContainText("Agenda first");
  // Die Seite öffnet im Block-Editor (BSD-407 Teil 5: keine Ausnahme mehr für Meetings)
  await expect(blockEditor(page)).toBeVisible();
  await expect(page.locator(".bn-editor")).toHaveCount(0);
});

test("Aufnahme → Notiz mit Zeitstempel → Stop → Transkript → Zusammenfassung mit Zitat → Sprung; Neuladen", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright-WebKit hat kein Fake-Mikrofon (getUserMedia schlägt fehl); Aufnahme nur in Chromium geprüft.");
  await page.evaluate(() => {
    const m = (globalThis as unknown as { __basedMeeting: { useTranscriber(l: unknown): void; useSummaryScript(s: unknown): void } }).__basedMeeting;
    m.useTranscriber([
      { start: 0.2, end: 1.4, text: "Welcome everyone.", speaker: "me" },
      { start: 1.5, end: 3, text: "The release ships on Friday.", speaker: "others" },
    ]);
    m.useSummaryScript([{ text: "## Summary\nThe release ships on Friday [0:01].\n\n## Action items\n- [ ] Me: Prepare the release notes [0:01]" }]);
  });
  await newPageWithMeeting(page, "Weekly sync");
  await block(page).getByLabel("Meeting title").fill("Weekly sync call");
  await block(page).getByLabel("Meeting title").press("Enter");

  await block(page).getByRole("button", { name: "Start transcribing" }).click();
  await expect(block(page)).toHaveAttribute("data-recording", "true");
  await expect(block(page)).toHaveAttribute("data-status", "recording");
  await expect(block(page)).toContainText("Let everyone know this conversation is being recorded and transcribed");
  await expect(page.getByTestId("meeting-clock")).not.toHaveText("0:00", { timeout: 5000 });
  // BSD-281: laufende Aufnahme als Pille oben in der Seitenleiste
  await expect(page.getByTestId("recording-pill")).toContainText("Recording");

  await typeNote(page, "Ship on Friday");
  const stamped = page.getByTestId("meeting-stamped-notes");
  await expect(stamped).toContainText("Ship on Friday");
  const stampButton = timeButton(stamped);
  await expect(stamped.getByTestId("meeting-time").first()).toHaveText(/^0:0\d$/);
  await expect(stampButton).toBeDisabled(); // noch keine gespeicherte Aufnahme

  // Live-Transkript während der Aufnahme
  await page.waitForTimeout(2500);
  await block(page).getByRole("tab", { name: "Transcript" }).click();
  await expect(page.getByTestId("meeting-transcript")).toContainText("Welcome everyone.");
  await shots(page, browserName, "-recording");

  await block(page).getByRole("button", { name: "Stop" }).click();
  await expect(block(page)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  // BSD-418: Hänger-Breadcrumbs nennen Meeting-Aktionen mit festen Namen, nie Titel, Notizen oder Transkript
  type HangHooks = { __basedTest: { hangs: { hang(ms: number): void; hangs(): { breadcrumbs: string[] }[] } } };
  await page.evaluate(() => (globalThis as unknown as HangHooks).__basedTest.hangs.hang(400));
  let crumbs: string[] = [];
  await expect.poll(async () => {
    const all = await page.evaluate(() => (globalThis as unknown as HangHooks).__basedTest.hangs.hangs());
    crumbs = all.find((h) => h.breadcrumbs.at(-1) === "test hang 400")?.breadcrumbs ?? [];
    return crumbs.length > 0;
  }, { timeout: 8000 }).toBe(true);
  expect(crumbs).toContain("meeting stop");
  expect(crumbs.join("\n")).not.toMatch(/Weekly sync|Ship on Friday|Welcome everyone|release ships/);
  await expect(page.getByTestId("recording-pill")).toHaveCount(0);
  await expect(block(page)).not.toHaveAttribute("data-recording", "true");
  const transcript = page.getByTestId("meeting-transcript");
  await expect(transcript).toContainText("The release ships on Friday.");
  await expect(transcript.locator(".bx-meet-speaker").filter({ hasText: "Others" })).toBeVisible();
  await expect(block(page).locator(".bx-meet-legend").getByTestId("meeting-speaker").filter({ hasText: "Me" })).toBeVisible();

  // Klick auf eine Zeile spielt ab dieser Stelle
  await transcript.locator(".bx-meet-para").filter({ hasText: "The release ships" }).click();
  await expect(page.getByTestId("meeting-playback")).toHaveAttribute("data-from", "1.5");

  await block(page).getByRole("tab", { name: "Summary" }).click();
  await block(page).getByRole("button", { name: "Generate summary" }).click();
  const summary = page.getByTestId("meeting-summary");
  await expect(summary).toContainText("The release ships on Friday [0:01].");
  await expect(summary).toContainText("Based · from your recording");
  await expect(block(page)).toContainText("Written by Scripted");
  const cite = page.getByTestId("meeting-citations").getByRole("button", { name: "0:01" });
  await cite.click();
  await expect(page.getByTestId("meeting-playback")).toHaveAttribute("data-from", "1");
  await expect(page.getByTestId("meeting-playback")).toContainText("Playing");
  await block(page).getByRole("tab", { name: "Notes" }).click();
  await expect(timeButton(page.getByTestId("meeting-stamped-notes"))).toBeEnabled();
  await block(page).getByRole("tab", { name: "Summary" }).click();
  await settled(page);
  await shots(page, browserName, "");

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Weekly sync");
  await expect(block(page).getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("meeting-summary")).toContainText("The release ships on Friday [0:01].");
  await block(page).getByRole("tab", { name: "Transcript" }).click();
  await expect(page.getByTestId("meeting-transcript")).toContainText("Welcome everyone.");
  await expect(page.getByTestId("meeting-transcript")).toContainText("The release ships on Friday.");
  await block(page).getByRole("tab", { name: "Notes" }).click();
  await expect(page.getByTestId("meeting-stamped-notes")).toContainText("Ship on Friday");
  // Nach dem Neuladen kommt die Aufnahme aus dem Asset-Speicher.
  await timeButton(page.getByTestId("meeting-stamped-notes")).click();
  await expect(page.getByTestId("meeting-playback")).toContainText("Playing");
});

test("BSD-281: Library-Reiter „Meetings“ listet Meeting-Notizen und öffnet ihre Seite", async ({ page }) => {
  await newPageWithMeeting(page, "Planning");
  await block(page).getByLabel("Meeting title").fill("Roadmap planning");
  await block(page).getByLabel("Meeting title").press("Enter");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Meetings" }).click();
  const list = page.getByTestId("meetings");
  await expect(list).toHaveAttribute("data-loaded", "");
  await expect(list.getByText("Roadmap planning")).toBeVisible();
  await list.getByText("Roadmap planning").click();
  await expect(page.getByLabel("Page title")).toHaveValue("Planning");
});

// BSD-407 Teil 5: ⌘N → Meeting notes öffnet im Block-Editor; Notizen sind ein eigener Bereich: Pfeile bleiben darin,
// ⌫ unter dem Meeting zieht nichts in die Notizen (wählt das Meeting), die Records liegen im Notiz-Abschnitt.
type W = { __based: { client: Client & { openPage(id: string): Promise<{ store: { blocks: Map<string, { id: string; type: string; parent: string; sk: string; text?: unknown; props?: Record<string, unknown> }> } }> } } };

test("⌘N → Meeting notes: Block-Editor, Notizen per Klick und Tastatur, Pfeile bleiben in den Notizen", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("3");
  await expect(page.getByLabel("Page title")).toHaveValue(/^Meeting/);
  await expectEditable(page);
  await expect(blockEditor(page).getByTestId("meeting-block")).toBeVisible();
  await expect(page.locator(".bn-editor")).toHaveCount(0);
  await expect(block(page).getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");

  // Leere Notizen: Platzhalter, ein Klick legt die erste Notiz an
  await block(page).locator(".bx2-meet-placeholder").click();
  const focused = block(page).locator(".bx2-meet-doc [data-editable-id]:focus");
  await expect(focused).toHaveCount(1);
  await page.keyboard.type("First point");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second point");
  await page.keyboard.press("ArrowUp");
  await expect(focused).toHaveText("First point");
  await page.keyboard.press("ArrowUp"); // oben im Bereich: bleibt in den Notizen
  await expect(focused).toHaveText("First point");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(focused).toHaveText("Second point");

  // Records: beide Notizen im Notiz-Abschnitt des Meetings
  const pageID = await page.evaluate(() => location.hash.replace(/^#page-/, "").split("/")[0]!);
  const layout = () => page.evaluate(async (pid) => {
    const { store } = await (globalThis as unknown as W).__based.client.openPage(pid);
    const all = [...store.blocks.values()];
    const meeting = all.find((b) => b.type === "meeting")!;
    const notes = all.find((b) => b.type === "meetingSection" && b.parent === "b:" + meeting.id && b.props?.meetingSection === "notes")!;
    const texts = (parent: string) => all.filter((b) => b.parent === parent).sort((a, b) => (a.sk < b.sk ? -1 : 1)).map((b) => JSON.stringify(b.text ?? ""));
    return { notes: texts("b:" + notes.id), page: all.filter((b) => b.parent === "b:" + pid).map((b) => b.type) };
  }, pageID);
  await expect.poll(async () => (await layout()).notes).toEqual([JSON.stringify("First point"), JSON.stringify("Second point")]);

  // Unter dem Meeting weiterschreiben; ⌫ in der leeren Zeile wählt das Meeting, die Notizen bleiben
  await focusEditorEnd(page);
  await page.keyboard.press("Backspace");
  await expect(blockEditor(page).locator('.bx2-block[data-type="meeting"]')).toHaveAttribute("data-selected", "");
  await expect.poll(async () => (await layout()).notes).toEqual([JSON.stringify("First point"), JSON.stringify("Second point")]);
  expect((await layout()).page).toEqual(["meeting"]);
});

/** Alle Block-Records der Seite (Replik), ohne Zeiten, Schlüssel sortiert. */
const pageRecords = (page: Page, pageID: string) => page.evaluate(async (pid) => {
  const { store } = await (globalThis as unknown as W).__based.client.openPage(pid);
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return [...store.blocks.values()].map((b) => JSON.stringify(stable({ id: b.id, type: b.type, parent: b.parent, sk: b.sk, text: b.text, props: b.props }))).sort();
}, pageID);

async function reloadWith(page: Page, legacy: boolean, title: string) {
  await page.evaluate((on) => (on ? localStorage.setItem("based.legacyEditor", "true") : localStorage.removeItem("based.legacyEditor")), legacy);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expect(block(page)).toBeVisible();
}

// Rundreise: ein Meeting aus dem Block-Editor im alten Editor (Notausgang) öffnen, dort eine Notiz schreiben und
// zurück – Titel, Notizen, Kontext und Abschnitte bleiben, Öffnen allein ändert in keinem Editor einen Record.
test("Rundreise Block-Editor ↔ alter Editor: Meeting-Records bleiben erhalten", async ({ page }) => {
  await newPageWithMeeting(page, "Roundtrip");
  await block(page).getByLabel("Meeting title").fill("Roundtrip call");
  await block(page).getByLabel("Meeting title").press("Enter");
  await typeNote(page, "Written in the block editor");
  await block(page).getByRole("button", { name: "Add context" }).click();
  await page.getByRole("menuitem", { name: /Add a note/ }).click();
  await block(page).getByLabel("Context note").fill("Agenda: release");
  await block(page).getByLabel("Context note").press("Enter");
  await expect(block(page).getByTestId("meeting-context-chip")).toContainText("Agenda: release");
  await settled(page);
  const pageID = await page.evaluate(() => location.hash.replace(/^#page-/, "").split("/")[0]!);
  const before = await pageRecords(page, pageID);

  // alter Editor: zeigt alles, Öffnen ändert nichts
  await reloadWith(page, true, "Roundtrip");
  await expect(page.locator(".bx-editor .bn-editor").first()).toBeVisible();
  await expect(block(page).getByLabel("Meeting title")).toHaveValue("Roundtrip call");
  await expect(block(page).locator(".bx-meet-doc")).toContainText("Written in the block editor");
  await expect(block(page)).toContainText("Agenda: release");
  await settled(page);
  expect(await pageRecords(page, pageID)).toEqual(before);
  // dort weiterschreiben
  const notes = block(page).locator(".bx-meet-doc .bn-editor").first();
  await notes.locator(".bn-block-content").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Written in the old editor");
  await settled(page);
  const middle = await pageRecords(page, pageID);
  expect(middle.length).toBe(before.length + 1);

  // zurück im Block-Editor: beide Notizen, Öffnen ändert nichts
  await reloadWith(page, false, "Roundtrip");
  await expect(blockEditor(page)).toBeVisible();
  const doc = block(page).locator(".bx2-meet-doc");
  await expect(doc.locator("[data-editable-id]")).toHaveText(["Written in the block editor", "Written in the old editor"]);
  await expect(block(page).getByLabel("Meeting title")).toHaveValue("Roundtrip call");
  await expect(block(page).getByTestId("meeting-context-chip")).toContainText("Agenda: release");
  await settled(page);
  expect(await pageRecords(page, pageID)).toEqual(middle);
});
