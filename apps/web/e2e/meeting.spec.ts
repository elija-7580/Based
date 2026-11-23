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
  await expect(page.getByTestId("meeting-transcript-empty")).toContainText("Transcription isn't set up on this device yet");
  await settled(page);

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Planning");
  await expect(block(page).getByLabel("Meeting title")).toHaveValue("Planning call");
  await expect(block(page).locator(".bx2-meet-doc")).toContainText("Agenda first");
  // Die Seite öffnet im Block-Editor (BSD-407 Teil 5: keine Ausnahme mehr für Meetings)
  await expect(blockEditor(page)).toBeVisible();
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
  // Feedback 18. 11.: im Block steht sichtbar, dass gerade (live) transkribiert wird – mit Uhr
  const live = block(page).getByTestId("meeting-live-status");
  await expect(live).toHaveAttribute("data-state", "live");
  await expect(live).toContainText("Transcribing");
  await expect(live.getByTestId("meeting-clock")).toBeVisible();
  // BSD-281: laufende Aufnahme als Pille oben in der Seitenleiste (der feste Test-Transcriber schreibt live)
  await expect(page.getByTestId("recording-pill")).toContainText("Transcribing");

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

  await block(page).getByRole("button", { name: "Pause" }).click();
  await expect(live).toHaveAttribute("data-state", "paused");
  await block(page).getByRole("button", { name: "Resume" }).click();
  await expect(live).toHaveAttribute("data-state", "live");

  await block(page).getByRole("button", { name: "Stop" }).click();
  await expect(block(page)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  // fertig: keine Anzeige mehr
  await expect(block(page).getByTestId("meeting-live-status")).toHaveCount(0);
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

test("Feedback 14. 11.: auf Akku nur aufnehmen – Transkript wartet, kommt am Strom bzw. mit „Transcribe now“", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright-WebKit hat kein Fake-Mikrofon; Aufnahme nur in Chromium geprüft.");
  await page.evaluate(() => localStorage.setItem("based.meeting.transcribe", JSON.stringify("plugged-in")));
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  type Hooks = { __basedMeeting: { useTranscriber(l: unknown): void; usePower(b: boolean | undefined): Promise<void> } };
  await page.evaluate(async () => {
    const m = (globalThis as unknown as Hooks).__basedMeeting;
    m.useTranscriber([{ start: 0.2, end: 1.4, text: "Welcome everyone.", speaker: "me" }]);
    await m.usePower(true);
  });
  const record = async (title: string) => {
    await newPageWithMeeting(page, title);
    await block(page).getByRole("button", { name: "Start transcribing" }).click();
    await expect(block(page)).toHaveAttribute("data-recording", "true");
    await page.waitForTimeout(2000);
    await block(page).getByRole("button", { name: "Stop" }).click();
    await expect(block(page)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    const pending = block(page).getByTestId("meeting-transcribe-pending");
    await expect(pending).toContainText("transcript when this device is plugged in");
    await block(page).getByRole("tab", { name: "Transcript" }).click();
    await expect(block(page)).not.toContainText("Welcome everyone.");
    return pending;
  };
  // Am Strom: die Warteschlange holt das Transkript nach
  const first = await record("On battery");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("based.meeting.pending") ?? "[]").length)).toBe(1);
  await page.evaluate(() => (globalThis as unknown as Hooks).__basedMeeting.usePower(false));
  await expect(page.getByTestId("meeting-transcript")).toContainText("Welcome everyone.", { timeout: 10_000 });
  await expect(first).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("based.meeting.pending"))).toBeNull();
  // Von Hand, weiter auf Akku
  await page.evaluate(() => (globalThis as unknown as Hooks).__basedMeeting.usePower(true));
  const second = await record("By hand");
  await second.getByRole("button", { name: "Transcribe now" }).click();
  await expect(page.getByTestId("meeting-transcript")).toContainText("Welcome everyone.", { timeout: 10_000 });
  await expect(second).toHaveCount(0);
});

// Feedback 17. 11. (Elija, Mac-App): Aufnahme ohne eingerichtete Transkription → ehrlicher Hinweis mit dem Weg in die
// Einstellungen; ist sie später eingerichtet, lässt sich die vorhandene Aufnahme nachträglich transkribieren.
test("Feedback 17. 11.: ohne Transkription aufnehmen, später einrichten → „Transcribe recording“ holt das Transkript nach", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright-WebKit hat kein Fake-Mikrofon; Aufnahme nur in Chromium geprüft.");
  await newPageWithMeeting(page, "Recorded first");
  await block(page).getByRole("button", { name: "Start recording" }).click();
  await expect(block(page)).toHaveAttribute("data-recording", "true");
  await page.waitForTimeout(1500);
  await block(page).getByRole("button", { name: "Stop" }).click();
  await expect(block(page)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  // 23. 11.: ohne Transkript gab es keinen Weg, die Aufnahme anzuhören – „Play recording“ spielt sie von vorn.
  await block(page).getByRole("button", { name: "Play recording" }).click();
  await expect(page.getByTestId("meeting-playback")).toContainText(/Playing|Paused/);
  await expect(page.getByTestId("meeting-playback").locator(".bx-meet-error")).toHaveCount(0);
  await block(page).getByRole("button", { name: "Stop playback" }).click();
  await expect(page.getByTestId("meeting-playback")).toHaveCount(0);
  await expect(block(page).getByRole("button", { name: "Play recording" })).toBeVisible();
  await block(page).getByRole("tab", { name: "Transcript" }).click();
  await expect(page.getByTestId("meeting-transcript-empty")).toContainText("Set it up in Settings → Meeting notes");
  await expect(block(page).getByRole("button", { name: "Transcribe recording" })).toHaveCount(0);
  await shots(page, test.info().project.name, "-no-transcription");
  // Transkription wird eingerichtet (hier: fester Transcriber) – der Knopf erscheint, ohne neu aufzunehmen.
  await page.evaluate(() => (globalThis as unknown as { __basedMeeting: { useTranscriber(l: unknown): void } }).__basedMeeting
    .useTranscriber([{ start: 0.2, end: 1.2, text: "Recorded before setup.", speaker: "me" }]));
  await block(page).getByRole("tab", { name: "Notes" }).click();
  await block(page).getByRole("tab", { name: "Transcript" }).click();
  await shots(page, test.info().project.name, "-transcribe-recording");
  await block(page).getByRole("button", { name: "Transcribe recording" }).click();
  await expect(page.getByTestId("meeting-transcript")).toContainText("Recorded before setup.", { timeout: 10_000 });
  await expect(block(page).getByRole("button", { name: "Transcribe recording" })).toHaveCount(0);
});

// Einstellungen → Meeting notes: im Browser ohne Server steht, was fehlt – kein Knopf, der ins Leere führt.
test("Feedback 17. 11.: Einstellungen nennen den fehlenden Schritt für die Transkription", async ({ page, browserName }) => {
  await page.goto("/#prefs-meetings");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  const section = page.getByTestId("settings-section-meetings");
  await expect(section).toContainText("Transcription");
  await expect(section).toContainText("Needs a Based server that offers transcription. Connect one in Sync & server.");
  await expect(section.getByRole("button", { name: /Download model|Check again|Remove model/ })).toHaveCount(0);
  if (SHOTS && browserName === "chromium") {
    await page.setViewportSize({ width: 1280, height: 820 });
    await section.scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../../docs/design/screens/web-settings-transcription-${theme}.png` });
    }
  }
});

// Elija 17.11.: Modell wählen und laden in den Einstellungen. Der Server ist ein Doppel (page.route) mit dem Verhalten
// von apps/server/src/transcribe.ts: drei Modelle, „download“ macht das Modell zum gewählten, Fortschritt, dann bereit.
test("Elija 17.11.: Einstellungen – Modell wählen, laden mit Fortschritt, bereit, anderes Modell, entfernen", async ({ page, browserName }) => {
  type M = { id: string; name: string; size: number; installed: boolean; downloading: boolean; loaded?: number };
  const models: M[] = [
    { id: "whisper-base", name: "Whisper base", size: 147_951_465, installed: false, downloading: false },
    { id: "whisper-small", name: "Whisper small", size: 487_601_967, installed: false, downloading: false },
    { id: "whisper-large-v3-turbo", name: "Whisper large v3 turbo", size: 1_624_555_275, installed: false, downloading: false },
  ];
  let active = "whisper-small";
  let hold = true; // Download bleibt bei 50 % stehen, bis der Test ihn freigibt
  const posts: unknown[] = [];
  const state = () => {
    for (const m of models) if (m.downloading && !hold) { m.downloading = false; m.installed = true; delete m.loaded; }
    const all = models.map((m) => ({ ...m, active: m.id === active }));
    return { engine: "whisper.cpp", engineInstalled: true, ready: models.some((m) => m.installed), model: { source: "catalog", ...all.find((m) => m.active)! }, models: all };
  };
  await page.route("http://127.0.0.1:58231/local/transcribe**", async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "POST" && req.url().endsWith("/model")) {
      const body = req.postDataJSON() as { action: string; id?: string };
      posts.push(body);
      const m = models.find((x) => x.id === (body.id ?? active))!;
      if (body.action === "download") { active = m.id; m.downloading = true; m.loaded = Math.ceil(m.size / 2); }
      if (body.action === "select") active = m.id;
      if (body.action === "cancel") { m.downloading = false; delete m.loaded; }
      if (body.action === "remove") m.installed = false;
    }
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(state()) });
  });
  await page.goto("/#prefs-sync");
  await page.getByLabel("Server URL").fill("http://127.0.0.1:58231/");
  await page.getByLabel("Token").fill("secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByLabel("Server URL")).toBeDisabled();
  await page.goto("/#prefs-meetings");
  const section = page.getByTestId("settings-section-meetings");
  const shot = async (name: string) => {
    if (!SHOTS || browserName !== "chromium") return;
    await page.setViewportSize({ width: 1280, height: 820 });
    await section.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-settings-transcription-${name}-${theme}.png` });
    }
    await setTheme(page, "light");
  };
  // vorausgewählt: Balanced (small); nichts wird von selbst geladen
  const pick = (label: RegExp | string) => section.getByRole("button", { name: label });
  await expect(pick("Balanced · 488 MB")).toBeVisible();
  await expect(section).toContainText("Download a speech model once from huggingface.co");
  expect(posts).toEqual([]);
  await shot("choose");
  await section.getByRole("button", { name: "Download", exact: true }).click();
  await expect(section).toContainText("Downloading Balanced (488 MB)… 50 %");
  await expect(section.getByRole("button", { name: "Cancel" })).toBeVisible();
  expect(posts).toEqual([{ action: "download", id: "whisper-small" }]);
  await shot("downloading");
  hold = false;
  await expect(section).toContainText("Ready with Balanced.", { timeout: 10_000 });
  await expect(pick("Balanced · 488 MB · downloaded")).toBeVisible();
  await expect(section.getByRole("button", { name: "Remove" })).toBeVisible();
  await shot("ready");
  // anderes Modell wählen: erst nach Klick laden
  hold = true;
  await pick(/Balanced/).click();
  await page.getByRole("menuitem", { name: /Best · 1\.6 GB/ }).click();
  await expect(section).toContainText("Ready with another model. Most accurate");
  expect(posts).toHaveLength(1);
  await section.getByRole("button", { name: "Download", exact: true }).click();
  await expect(section).toContainText("Downloading Best (1.6 GB)… 50 %");
  await section.getByRole("button", { name: "Cancel" }).click();
  await expect(section.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  expect(posts.slice(1)).toEqual([{ action: "download", id: "whisper-large-v3-turbo" }, { action: "cancel", id: "whisper-large-v3-turbo" }]);
  // zurück zum geladenen Modell: „Use this model“, dann entfernen
  await pick(/Best/).click();
  await page.getByRole("menuitem", { name: /Balanced/ }).click();
  await section.getByRole("button", { name: "Use this model" }).click();
  await expect(section).toContainText("Ready with Balanced.");
  await section.getByRole("button", { name: "Remove" }).click();
  await expect(section.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  expect(posts.at(-1)).toEqual({ action: "remove", id: "whisper-small" });
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


// 23. 11. (Elija: „Ideen festhalten mit Audio“): ⌘N → „Record a voice note“ legt die Notiz an und nimmt sofort auf.
test("⌘N → Record a voice note: neue Notiz, Aufnahme läuft sofort, nach dem Stop abspielbar", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright-WebKit hat kein Fake-Mikrofon; Aufnahme nur in Chromium geprüft.");
  await page.keyboard.press("ControlOrMeta+n");
  const palette = page.getByTestId("new-palette");
  await palette.getByRole("option", { name: /Record a voice note/ }).click();
  await expect(block(page)).toHaveAttribute("data-recording", "true", { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await block(page).getByRole("button", { name: "Stop" }).click();
  await expect(block(page)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(block(page).getByRole("button", { name: "Play recording" })).toBeVisible();
});
