import { expect, test as base, type Page } from "@playwright/test";
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

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

async function fresh(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const editor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();
const block = (page: Page) => page.getByTestId("meeting-block");

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
}

async function newPageWithMeeting(page: Page, title: string) {
  await command(page, { op: "createPage", title });
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
  await openPage(page, title);
  const first = editor(page).locator(".bn-block-content").first();
  await first.click();
  await page.keyboard.type("/meet");
  await expect(page.getByRole("option", { name: /Meeting notes/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(block(page)).toBeVisible();
  await expect(block(page).getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
}

/** Notiz in den Notiz-Editor des Meetings schreiben. */
async function typeNote(page: Page, text: string) {
  const notes = block(page).locator(".bx-meet-doc .bn-editor").first();
  await expect(notes).toHaveAttribute("contenteditable", "true");
  await notes.locator(".bn-block-content").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".bn-container").first()).toHaveAttribute("data-color-scheme", theme);
}

async function shots(page: Page, browserName: string, name: string) {
  if (!SHOTS || browserName !== "chromium") return;
  await page.getByLabel("Page title").click(); // Block nicht ausgewählt zeigen
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `../../docs/design/screens/web-meeting${name}-${theme}.png` });
  }
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
  await expect(block(page).locator(".bx-meet-doc")).toContainText("Agenda first");
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
  const stampButton = stamped.locator(".bx-meet-time").first();
  await expect(stampButton).toHaveText(/^0:0\d$/);
  await expect(stampButton).toBeDisabled(); // noch keine gespeicherte Aufnahme

  // Live-Transkript während der Aufnahme
  await page.waitForTimeout(2500);
  await block(page).getByRole("tab", { name: "Transcript" }).click();
  await expect(page.getByTestId("meeting-transcript")).toContainText("Welcome everyone.");
  await shots(page, browserName, "-recording");

  await block(page).getByRole("button", { name: "Stop" }).click();
  await expect(block(page)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(page.getByTestId("recording-pill")).toHaveCount(0);
  await expect(block(page)).not.toHaveAttribute("data-recording", "true");
  const transcript = page.getByTestId("meeting-transcript");
  await expect(transcript).toContainText("The release ships on Friday.");
  await expect(transcript.locator(".bx-meet-speaker").filter({ hasText: "Others" })).toBeVisible();
  await expect(block(page).locator(".bx-meet-legend")).toContainText("Me");

  // Klick auf eine Zeile spielt ab dieser Stelle
  await transcript.locator(".bx-meet-para").filter({ hasText: "The release ships" }).click();
  await expect(page.getByTestId("meeting-playback")).toHaveAttribute("data-from", "1.5");

  await block(page).getByRole("tab", { name: "Summary" }).click();
  await block(page).getByRole("button", { name: "Generate summary" }).click();
  const summary = page.getByTestId("meeting-summary");
  await expect(summary).toContainText("The release ships on Friday [0:01].");
  await expect(summary).toContainText("Based · from your recording");
  await expect(block(page)).toContainText("Written by Scripted");
  const cite = page.getByTestId("meeting-citations").getByRole("button", { name: "Play from 0:01" });
  await cite.click();
  await expect(page.getByTestId("meeting-playback")).toHaveAttribute("data-from", "1");
  await expect(page.getByTestId("meeting-playback")).toContainText("Playing");
  await block(page).getByRole("tab", { name: "Notes" }).click();
  await expect(page.getByTestId("meeting-stamped-notes").locator(".bx-meet-time").first()).toBeEnabled();
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
  await page.getByTestId("meeting-stamped-notes").locator(".bx-meet-time").first().click();
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
