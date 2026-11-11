import { expect, test, type Page } from "@playwright/test";

// BSD-90: unverlinkte Erwähnungen unter den Backlinks – Stelle mit dem Seitentitel als Text, „Link“ macht sie zur
// Erwähnung (dann zählt sie als Backlink und der Text in der anderen Seite ist ein Link).

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

test("unverlinkte Erwähnung finden und verlinken", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Launch plan" });
  await command(page, { op: "createPage", title: "Weekly notes" });
  await page.getByRole("treeitem", { name: "Weekly notes" }).click();
  const editor = page.locator(".bn-editor[contenteditable='true']").first();
  await expect(editor).toBeVisible();
  await editor.locator(".bn-block-content").first().click();
  await page.keyboard.type("We reviewed the launch plan today.");
  await page.waitForTimeout(800);

  await page.getByRole("treeitem", { name: "Launch plan" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Launch plan");
  const toggle = page.getByTestId("unlinked-toggle");
  await expect(toggle).toContainText("1 unlinked mention");
  await toggle.click();
  const list = page.getByTestId("unlinked-list");
  await expect(list).toContainText("Weekly notes");
  await expect(list).toContainText("reviewed the launch plan today");
  await list.getByRole("button", { name: /^Link the mention/ }).click();
  await expect(page.getByTestId("backlinks").locator(".backlinks-head").first()).toContainText("1 backlink");
  await expect(toggle).toHaveCount(0);

  // in der anderen Seite ist der Text jetzt eine Erwähnung
  await page.getByRole("treeitem", { name: "Weekly notes" }).click();
  await expect(page.locator(".bn-editor").first().getByText("launch plan", { exact: false }).first()).toBeVisible();
  await expect(page.locator(".bn-editor").first().locator("[data-inline-content-type], .bx-mention").first()).toBeVisible();
});

test("[[Titel]] fertig getippt wird zur Erwähnung – vorhandene Seite oder neu angelegt (BSD-90 Teil 2)", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Launch plan" });
  await command(page, { op: "createPage", title: "Diary" });
  await page.getByRole("treeitem", { name: "Diary" }).click();
  const editor = page.locator(".bn-editor[contenteditable='true']").first();
  await expect(editor).toBeVisible();
  await editor.locator(".bn-block-content").first().click();
  await page.keyboard.type("Today: [[Launch plan]] and [[Brand new idea]] done");
  const mentions = editor.locator("[data-inline-content-type='mention']");
  await expect(mentions).toHaveCount(2);
  await expect(mentions.first()).toContainText("Launch plan");
  await expect(mentions.nth(1)).toContainText("Brand new idea");
  await expect(editor).not.toContainText("[[");
  await expect(page.getByRole("treeitem", { name: "Brand new idea" })).toBeVisible();
  // vorhandene Seite wurde verlinkt, nicht doppelt angelegt
  await expect(page.getByRole("treeitem", { name: "Launch plan" })).toHaveCount(1);
});
