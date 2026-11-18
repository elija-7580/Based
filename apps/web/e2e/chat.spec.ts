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
test("⌘J → Frage → gestreamte Antwort mit Tool-Karte → Seite angelegt → nach Neuladen noch da", { tag: "@smoke" }, async ({ playwright, browserName, baseURL }) => {
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

// Seit Mockup v10 (BSD-197) wird der Composer auf Home zur Auftragskarte (home.spec.ts); gefragt wird im Panel.
test("Vollseite und zurück ins Panel", async ({ page }) => {
  await useScript(page, [{ text: "Answer from Home." }]);
  await page.keyboard.press(`${mod}+j`);
  await input(page).fill("Asked on Home");
  await input(page).press("Enter");
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

// Agent-Parität E35 (Entscheidung 18.11.): an jeder Agenten-Aktion im Chat ein „Undo“, das genau diesen Schritt
// zurücknimmt – auch wenn danach weitergearbeitet wurde. Fotos: docs/design/screens/web-chat-undo-*.png.
const TWO_PAGES: Step[] = [
  { tool: "create_page", input: { title: "Lisbon trip", markdown: "- Sunscreen" } },
  { tool: "create_page", input: { title: "Porto trip with a very long title that has to shorten in the tool row instead of pushing the Undo button out of the card", markdown: "- Port" } },
  { tool: "search", input: { query: "trip" } },
  { text: "Both pages are in your sidebar." },
];

for (const theme of ["light", "dark"] as const) {
  test(`Undo an einer Agenten-Aktion nimmt genau diesen Schritt zurück (${theme})`, async ({ page, browserName }) => {
    await page.evaluate((t) => { localStorage.setItem("based.appearance", JSON.stringify({ theme: t, marker: "mint" })); }, theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.keyboard.press(`${mod}+j`);
    await useScript(page, TWO_PAGES);
    await input(page).fill("Two trip pages please");
    await input(page).press("Enter");
    const cards = panel(page).getByTestId("tool-card");
    for (const i of [0, 1]) {
      await expect(cards.nth(i)).toHaveAttribute("data-status", "waiting");
      await cards.nth(i).getByRole("button", { name: "Allow" }).click();
      await expect(cards.nth(i)).toHaveAttribute("data-status", "done");
    }
    await expect(panel(page).getByTestId("assistant-message")).toHaveAttribute("data-done", "");
    await expect(page.getByRole("treeitem", { name: "Lisbon trip" })).toBeVisible();
    // Lesende Werkzeuge haben kein Undo; schreibende je eines, 32 px hoch, ganz in der Karte.
    await expect(cards.nth(2).getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    const undo = cards.nth(0).getByRole("button", { name: /^Undo create page/ });
    await expect(undo).toBeVisible();
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const i of [0, 1]) {
        const b = (await cards.nth(i).getByRole("button", { name: /^Undo/ }).boundingBox())!;
        const c = (await cards.nth(i).boundingBox())!;
        expect(b.height, `Höhe md (${w})`).toBeGreaterThanOrEqual(28);
        expect(b.x + b.width, `Knopf bleibt in der Karte (${w})`).toBeLessThanOrEqual(c.x + c.width + 0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `kein waagrechter Rollbalken (${w})`).toBe(true);
      await page.screenshot({ path: `../../docs/design/screens/web-chat-undo-${theme}-${w}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 820 });
    // Den ERSTEN Schritt zurücknehmen, obwohl danach ein zweiter kam: nur die erste Seite verschwindet.
    await undo.click();
    await expect(cards.nth(0).getByTestId("tool-undone")).toHaveText("Undone.");
    await expect(cards.nth(0).getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    // „Undone.“ steht dort, wo der Knopf stand: gleiche Höhe und Mitte wie der Knopf der Nachbarkarte, nichts springt.
    const done = (await cards.nth(0).getByTestId("tool-undone").boundingBox())!;
    const other = (await cards.nth(1).getByRole("button", { name: /^Undo/ }).boundingBox())!;
    const top = async (i: number) => (await cards.nth(i).boundingBox())!.y;
    expect(Math.abs((done.y - (await top(0))) - (other.y - (await top(1))))).toBeLessThanOrEqual(1);
    expect(Math.abs(done.height - other.height)).toBeLessThanOrEqual(1);
    expect(Math.abs((await cards.nth(0).boundingBox())!.height - (await cards.nth(1).boundingBox())!.height), "Karte bleibt gleich hoch").toBeLessThanOrEqual(1);
    await expect(page.getByRole("treeitem", { name: "Lisbon trip" })).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: /^Porto trip/ })).toBeVisible();
    await page.screenshot({ path: `../../docs/design/screens/web-chat-undo-done-${theme}.png` });
    // Per Tastatur: Fokus sichtbar, Enter löst aus.
    const second = cards.nth(1).getByRole("button", { name: /^Undo/ });
    await second.focus();
    await page.keyboard.press("Enter");
    await expect(cards.nth(1).getByTestId("tool-undone")).toHaveText("Undone.");
    await expect(page.getByRole("treeitem", { name: /^Porto trip/ })).toHaveCount(0);
    // Nach dem Neuladen gibt es die Schritte nicht mehr: kein Knopf, der nichts täte. (WebKit behält ohne
    // dauerhaften Kontext nichts über das Neuladen, siehe oben – dort endet der Test hier.)
    if (browserName === "webkit") return;
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(panel(page).getByTestId("tool-card").first()).toHaveAttribute("data-status", "done");
    await expect(panel(page).getByRole("button", { name: /^Undo/ })).toHaveCount(0);
  });
}
