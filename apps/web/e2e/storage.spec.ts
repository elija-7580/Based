import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { blockEditor, expectEditable } from "./editor-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-330: Nebendateien (history.sqlite, ydocs.sqlite) liegen dauerhaft im OPFS – der Versionsverlauf übersteht das
// Neuladen (vorher fiel er wegen eines zweiten OPFS-Pools still in den Speicher, BSD-300). Fällt eine Nebendatei
// doch zurück, sagt es die Oberfläche: Hinweis beim Start, Settings → Sync & server und Diagnostics.

// WebKit hat OPFS nur in einem dauerhaften Profil (wie shell.spec „Neuladen behält Daten“): je Test ein eigenes.
let ctx: BrowserContext;
let dir: string;
test.beforeEach(async ({ playwright, browserName, baseURL }) => {
  dir = mkdtempSync(join(tmpdir(), "based-opfs-"));
  ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
});
test.afterEach(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});
const tab = async () => ctx.pages()[0] ?? (await ctx.newPage());

async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function versions(page: Page) {
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expectEditable(page);
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addParagraph(page: Page, text: string) {
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  const last = blockEditor(page).getByText("Pages you delete wait in the Trash");
  const box = (await last.boundingBox())!;
  await last.click({ position: { x: box.width - 2, y: box.height / 2 } });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
  await expect(blockEditor(page).getByText(text)).toBeVisible();
  await page.waitForTimeout(500); // Editor schreibt gesammelt in den Store
}

test("Versionsverlauf übersteht das Neuladen; keine Speicher-Warnung", async () => {
  const page = await tab();
  await ready(page);
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
  await addParagraph(page, "Absatz für den Verlauf");
  let dialog = await versions(page);
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  dialog = await versions(page);
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await expect(dialog.getByTestId("version-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("app-notice")).toHaveCount(0);

  await page.goto("/#prefs-diagnostics");
  await expect(page.getByTestId("diagnostics-storage")).toHaveText("Persistent (OPFS)");
});

test("erzwungener Speicher-Fallback von history.sqlite ist sichtbar, nicht nur in der Konsole", async () => {
  const page = await tab();
  await ready(page, "/?based-fail-store=history");
  const notice = page.getByTestId("app-notice");
  await expect(notice).toContainText("Version history is kept in memory only (history.sqlite: forced by test).");
  await expect(notice).toContainText("It is lost when you reload");
  await page.goto("/?based-fail-store=history#prefs-diagnostics");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("diagnostics-storage")).toContainText("Persistent (OPFS) · Version history is kept in memory only");
  // BSD-319: Das Log zeigt Stufen als eigene Spalte (data-level) – die Warnung steht als Zeile der Stufe „warning“ drin.
  await expect(page.getByTestId("diagnostics-log").locator("[data-level=warning]", { hasText: "status: local · Version history is kept in memory only" })).toHaveCount(1);
  await page.goto("/?based-fail-store=history#prefs-sync");
  await expect(page.getByTestId("sync-storage-warning")).toContainText("Version history is kept in memory only");
});

// Checkliste (BSD-330): Diagnostics mit Warnung in drei Größen, hell und dunkel; die Zeile bricht um statt zu kürzen.
test("Screenshots web-storage-warning-*", async ({ browserName }) => {
  test.skip(!process.env.BASED_SCREENSHOTS || browserName !== "chromium", "nur auf Wunsch");
  const page = await tab();
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"] as const) {
      await ready(page, "/?based-fail-store=history");
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t, style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false })), theme);
      await page.goto("/?based-fail-store=history#prefs-diagnostics");
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      const row = page.getByTestId("diagnostics-storage");
      await expect(row).toContainText("Version history is kept in memory only");
      const box = (await row.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      await expect(page.getByTestId("app-notice")).toBeVisible();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `../../docs/design/screens/web-storage-warning-${w}-${theme}.png` });
    }
  }
});
