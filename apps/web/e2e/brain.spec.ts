import { expect, test, type Page } from "@playwright/test";

// Agent Brain (BSD-198, BSD-199, BSD-163) mit ScriptedEngine – deterministisch, ohne Netz:
// Skills importieren → Chips erscheinen beim Tippen und lassen sich tauschen; Privacy-Redact ersetzt vor der Engine
// und tauscht in der Antwort zurück; eine Antwort mit Quelle springt zum Block; Memory-Vorschlag erst nach „Save“.

const mod = process.platform === "darwin" ? "Meta" : "Control";
const SHOTS = "../../docs/design/screens/";

const SKILLS = [
  { name: "weekly-review.md", text: "---\nname: weekly-review\ndescription: Reflect on the past week and plan priorities for next week.\n---\n\n## Steps\n1. List wins.\n2. Pick three priorities.\n" },
  { name: "weekly-newsletter.md", text: "---\nname: weekly-newsletter\ndescription: Write the weekly newsletter email for subscribers.\n---\n\nGreeting, three links, sign-off.\n" },
  { name: "meeting-notes.md", text: "---\nname: meeting-notes\ndescription: Turn a meeting transcript into notes with decisions and action items.\n---\n\nAttendees, decisions, action items.\n" },
];

async function fresh(page: Page, theme: "light" | "dark" = "light") {
  await page.goto("/");
  await page.evaluate((t) => {
    localStorage.clear();
    localStorage.setItem("based.appearance", JSON.stringify({ theme: t, style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false }));
  }, theme);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const panel = (page: Page) => page.getByTestId("chat-panel");
const input = (page: Page) => panel(page).getByLabel("Ask Based");

async function openChat(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  if (!(await panel(page).isVisible())) await page.keyboard.press(`${mod}+j`);
  await expect(panel(page)).toBeVisible();
  await page.waitForFunction(() => "__basedBrain" in globalThis && "__basedChat" in globalThis);
}

async function useScript(page: Page, script: unknown[]) {
  await page.evaluate((s) => (globalThis as unknown as { __basedChat: { useScript(s: unknown): void } }).__basedChat.useScript(s), script);
}

async function importSkills(page: Page) {
  await page.goto("/#prefs-agents");
  const file = page.getByTestId("skill-import-input");
  await file.setInputFiles(SKILLS.map((s) => ({ name: s.name, mimeType: "text/markdown", buffer: Buffer.from(s.text) })));
  await expect(page.getByRole("status").filter({ hasText: "Imported" })).toContainText("weekly-review");
  await expect(page.getByRole("switch", { name: "weekly-newsletter" })).toBeChecked();
  // Der Brain liegt als echte Seite im Workspace.
  await expect(page.getByRole("treeitem", { name: "Agent Brain" })).toBeVisible();
  await page.goto("/#home");
}

async function skillFlow(page: Page) {
  await importSkills(page);
  await openChat(page);
  await useScript(page, [{ text: "Here is your newsletter draft." }]);
  await input(page).fill("Help me do my weekly review and plan priorities for next week");
  const chips = panel(page).getByTestId("skill-chips");
  await expect(chips.getByTestId("skill-chip")).toHaveCount(1);
  await expect(chips.getByTestId("skill-chip")).toHaveAttribute("data-skill", "weekly-review");
  // Tauschen: der Chip öffnet die übrigen Kandidaten.
  await chips.getByRole("button", { name: "Swap skill weekly-review" }).click();
  await page.getByRole("menuitem", { name: /weekly-newsletter/ }).click();
  await expect(chips.getByTestId("skill-chip")).toHaveAttribute("data-skill", "weekly-newsletter");
  await input(page).press("Enter");
  await expect(panel(page).getByTestId("skill-chips")).toHaveCount(0);
  const answer = panel(page).getByTestId("assistant-message");
  await expect(answer).toHaveAttribute("data-done", "");
  await expect(answer.getByText("weekly-newsletter")).toBeVisible();
  const corrections = await page.evaluate(() => JSON.parse(localStorage.getItem("based.brain.corrections") ?? "[]") as unknown[]);
  expect(corrections).toHaveLength(1);
}

test("skills: import, chips appear while typing, swap, the turn shows the chosen skill", async ({ page }) => {
  await fresh(page);
  await skillFlow(page);
});

async function redactFlow(page: Page) {
  await page.goto("/#prefs-agents");
  await page.getByRole("switch", { name: "Redact sensitive details" }).check();
  await page.goto("/#home");
  await openChat(page);
  await page.evaluate(() => (globalThis as unknown as { __basedBrain: { useEcho(): void } }).__basedBrain.useEcho());
  const msg = "Please mail anna.schmidt@example.org, IBAN DE89 3704 0044 0532 0130 00";
  await input(page).fill(msg);
  await expect(panel(page).getByTestId("sensitive-hint")).toContainText("2 sensitive details will be redacted");
  await input(page).press("Enter");
  const answer = panel(page).getByTestId("assistant-message").last();
  await expect(answer.getByTestId("answer-text")).toContainText("Noted:");
  await expect(answer).toHaveAttribute("data-done", "");
  // Die Engine bekam nur Platzhalter …
  const seen = await page.evaluate(() => (globalThis as unknown as { __basedBrain: { seen: string[] } }).__basedBrain.seen);
  expect(seen.at(-1)).toBe("Please mail <EMAIL_1>, IBAN <IBAN_1>");
  // … die Antwort zeigt die echten Werte.
  await expect(answer.getByTestId("answer-text")).toContainText("Noted: Please mail anna.schmidt@example.org, IBAN DE89 3704 0044 0532 0130 00");
  const chip = answer.getByTestId("redaction-chip");
  await expect(chip).toContainText("2 details redacted");
  await chip.getByRole("button").click();
  await expect(chip).toContainText("Email addresses");
}

test("privacy redact: placeholders go to the engine, the answer gets the real values back", async ({ page }) => {
  await fresh(page);
  await redactFlow(page);
});

test("privacy check (BSD-184): hits shown before sending; redact and send, or send anyway", async ({ page }) => {
  await fresh(page);
  await page.goto("/#prefs-agents");
  await page.getByRole("switch", { name: "Ask before sending sensitive details" }).check();
  await page.goto("/#home");
  await openChat(page);
  await page.evaluate(() => (globalThis as unknown as { __basedBrain: { useEcho(): void } }).__basedBrain.useEcho());
  const seen = () => page.evaluate(() => (globalThis as unknown as { __basedBrain: { seen: string[] } }).__basedBrain.seen);
  const msg = "Please mail anna.schmidt@example.org, IBAN DE89 3704 0044 0532 0130 00";
  await input(page).fill(msg);
  await input(page).press("Enter");
  const check = panel(page).getByTestId("privacy-check");
  await expect(check).toContainText("2 sensitive details");
  await expect(check).not.toContainText("anna.schmidt@example.org");
  await expect(input(page)).toHaveValue(msg);
  expect(await seen()).toEqual([]);
  await check.getByRole("button", { name: "Redact and send" }).click();
  await expect(panel(page).getByTestId("assistant-message").last()).toHaveAttribute("data-done", "");
  expect((await seen()).at(-1)).toBe("Please mail <EMAIL_1>, IBAN <IBAN_1>");
  await expect(input(page)).toHaveValue("");
  await input(page).fill("Call +49 30 1234567 please");
  await input(page).press("Enter");
  await check.getByRole("button", { name: "Send anyway" }).click();
  await expect.poll(async () => (await seen()).at(-1)).toBe("Call +49 30 1234567 please");
});

async function citationFlow(page: Page): Promise<string> {
  await openChat(page);
  // Seite mit zwei Blöcken über das Agent-Werkzeug anlegen und die Block-IDs lesen (wie ein Agent es täte).
  const ids = await page.evaluate(async () => {
    const g = globalThis as unknown as { __basedChat: { controller: { o: { backend: { chatTool(n: string, i: unknown): Promise<{ text: string }> } } } }; __basedBrain: { brain: { client: { tool(n: string, i: unknown): Promise<{ text: string }> } } } };
    const created = await g.__basedChat.controller.o.backend.chatTool("create_page", { title: "Trip budget", markdown: "Flights cost 420 euros.\n\nThe hotel is booked until Friday." });
    const page = /id: ([^)]+)\)/.exec(created.text)![1]!;
    const read = await g.__basedBrain.brain.client.tool("read_page_blocks", { page_id: page });
    const blocks = [...read.text.matchAll(/\[block:([^\]]+)\]/g)].map((m) => m[1]!);
    return { page, blocks };
  });
  expect(ids.blocks).toHaveLength(2);
  await useScript(page, [{ text: `Flights cost 420 euros [[block:${ids.blocks[0]}]] and the hotel is booked until Friday [[block:${ids.blocks[1]}]].` }]);
  await input(page).fill("What do I know about the trip budget?");
  await input(page).press("Enter");
  const answer = panel(page).getByTestId("assistant-message").last();
  await expect(answer.getByTestId("citation")).toHaveCount(2);
  await expect(answer).toHaveAttribute("data-done", "");
  await expect(answer.getByTestId("citation").first()).toHaveText("¹");
  await expect(answer.getByTestId("citation-source")).toHaveCount(2);
  await expect(answer.getByText("Sources")).toBeVisible();
  await expect(answer.getByText("[[block:")).toHaveCount(0);
  await answer.getByTestId("citation").nth(1).click();
  await expect(page).toHaveURL(new RegExp(`#page-${ids.page}`));
  await expect(page.getByTestId("cite-flash")).toHaveAttribute("data-block", ids.blocks[1]!);
  await expect(page.locator(`.bn-block-outer[data-id="${ids.blocks[1]}"]`)).toBeInViewport();
  return ids.page;
}

test("workspace answer with sources: the citation jumps to the block", async ({ page }) => {
  await fresh(page);
  await citationFlow(page);
});

test("memory suggestions are saved only after Save", async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => localStorage.setItem("based.brain", JSON.stringify({ v: 1, memories: { suggest: true } })));
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openChat(page);
  await page.evaluate(() => {
    const g = globalThis as unknown as { __basedBrain: { useExtractor(a: string): void } };
    g.__basedBrain.useExtractor(JSON.stringify({ memories: [{ title: "Coffee", type: "Preference", body: "Drinks espresso without sugar." }] }));
  });
  await useScript(page, [{ text: "Got it." }]);
  await input(page).fill("By the way, I always drink espresso without sugar.");
  await input(page).press("Enter");
  const card = panel(page).getByTestId("memory-suggestion");
  await expect(card).toContainText("Remember: Coffee");
  await expect(page.getByRole("treeitem", { name: "Agent Brain" })).toHaveCount(0);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(panel(page).getByTestId("memory-decided")).toHaveText("Saved to memories: Coffee");
  await expect(page.getByRole("treeitem", { name: "Agent Brain" })).toBeVisible();
});

// Screenshots für docs/design/screens (nur mit BASED_SCREENSHOTS=1, Chromium).
test("Screenshots web-brain-*", async ({ page, browserName }) => {
  test.skip(!process.env.BASED_SCREENSHOTS || browserName !== "chromium", "nur auf Wunsch");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"] as const) {
    await fresh(page, theme);
    await skillFlow(page);
    await redactFlow(page);
    const pageID = await citationFlow(page);
    await page.goto(`/#page-${pageID}`);
    await input(page).fill("Summarize this week's meeting notes and plan priorities for next week");
    await expect(panel(page).getByTestId("skill-chip").first()).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}web-brain-chat-${theme}.png` });
    await page.goto("/#prefs-agents");
    await expect(page.getByTestId("redact-preview")).toBeVisible();
    await page.getByRole("heading", { name: "Skills" }).scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${SHOTS}web-brain-settings-${theme}.png`, fullPage: true });
  }
});

// BSD-163: Löschen des Agent Brain wird verweigert – nicht still, sondern mit Hinweis; die Seite bleibt.
async function refuseTrash(page: Page) {
  await importSkills(page);
  const item = page.getByRole("treeitem", { name: "Agent Brain" });
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  const notice = page.getByTestId("app-notice");
  await expect(notice).toContainText("“Agent Brain” stays: the Agent Brain (About me, Memories, Skills) can't be moved to the Trash.");
  await expect(item).toBeVisible();
  return notice;
}

test("trashing the Agent Brain shows why it stays", async ({ page }) => {
  await fresh(page);
  const notice = await refuseTrash(page);
  // Der Hinweis überdeckt nichts dauerhaft: Dismiss schließt ihn.
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await page.goto("/#trash");
  await expect(page.getByRole("main").getByText("Agent Brain")).toHaveCount(0);
});

// Checkliste (BSD-163): drei Größen, hell und dunkel; der Hinweis passt in die Breite und liegt über dem Inhalt.
test("Screenshots web-brain-refused-*", async ({ page, browserName }) => {
  test.skip(!process.env.BASED_SCREENSHOTS || browserName !== "chromium", "nur auf Wunsch");
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"] as const) {
      await fresh(page, theme);
      const notice = await refuseTrash(page);
      const box = (await notice.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      expect(box.y + box.height).toBeLessThanOrEqual(h);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${SHOTS}web-brain-refused-${w}-${theme}.png` });
    }
  }
});
