import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 2 zusammen: Editor (@based/editor) und Datenbank-Ansichten (@based/database-ui) in der Shell, Daten bleiben
// nach dem Neuladen (OPFS, dauerhaftes Profil wie im Shell-Test).
test("Editor und Datenbank in der Shell, nach dem Neuladen noch da", async ({ playwright, browserName, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), "based-phase2-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");

    // Editor: neuen Absatz am Ende der Willkommensseite schreiben.
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
    await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
    const last = page.getByText("Pages you delete wait in the Trash");
    const box = (await last.boundingBox())!;
    await last.click({ position: { x: box.width - 1, y: box.height / 2 } }); // Schreibmarke ans Zeilenende
    await page.keyboard.press("Enter");
    await page.keyboard.type("Geschrieben im neuen Editor");
    await expect(page.getByText("Geschrieben im neuen Editor")).toBeVisible();

    // Datenbank anlegen (Home → New database): Tabelle mit Spalten Name und Tags.
    await page.getByRole("button", { name: "Home" }).click();
    await page.getByRole("button", { name: "New database" }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Untitled database");
    await expect(page.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "Untitled database" })).toBeVisible();

    await page.waitForTimeout(500); // Editor schreibt gesammelt (~120 ms) in den Store
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByRole("treeitem", { name: "Untitled database" })).toBeVisible();
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
    await expect(page.getByText("Geschrieben im neuen Editor")).toBeVisible();
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
