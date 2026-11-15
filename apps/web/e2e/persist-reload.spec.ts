import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorFields, expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-416: „neu angelegte Seite fehlt nach sofortigem Neuladen (WebKit, ‚Not saved‘)“. Ursache war das Testprofil:
// Playwright startet WebKit sonst ohne dauerhaftes Profil, dort gibt es kein OPFS und der Workspace läuft im Speicher
// – die Kopfzeile sagt dann zu Recht „Not saved“. Hier: dauerhaftes Profil in beiden Browsern, Seite anlegen, tippen
// und SOFORT neu laden (ohne auf den Store-Worker zu warten) → Seite und Text sind da. Und im flüchtigen Profil sagt
// die Oberfläche ehrlich, dass nichts gespeichert wird.

test.describe.configure({ timeout: 90_000 });

async function newTopLevelPage(page: Page, title: string) {
  const header = page.locator(".tree-header", { hasText: "Private" });
  await header.hover();
  await page.getByRole("button", { name: "New page in Private" }).click();
  const field = page.getByLabel("Page title");
  await expect(field).toHaveValue("");
  await field.fill(title);
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
}

test("BSD-416: anlegen, tippen, sofort neu laden → Seite und Text da (dauerhaftes Profil)", async ({ playwright, browserName, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), "based-reload-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // Fragt die Seite beim Neuladen nach (BSD-336: Änderung noch nicht gespeichert), lassen wir sie trotzdem gehen –
    // dann muss der Test zeigen, ob dabei etwas verloren geht.
    let asked = 0;
    page.on("dialog", (d) => { asked += 1; void d.accept(); });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    for (let round = 1; round <= 3; round++) {
      const title = `Reload ${round}`;
      await newTopLevelPage(page, title);
      await expectEditable(page);
      await focusEditorEnd(page);
      await page.keyboard.type(`typed line ${round}`);
      await expect(editorFields(page).filter({ hasText: `typed line ${round}` })).toHaveCount(1);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
      await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
      await page.getByRole("treeitem", { name: title }).click();
      await expect(page.getByLabel("Page title")).toHaveValue(title);
      await expect(editorFields(page).filter({ hasText: `typed line ${round}` })).toHaveCount(1);
    }
    test.info().annotations.push({ type: "unload-guard", description: `asked ${asked}×` });
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BSD-416: ohne OPFS (flüchtiges WebKit-Profil) sagt die Seitenleiste „Not saved“", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "Chromium hat OPFS auch im flüchtigen Profil");
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "memory");
  await expect(page.getByTestId("sync-status")).toContainText(/Not saved/);
});
