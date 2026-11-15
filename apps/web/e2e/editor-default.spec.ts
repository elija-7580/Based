import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dauerhaftes Profil je Test: WebKit hat OPFS nur dort, und die Tests laden neu.
const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-default-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});


// BSD-407: Der Block-Editor (ADR 0016) ist der einzige Editor – auch auf Geräten, auf denen der frühere Schalter
// „New editor“ (`based.newEditor`) auf „aus“ stand oder der Notausgang „Old editor (BlockNote)“ (`based.legacyEditor`,
// Teil 3) an war. Beide Schlüssel werden beim Start einmalig entfernt; den Notausgang gibt es seit Teil 4 nicht mehr.

async function openNewPage(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based;
    return b.client.command({ op: "createPage", title: "Default editor" });
  });
  await page.goto(`/#page-${id}`);
  return id;
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test("frisches Gerät: Block-Editor", async ({ page }) => {
  await openNewPage(page);
  await expect(page.getByTestId("block-editor")).toBeVisible();
});

test("früher „New editor: aus“ (bewusst false): einmalig auf den Block-Editor umgestellt, alter Schlüssel weg", async ({ page }) => {
  await page.addInitScript(() => {
    // nur beim ersten Laden setzen: so prüft das Neuladen, dass der Schlüssel nicht wiederkommt
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("based.newEditor", "false");
    }
  });
  await openNewPage(page);
  await expect(page.getByTestId("block-editor")).toBeVisible();
  expect(await stored(page, "based.newEditor")).toBeNull();
  expect(await stored(page, "based.legacyEditor")).toBeNull();
  await page.reload();
  await expect(page.getByTestId("block-editor")).toBeVisible();
  expect(await stored(page, "based.newEditor")).toBeNull();
});

test("früher Notausgang „Old editor“ an: Block-Editor, Schlüssel weg, kein Schalter mehr in Diagnostics", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("based.legacyEditor", "true");
    }
  });
  const id = await openNewPage(page);
  await expect(page.getByTestId("block-editor")).toBeVisible();
  expect(await stored(page, "based.legacyEditor")).toBeNull();
  await page.goto("/#prefs-diagnostics");
  await expect(page.getByRole("switch", { name: "Developer view" })).toBeVisible();
  await expect(page.getByRole("switch", { name: /Old editor/ })).toHaveCount(0);
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
});
