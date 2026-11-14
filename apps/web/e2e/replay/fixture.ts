// Eigenes, dauerhaftes Profil pro Test (WebKit hat OPFS nur dort; wie editor-select.spec.ts).
import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinLegacyEditor } from "../legacy-editor.js";

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

/**
 * Alter Editor (BlockNote) für die Specs, die ihn noch prüfen (docs/editor-parity.md, „noch BlockNote“): die
 * mitgelieferten ProseMirror-Bündel der Wiedergabe. Aufzeichnung und Wiedergabe gibt es in beiden Editoren.
 */
export const legacyTest = test.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await pinLegacyEditor(page);
    await use(page);
  },
});

export async function ready(page: Page, hash = "") {
  await page.goto("/" + (hash ? "#" + hash : ""));
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

type W = { __based: { client: { command(c: unknown): Promise<unknown> } } };
export const command = (page: Page, c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as W).__based.client.command(cmd), c);
/** Alter Editor (BlockNote). */
export const legacyEditor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();
/** Block-Editor (ADR 0016, Standard). */
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

/** Wie `openNewPage`, im alten Editor (mit `legacyTest`). */
export async function openNewLegacyPage(page: Page, title: string): Promise<string> {
  const id = await createAndOpen(page, title);
  await expect(legacyEditor(page)).toHaveAttribute("contenteditable", "true");
  await legacyEditor(page).locator(".bn-block-content").first().click();
  return id;
}
