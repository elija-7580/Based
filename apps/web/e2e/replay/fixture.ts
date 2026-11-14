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
 * BSD-407 Teil 3: Aufzeichnung (ProseMirror-Schritte „tr“, Seiten-Y.Doc „yjs“) und Wiedergabe der Fehlerberichte gibt es
 * nur im alten Editor (BlockNote). Tests dafür pinnen ihn (docs/editor-parity.md, „noch BlockNote“).
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
export const editor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();

/** Neue Seite anlegen und öffnen, Schreibmarke in den ersten Block. */
export async function openNewPage(page: Page, title: string): Promise<string> {
  const id = (await command(page, { op: "createPage", title })) as string;
  await page.goto(`/#page-${id}`);
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).locator(".bn-block-content").first().click();
  return id;
}
