import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-159: Chat mit ScriptedEngine (deterministisch, ohne Netz) – ⌘J, gestreamte Antwort mit Tool-Karte und
// Freigabe, die Seite entsteht wirklich im Workspace, Kosten sichtbar, nach Neuladen ist der Verlauf noch da; Stop,
// Warteschlange, Fehler mit Retry, Zustand „kein Modell eingerichtet“, Vollseite.

type Step = Record<string, unknown>;

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function useScript(page: Page, script: Step[] | Step[][], delayMs = 0) {
  await page.waitForFunction(() => "__basedChat" in globalThis);
  await page.evaluate(([s, d]) => (globalThis as unknown as { __basedChat: { useScript(s: unknown, d: number): void } }).__basedChat.useScript(s, d as number), [script, delayMs] as const);
}

const panel = (page: Page) => page.getByTestId("chat-panel");
const input = (page: Page) => panel(page).getByLabel("Ask Based");

const LISBON: Step[] = [
  { thinking: "The user wants a page for the trip. I'll create it with a short packing list." },
  { text: "I'll create a page for your Lisbon trip." },
  { tool: "create_page", input: { title: "Lisbon trip", markdown: "Flights are **booked**.\n\n- Sunscreen\n- Tram 28 tickets" } },
  { event: { type: "usage", inputTokens: 1800, outputTokens: 240, costUSD: 0.0126, estimated: true, model: "scripted" } },
  { text: "Done — **Lisbon trip** is in your sidebar with a packing list." },
];

test.beforeEach(async ({ page }) => fresh(page));

// Eigenes Profil: WebKit hat OPFS nur in einem dauerhaften Kontext (sonst „Not saved“ und nach Neuladen leer).
test("⌘J → Frage → gestreamte Antwort mit Tool-Karte → Seite angelegt → nach Neuladen noch da", async ({ playwright, browserName, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), "based-chat-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await fresh(page);
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    await lisbonFlow(page);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function lisbonFlow(page: Page) {
  await page.keyboard.press(`${mod}+j`);
  await expect(panel(page)).toBeVisible();
  // ohne Modell: Hinweis statt Fehler
  await expect(panel(page).getByRole("heading", { name: "No model set up" })).toBeVisible();
  await expect(input(page)).toBeDisabled();

  await useScript(page, LISBON, 15);
  await expect(panel(page).getByRole("heading", { name: "Ask Based" })).toBeVisible();
  await input(page).fill("Make a page for my Lisbon trip");
  await input(page).press("Enter");
  await expect(panel(page).getByTestId("user-message")).toHaveText("Make a page for my Lisbon trip");

  // „Ask before edits“: die Karte wartet auf Freigabe, die Seite gibt es noch nicht
  const card = panel(page).getByTestId("tool-card");
  await expect(card).toHaveAttribute("data-status", "waiting");
  await expect(page.getByRole("treeitem", { name: "Lisbon trip" })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Stop" })).toBeVisible();
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveAttribute("data-status", "done");
  await expect(page.getByRole("treeitem", { name: "Lisbon trip" })).toBeVisible();

  const answer = panel(page).getByTestId("assistant-message");
  await expect(answer).toHaveAttribute("data-done", "");
  await expect(answer.getByText("is in your sidebar with a packing list.")).toBeVisible();
  await expect(answer.locator("strong", { hasText: "Lisbon trip" })).toBeVisible();
  await expect(answer.getByTestId("thinking")).toContainText("Thought");
  await expect(panel(page).getByTestId("chat-usage")).toHaveText("2k tokens · ~$0.01");
  await expect(answer.getByTestId("turn-usage")).toContainText("2k tokens");

  // die Seite ist echt: Inhalt aus dem Markdown des Werkzeugs
  await page.getByRole("treeitem", { name: "Lisbon trip" }).click();
  await expect(page.getByText("Tram 28 tickets")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(panel(page), "Panel bleibt offen").toBeVisible();
  await expect(panel(page).getByTestId("user-message")).toHaveText("Make a page for my Lisbon trip");
  await expect(panel(page).getByTestId("tool-card")).toHaveAttribute("data-status", "done");
  await expect(panel(page).getByText("is in your sidebar with a packing list.")).toBeVisible();
  await expect(panel(page).getByTestId("chat-usage")).toHaveText("2k tokens · ~$0.01");

  // Verlaufsliste
  await panel(page).getByRole("button", { name: "Chats" }).click();
  await expect(panel(page).getByText("Make a page for my Lisbon trip")).toBeVisible();

  await page.keyboard.press(`${mod}+j`);
  await expect(panel(page)).toHaveCount(0);
}

test("Stop bricht ab; Nachricht während der Antwort wartet und folgt", async ({ page }) => {
  await useScript(page, [[{ text: "Working on a long answer" }, { hold: true }], [{ text: "Second answer." }]], 10);
  await page.keyboard.press(`${mod}+j`);
  await input(page).fill("Write something long");
  await input(page).press("Enter");
  await expect(panel(page).getByText("Working on a long answer")).toBeVisible();

  await input(page).fill("And then this");
  await input(page).press("Enter");
  const queue = panel(page).getByTestId("chat-queue");
  await expect(queue).toContainText("And then this");

  await panel(page).getByRole("button", { name: "Stop" }).click();
  await expect(panel(page).getByTestId("stopped")).toBeVisible();
  await expect(queue).toHaveCount(0);
  await expect(panel(page).getByTestId("user-message")).toHaveText(["Write something long", "And then this"]);
  await expect(panel(page).getByText("Second answer.")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  // der abgebrochene Teil bleibt lesbar
  await expect(panel(page).getByText("Working on a long answer")).toBeVisible();
});

test("Fehler mit Retry", async ({ page }) => {
  await useScript(page, [[{ fail: "HTTP 529: Overloaded" }], [{ text: "Here you go." }]]);
  await page.keyboard.press(`${mod}+j`);
  await input(page).fill("Hello");
  await input(page).press("Enter");
  await expect(panel(page).getByText("HTTP 529: Overloaded")).toBeVisible();
  await panel(page).getByRole("button", { name: "Retry" }).click();
  await expect(panel(page).getByText("Here you go.")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("Vollseite und zurück ins Panel; Composer auf Home fragt im Panel", async ({ page }) => {
  await useScript(page, [{ text: "Answer from Home." }]);
  await page.getByLabel("Ask Based").first().fill("Asked on Home");
  await page.getByLabel("Ask Based").first().press("Enter");
  await expect(panel(page).getByText("Answer from Home.")).toBeVisible();
  await panel(page).getByRole("button", { name: "Open as page" }).click();
  const full = page.getByTestId("chat-page");
  await expect(full).toBeVisible();
  await expect(full.getByText("Answer from Home.")).toBeVisible();
  await expect(full.getByRole("listitem").filter({ hasText: "Asked on Home" })).toBeVisible();
  await full.getByRole("button", { name: "Open as side panel" }).click();
  await expect(panel(page)).toBeVisible();
});

test("Einstellungen: Schlüssel nie im Klartext im localStorage", async ({ page }) => {
  await page.keyboard.press(`${mod}+j`);
  await panel(page).getByRole("button", { name: "Set up a model" }).click();
  const settings = panel(page).getByTestId("ai-settings");
  await settings.getByLabel("API key").fill("sk-ant-test-secret-123");
  await settings.getByLabel("Models").fill("my-model-a, my-model-b");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByText("Saved", { exact: true })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain("sk-ant-test-secret-123");
  expect(stored).toContain("my-model-a");
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(panel(page).getByLabel("Ask Based")).toBeEnabled();
  await expect(panel(page).getByText("anthropic/my-model-a").first()).toBeVisible();
});

// Screenshots für docs/design/screens (nur mit BASED_SCREENSHOTS=1, Chromium).
test("Screenshots web-chat-*", async ({ page, browserName }) => {
  test.skip(!process.env.BASED_SCREENSHOTS || browserName !== "chromium", "nur auf Wunsch");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t, style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false })), theme);
    await page.evaluate(() => localStorage.setItem("based.chatOpen", "1"));
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    if (theme === "light") {
      await useScript(page, LISBON, 0);
      await input(page).fill("Make a page for my Lisbon trip");
      await input(page).press("Enter");
      await panel(page).getByRole("button", { name: "Allow" }).click();
      await expect(panel(page).getByTestId("assistant-message")).toHaveAttribute("data-done", "");
      await useScript(page, [{ text: "It has **3 blocks**: a note that flights are booked, and a packing list with sunscreen and tram tickets.\n\n| Item | Status |\n|---|---|\n| Flights | booked |\n| Hotel | open |" }]);
      await input(page).fill("What's on it?");
      await input(page).press("Enter");
      await expect(panel(page).getByTestId("assistant-message")).toHaveCount(2);
      await expect(panel(page).getByTestId("assistant-message").nth(1)).toHaveAttribute("data-done", "");
    }
    await page.getByRole("treeitem", { name: "Lisbon trip" }).click();
    await expect(panel(page).getByTestId("assistant-message").nth(1)).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `../../docs/design/screens/web-chat-panel-${theme}.png` });
    await panel(page).getByRole("button", { name: "Open as page" }).click();
    await expect(page.getByTestId("chat-page").getByTestId("assistant-message").nth(1)).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `../../docs/design/screens/web-chat-page-${theme}.png` });
    await page.getByTestId("chat-page").getByRole("button", { name: "Open as side panel" }).click();
  }
});
