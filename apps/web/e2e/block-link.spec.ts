import { expect, test, type Page } from "@playwright/test";

// BSD-101: „Copy link to block“ im Blockmenü; ein Block-Link (#page-<id>/<block>) öffnet die Seite, scrollt zum Block
// und hebt ihn kurz hervor.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

test("Link zu einem Block kopieren und öffnen", async ({ page, context, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const pageID = await command(page, { op: "createPage", title: "Long read" }) as string;
  await page.getByRole("treeitem", { name: "Long read" }).click();
  const editor = page.locator(".bn-editor[contenteditable='true']").first();
  await editor.locator(".bn-block-content").first().click();
  for (let i = 1; i <= 30; i++) {
    await page.keyboard.type(`Line ${i}`);
    if (i < 30) await page.keyboard.press("Enter");
  }
  const target = editor.locator(".bn-block-outer", { has: page.locator(".bn-inline-content", { hasText: /^Line 27$/ }) }).last();
  const blockID = await target.getAttribute("data-id");
  expect(blockID).toBeTruthy();

  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await target.locator(".bn-block-content").hover();
    await page.locator(".bn-side-menu [draggable=true]").first().click();
    await page.getByRole("menuitem", { name: "Copy link to block" }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`#page-${pageID}/${blockID}`);
  }

  await page.waitForTimeout(600);
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home" }).click();
  await page.evaluate(([p, b]) => { location.hash = `page-${p}/${b}`; }, [pageID, blockID!]);
  const again = page.locator(`.bn-block-outer[data-id="${blockID}"]`).first();
  await expect(again).toBeInViewport();
  await expect(page.locator(".bx-editor").first()).toHaveAttribute("data-flash-block", blockID!);
});
