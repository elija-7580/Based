// Eigenes, dauerhaftes Profil pro Test (WebKit hat OPFS nur dort).
import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-report-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

export async function ready(page: Page, hash = "") {
  await page.goto("/" + (hash ? "#" + hash : ""));
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

type W = { __based: { client: { command(c: unknown): Promise<unknown> } } };
export const command = (page: Page, c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as W).__based.client.command(cmd), c);
/** Block-Editor (ADR 0016). */
export const editor = (page: Page) => page.getByTestId("block-editor");

async function createAndOpen(page: Page, title: string): Promise<string> {
  const id = (await command(page, { op: "createPage", title })) as string;
  await page.goto(`/#page-${id}`);
  return id;
}

/** Neue Seite im Block-Editor anlegen und öffnen, Schreibmarke in den ersten Block. */
export async function openNewPage(page: Page, title: string): Promise<string> {
  const id = await createAndOpen(page, title);
  await expect(editor(page)).toBeVisible();
  await editor(page).getByTestId("block-editor-tail").click();
  await expect(editor(page).locator("[data-editable-id]").first()).toBeFocused();
  return id;
}
