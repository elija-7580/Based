import { expect, test, type Page } from "@playwright/test";
import { LEGACY_EDITOR_KEY, pinLegacyEditor } from "./legacy-editor.js";

// BSD-407 Teil 3: Der Block-Editor (ADR 0016) ist für alle Standard – auch auf Geräten, auf denen der frühere Schalter
// „New editor“ (`based.newEditor`) bewusst oder unbewusst auf „aus“ stand. Der alte Editor (BlockNote) bleibt bis Teil 4
// als Notausgang unter Settings → Diagnostics, Standard aus.

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
  await expect(page.locator(".bn-editor")).toHaveCount(0);
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
  await expect(page.locator(".bn-editor")).toHaveCount(0);
  expect(await stored(page, "based.newEditor")).toBeNull();
  expect(await stored(page, LEGACY_EDITOR_KEY)).toBeNull();
  await page.reload();
  await expect(page.getByTestId("block-editor")).toBeVisible();
  expect(await stored(page, "based.newEditor")).toBeNull();
});

test("Notausgang: alter Editor in Settings → Diagnostics, Standard aus, wirkt beim Öffnen der Seite", async ({ page }) => {
  const id = await openNewPage(page);
  await expect(page.getByTestId("block-editor")).toBeVisible();
  await page.goto("/#prefs-diagnostics");
  const toggle = page.getByRole("switch", { name: "Old editor (BlockNote)" });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(await stored(page, LEGACY_EDITOR_KEY)).toBe("true");
  await page.goto(`/#page-${id}`);
  await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
  await expect(page.getByTestId("block-editor")).toHaveCount(0);

  // zurück: Schalter aus → wieder der Block-Editor
  await page.goto("/#prefs-diagnostics");
  await page.getByRole("switch", { name: "Old editor (BlockNote)" }).click();
  await page.goto(`/#page-${id}`);
  await expect(page.getByTestId("block-editor")).toBeVisible();
});

test("gepinnter alter Editor (Helfer der Specs) bleibt über das Neuladen", async ({ page }) => {
  await pinLegacyEditor(page);
  await openNewPage(page);
  await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
  await page.reload();
  await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
});
