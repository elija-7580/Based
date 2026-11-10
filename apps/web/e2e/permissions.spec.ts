import { expect, test, type Page } from "@playwright/test";

// BSD-245: Berechtigungen im Claude-Code-Stil – Pfad-Regel `deny based.*(path:Privat/**)` verhindert Schreiben unter
// „Privat“ (auch im Chat), Plan-Modus sammelt Änderungen und führt sie erst nach „Run plan“ aus.

type Client = {
  chatTool(name: string, input: unknown): Promise<{ text: string }>;
  findPages(q: string): Promise<{ id: string; title: string }[]>;
  agents(a: unknown): Promise<unknown>;
};

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.waitForFunction(() => "__basedChat" in globalThis && "__based" in globalThis);
}

const pageID = (page: Page, title: string) =>
  page.evaluate(async (t) => {
    const c = (globalThis as unknown as { __based: { client: Client } }).__based.client;
    return (await c.findPages(t)).find((p) => p.title === t)?.id ?? "";
  }, title);

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function useScript(page: Page, steps: unknown[]) {
  await page.evaluate((s) => (globalThis as unknown as { __basedChat: { useScript(s: unknown): void } }).__basedChat.useScript(s), steps);
}

async function ask(page: Page, text: string) {
  const panel = page.getByTestId("chat-panel");
  if (!(await panel.isVisible())) await page.keyboard.press(`${mod}+j`);
  await panel.getByLabel("Ask Based").fill(text);
  await panel.getByLabel("Ask Based").press("Enter");
  return panel;
}

test("Pfad-Regel: unter „Privat“ darf der Chat nichts anlegen, daneben schon", async ({ page }) => {
  await fresh(page);
  await page.evaluate(async () => {
    const c = (globalThis as unknown as { __based: { client: Client } }).__based.client;
    await c.chatTool("create_page", { title: "Privat" });
    await c.chatTool("create_page", { title: "Offen" });
    await c.agents({ op: "saveMain", patch: { rules: "deny based.*(path:Privat/**)" } });
  });
  const privat = await pageID(page, "Privat");
  const offen = await pageID(page, "Offen");
  expect(privat).not.toBe("");
  await useScript(page, [
    { tool: "create_page", input: { title: "Geheim", parent_id: privat } },
    { tool: "create_page", input: { title: "Sichtbar", parent_id: offen } },
    { text: "Done." },
  ]);
  const panel = await ask(page, "Lege zwei Seiten an");
  const cards = panel.getByTestId("tool-card");
  await expect(cards.nth(0)).toHaveAttribute("data-status", "failed");
  // Die zweite fragt (Ask before edits) und läuft nach Allow.
  await expect(cards.nth(1)).toHaveAttribute("data-status", "waiting");
  await cards.nth(1).getByRole("button", { name: "Allow" }).click();
  await expect(cards.nth(1)).toHaveAttribute("data-status", "done");
  expect(await pageID(page, "Geheim")).toBe("");
  expect(await pageID(page, "Sichtbar")).not.toBe("");
});

test("Plan-Modus: Änderung wird gesammelt, „Run plan“ führt sie aus und kehrt zum Modus davor zurück", async ({ page }) => {
  await fresh(page);
  await useScript(page, [{ text: "Plan:" }, { tool: "create_page", input: { title: "Reiseplan" } }, { text: "1. Create the page." }]);
  await page.keyboard.press(`${mod}+j`);
  const panel = page.getByTestId("chat-panel");
  await panel.getByRole("button", { name: /Ask before edits/ }).click();
  await panel.getByRole("option", { name: /Plan first/ }).click();
  await ask(page, "Plane eine Reiseseite");
  const plan = panel.getByTestId("chat-plan");
  await expect(plan).toContainText("Plan ready: 1 change");
  expect(await pageID(page, "Reiseplan")).toBe("");
  await plan.getByRole("button", { name: "Run plan" }).click();
  await expect(plan).toHaveCount(0);
  await expect.poll(() => pageID(page, "Reiseplan")).not.toBe("");
  await expect(panel.getByText("Ran the plan: 1 step.")).toBeVisible();
  await expect(panel.getByRole("button", { name: /Ask before edits/ })).toBeVisible();
});
