import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-162/197/133 (Mockup v10): Startseite mit Zeitbogen und Auftragskarte am Composer, mit dem Scripted-Planer
// (`__basedTasks.useRules()`, ohne Netz): frischer Workspace → Leerzustand; Senden → Karte durchläuft ihre Zustände
// und landet auf dem Bogen; Rückfrage-Knopf; Undo; reine Frage; Needs-you-Freigabe am Scheitel; Klick auf laufende
// Karte → Agent-Detail; Projekt-Detail; Neuladen. Screenshots hell/dunkel für Startseite, Kartenzustände und Details.

const call = (page: Page, fn: "useRules" | "setOnline" | "useAgentScript", ...args: unknown[]) =>
  page.evaluate(([f, a]) => ((globalThis as unknown as { __basedTasks: Record<string, (...x: unknown[]) => void> }).__basedTasks[f as string]!)(...(a as unknown[])), [fn, args] as const);

async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("home")).toBeVisible();
  await page.waitForFunction(() => "__basedTasks" in globalThis);
}

const field = (page: Page) => page.getByLabel("Tell Based", { exact: true });
const card = (page: Page) => page.getByTestId("home-task-card");

async function send(page: Page, text: string) {
  await field(page).fill(text);
  await field(page).press("Enter");
}

test("Leerzustand → Senden → Karte durchläuft Zustände → landet; Undo; Rückfrage; Frage; Neuladen", { tag: "@smoke" }, async ({ playwright, browserName, baseURL }) => {
  // eigenes Profil: WebKit hat OPFS nur in einem dauerhaften Kontext
  const dir = mkdtempSync(join(tmpdir(), "based-home-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await open(page);
    // frischer Workspace: ehrlicher Leerzustand
    await expect(page.getByTestId("home-empty")).toBeVisible();
    await expect(page.getByTestId("home-sentence")).toContainText("Nothing is running yet");
    // BSD-278: Kosten nur, wenn etwas angefallen ist (oder Agent-Details an)
    await expect(page.getByTestId("home-cost")).toHaveCount(0);
    await expect(page.getByTestId("needs-you")).toHaveCount(0);

    // ohne Modell: Karte „Received“, wartet
    await send(page, "Write a page about green tea");
    await expect(card(page)).toHaveAttribute("data-phase", "received");
    await expect(page.getByTestId("home-task-head")).toHaveText("Saved · waiting: no model set up");
    await expect(field(page)).toHaveValue("");

    // Planer an (mit Pause): versteht → erledigt (Undo, Open page)
    await call(page, "useRules", 700);
    await expect(card(page)).toHaveAttribute("data-phase", "understanding");
    await expect(card(page).getByRole("status", { name: "Understanding" })).toBeVisible();
    await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await expect(page.getByTestId("home-task-result")).toHaveText("Page “Write a page about green tea”");
    await expect(page.getByRole("navigation").getByText("Write a page about green tea")).toBeVisible();
    await card(page).getByRole("button", { name: "Undo" }).click();
    await expect(card(page)).toHaveAttribute("data-phase", "undone");
    await expect(page.getByRole("navigation").getByText("Write a page about green tea")).toHaveCount(0);
    await card(page).getByRole("button", { name: "Put card away" }).click();
    await expect(card(page)).toHaveCount(0);

    // Rückfrage-Knopf an der Karte
    await call(page, "useRules", 0);
    await send(page, "Add this to the project: swipe view for tasks");
    await expect(card(page)).toHaveAttribute("data-phase", "question", { timeout: 10_000 });
    await expect(card(page)).toContainText("Which project?");
    await card(page).getByRole("button", { name: "New project" }).click();
    await expect(card(page)).toHaveAttribute("data-phase", /proposal|done/, { timeout: 10_000 });
    if ((await card(page).getAttribute("data-phase")) === "proposal") await card(page).getByRole("button", { name: "Go ahead" }).click();
    await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await expect(page.getByTestId("home-task-result")).toContainText("Filed into");

    // nächste Eingabe: die erledigte Karte fliegt auf den Bogen (links), die neue steht am Composer
    await send(page, "Buy milk tomorrow");
    await expect(page.getByTestId("arc-done").filter({ hasText: "swipe view for tasks" })).toBeVisible({ timeout: 10_000 });
    await expect(card(page)).toContainText("Buy milk tomorrow");
    await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    // nach der Haltezeit landet sie von selbst
    await expect(page.getByTestId("arc-done").filter({ hasText: "Buy milk tomorrow" })).toBeVisible({ timeout: 15_000 });
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId("home-empty")).toHaveCount(0);
    await expect(page.getByTestId("home-sentence")).toContainText("Based finished");

    // reine Frage: Antwort auf der Karte, „Save as page“ legt eine Seite an
    await send(page, "What is the capital of Portugal?");
    await expect(card(page)).toHaveAttribute("data-phase", "answered", { timeout: 10_000 });
    await expect(page.getByTestId("home-task-answer")).toContainText("You asked");
    await card(page).getByRole("button", { name: "Save as page" }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("What is the capital of Portugal?");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home" }).click();
    await expect(card(page)).toHaveCount(0);

    // Fallback: ungültiger Plan → als Notiz abgelegt, Try again
    await send(page, "Some thought #invalid");
    await expect(card(page)).toHaveAttribute("data-phase", "fallback", { timeout: 10_000 });
    await expect(card(page).getByRole("button", { name: "Try again" })).toBeVisible();

    // Neuladen: Bogen und Karte sind noch da
    await page.reload();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.getByTestId("arc-done").filter({ hasText: "Buy milk tomorrow" })).toBeVisible();
    await expect(card(page)).toHaveAttribute("data-phase", "fallback");
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Agent im inneren Ring: Needs you am Scheitel → Agent-Detail → Allow; Projekt-Detail", async ({ page }) => {
  await open(page);
  await call(page, "useRules", 0);
  // Unteragent will eine Seite anlegen → „Ask before edits“ fragt
  await call(page, "useAgentScript", [{ wait: 300 }, { tool: "create_page", input: { title: "Sync engines compared", markdown: "Automerge, Yjs, Loro." } }, { text: "Compared three sync engines." }]);
  await send(page, "Research open-source sync engines for Publit project");
  const ring = page.getByTestId("arc-running").filter({ hasText: "sync engines" });
  const apex = page.getByTestId("needs-you");
  await expect(apex).toContainText("wants to use create page", { timeout: 10_000 });
  // BSD-278: was oben „Needs you“ ist, steht nicht zusätzlich im inneren Ring
  await expect(ring).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("home-sentence")).toContainText(/one thing needs you/i);
  await expect(page.getByTestId("home-sentence")).not.toContainText("agent is working");

  // „Details“ am Scheitel → Agent-Detail
  await apex.getByRole("button", { name: /^Details for / }).click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { level: 1 })).toContainText("sync engines");
  await expect(detail.getByTestId("timeline")).toBeVisible();
  await expect(detail.getByTestId("agent-started-from")).toContainText("Research open-source sync engines");
  await expect(detail.getByRole("region", { name: "Needs you" })).toBeVisible();
  await detail.getByRole("button", { name: "Home" }).click(); // Breadcrumb

  // Allow am Scheitel → Lauf endet, Karte landet links
  await apex.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("needs-you")).toHaveCount(0);
  await expect(page.getByTestId("arc-done").filter({ hasText: "sync engines" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("navigation").getByText("Sync engines compared")).toBeVisible();
  await page.getByTestId("arc-done").filter({ hasText: "sync engines" }).getByRole("button", { name: "Details" }).click();
  await expect(page.getByTestId("agent-result")).toContainText("Compared three sync engines.");
});

test("Projekt-Detail aus echten Records", async ({ page }) => {
  await open(page);
  await call(page, "useRules", 0);
  await send(page, "Add this to the project: offline maps");
  await expect(card(page)).toHaveAttribute("data-phase", "question", { timeout: 10_000 });
  await card(page).getByRole("button", { name: "New project" }).click();
  await expect(card(page)).toHaveAttribute("data-phase", /proposal|done/, { timeout: 10_000 });
  if ((await card(page).getAttribute("data-phase")) === "proposal") await card(page).getByRole("button", { name: "Go ahead" }).click();
  await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  const projectButton = card(page).getByRole("button", { name: /^Open / });
  await projectButton.click();
  const d = page.getByTestId("project-detail");
  await expect(d).toBeVisible();
  await expect(d.getByTestId("project-landed")).toContainText("offline maps");
  await expect(d.getByRole("region", { name: "Updates from the main agent" })).toContainText("offline maps");
  await expect(d.getByText("Done this week")).toBeVisible();
});

test("BSD-278: fällige Aufgaben aus Datenbanken rechts auf dem Bogen, erledigte nicht; Klick öffnet die Zeile", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("home-cost")).toHaveCount(0);
  await page.evaluate(() => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string> } } }).__based.client.command({ op: "seedDueTasks" }));
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home" }).click();
  const due = page.getByTestId("arc-due");
  await expect(due.filter({ hasText: "Pay rent" })).toBeVisible({ timeout: 10_000 });
  await expect(due.filter({ hasText: "Pay rent" })).toContainText("today");
  await expect(due.filter({ hasText: "Ship the release" })).toBeVisible();
  await expect(due.filter({ hasText: "Call the dentist" })).toHaveCount(0);
  await expect(page.getByTestId("home-empty")).toHaveCount(0);
  await expect(page.getByTestId("home-sentence")).toContainText("Due today: Pay rent");
  await due.filter({ hasText: "Pay rent" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Pay rent");
});

// MARK: Screenshots

async function seed(page: Page) {
  await call(page, "useRules", 0);
  await send(page, "Add this to the project: Publit");
  await expect(card(page)).toHaveAttribute("data-phase", "question", { timeout: 10_000 });
  await card(page).getByRole("button", { name: "New project" }).click();
  await expect(card(page)).toHaveAttribute("data-phase", /proposal|done/, { timeout: 10_000 });
  if ((await card(page).getAttribute("data-phase")) === "proposal") await card(page).getByRole("button", { name: "Go ahead" }).click();
  await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  await send(page, "Write a page with ideas for the birthday party");
  await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  await send(page, "Buy oat milk tomorrow");
  await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  await send(page, "Remind me every 2 hours to stretch");
  await expect(card(page)).toHaveAttribute("data-phase", /done|proposal/, { timeout: 10_000 });
  if ((await card(page).getAttribute("data-phase")) === "proposal") await card(page).getByRole("button", { name: "Go ahead" }).click();
  await call(page, "useAgentScript", [{ hold: true }]);
  await send(page, "Research competitors for Publit");
  await expect(page.getByTestId("arc-running").filter({ hasText: "competitors" })).toHaveAttribute("data-status", "running", { timeout: 10_000 });
  await call(page, "useAgentScript", [{ wait: 200 }, { tool: "create_page", input: { title: "Test net notes", markdown: "x" } }, { hold: true }]);
  await send(page, "Investigate the flaky test net");
  await expect(page.getByTestId("needs-you")).toBeVisible({ timeout: 10_000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`Screenshots Startseite (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots nur einmal");
    test.setTimeout(120_000);
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1440, height: 960 });
    await open(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `../../docs/design/screens/web-home-empty-${theme}.png` });
    await seed(page);
    await call(page, "useRules", 60_000);
    await send(page, "Plan the Lisbon trip in December");
    await expect(card(page)).toHaveAttribute("data-phase", "understanding");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `../../docs/design/screens/web-home-${theme}.png` });

    // Kartenzustände
    const shot = async (name: string) => {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      const box = (await page.locator(".home-dock").boundingBox())!;
      await page.screenshot({ path: `../../docs/design/screens/web-home-card-states-${name}-${theme}.png`, clip: { x: box.x - 24, y: box.y - 320, width: box.width + 48, height: box.height + 340 } });
    };
    await shot("understanding");

    // Agent-Detail (vor dem Neuladen: danach gelten unterbrochene Unteragenten als gescheitert)
    await page.getByTestId("arc-running").filter({ hasText: "competitors" }).click();
    await expect(page.getByTestId("agent-detail")).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `../../docs/design/screens/web-agent-detail-${theme}.png` });
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home" }).click();
    await page.reload();
    await open(page);
    await call(page, "useRules", 0);
    await call(page, "setOnline", false);
    await send(page, "Call the landlord about the heating");
    await expect(card(page)).toHaveAttribute("data-phase", "received");
    await shot("received");
    await call(page, "setOnline", true);
    await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await shot("done");
    await send(page, "Add this to the project");
    await expect(card(page)).toHaveAttribute("data-phase", "question", { timeout: 10_000 });
    await shot("question");
    await card(page).getByRole("button", { name: "File as note" }).click();
    await page.goto("/#prefs-agents");
    const s = page.getByTestId("agent-settings");
    await s.getByRole("spinbutton", { name: "Without asking, per task" }).fill("0.2");
    await s.getByRole("spinbutton", { name: "Without asking, per task" }).press("Tab");
    await s.getByRole("button", { name: "Save" }).click();
    await expect(s.getByTestId("agent-settings-status")).toHaveText("Saved");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home" }).click();
    await send(page, "Research open-source sync engines");
    await expect(card(page)).toHaveAttribute("data-phase", "proposal", { timeout: 10_000 });
    await shot("proposal");
    await card(page).getByRole("button", { name: "File as note" }).click();
    await send(page, "What is the capital of Portugal?");
    await expect(card(page)).toHaveAttribute("data-phase", "answered", { timeout: 10_000 });
    await shot("answered");
    await card(page).getByRole("button", { name: "Put card away" }).click();
    await send(page, "Some thought #invalid");
    await expect(card(page)).toHaveAttribute("data-phase", "fallback", { timeout: 10_000 });
    await shot("fallback");

    // Projekt-Detail
    await send(page, "Publit: idea — offline timetable cache");
    await expect(card(page)).toHaveAttribute("data-phase", /done|proposal/, { timeout: 10_000 });
    if ((await card(page).getAttribute("data-phase")) === "proposal") await card(page).getByRole("button", { name: "Go ahead" }).click();
    await expect(card(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await card(page).getByRole("button", { name: /^Open Publit/ }).click();
    await expect(page.getByTestId("project-detail")).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `../../docs/design/screens/web-project-detail-${theme}.png` });
  });
}
