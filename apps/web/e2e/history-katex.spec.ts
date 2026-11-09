import { expect, test, type Page } from "@playwright/test";

// BSD-73 Versionsverlauf und BSD-10 Gleichungen (KaTeX offline) in der Shell, auf Chromium und WebKit.

async function openWelcome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.locator(".bn-editor[contenteditable='true']")).toBeVisible();
}

/** Schreibmarke ans Ende der letzten To-do-Zeile der Willkommensseite, dann neue Zeile. */
async function newLineAtEnd(page: Page) {
  const last = page.locator(".bn-editor").getByText("Pages you delete wait in the Trash");
  const box = (await last.boundingBox())!;
  await last.click({ position: { x: box.width - 2, y: box.height / 2 } });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
}

async function openHistory(page: Page) {
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("Versionsverlauf: Seite ändern → Version → Restore holt alten Inhalt, neuer Stand bleibt als Version, Undo", async ({ page }) => {
  await openWelcome(page);
  await newLineAtEnd(page);
  await page.keyboard.type("Neuer Absatz für den Verlauf");
  const editor = page.locator(".bn-editor");
  await expect(editor.getByText("Neuer Absatz für den Verlauf")).toBeVisible();
  await page.waitForTimeout(500); // Editor schreibt gesammelt in den Store

  // Version erscheint: neueste = Stand mit Absatz, gewählt ist die davor (ohne Absatz)
  let dialog = await openHistory(page);
  const rows = dialog.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  const preview = dialog.getByTestId("version-preview");
  await expect(preview.getByText("Start here")).toBeVisible();
  await expect(preview.getByText("Neuer Absatz für den Verlauf")).toHaveCount(0);
  await rows.nth(0).click();
  await expect(preview.getByText("Neuer Absatz für den Verlauf")).toBeVisible();
  await rows.nth(1).click();
  await expect(dialog.getByText(/block differs from now|blocks differ from now/)).toBeVisible();

  // Wiederherstellen (mit Rückfrage)
  await dialog.getByRole("button", { name: "Restore" }).click();
  await dialog.getByRole("alertdialog").getByRole("button", { name: "Restore" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("restored-banner")).toBeVisible();
  await expect(editor.getByText("Neuer Absatz für den Verlauf")).toHaveCount(0);
  await expect(editor.getByText("Start here")).toBeVisible();

  // Der neue Stand ist als Version erhalten
  dialog = await openHistory(page);
  await expect(dialog.getByRole("option")).toHaveCount(3);
  await expect(dialog.getByRole("option").nth(0)).toContainText("restored");
  await expect(dialog.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByTestId("version-preview").getByText("Neuer Absatz für den Verlauf")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Undo nimmt das Wiederherstellen zurück
  await page.getByTestId("restored-banner").getByRole("button", { name: "Undo" }).click();
  await expect(editor.getByText("Neuer Absatz für den Verlauf")).toBeVisible();
});

test("Gleichungen rendern offline mit KaTeX und lassen sich bearbeiten", async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  // Netz blockiert: nur der eigene Server antwortet.
  const origin = new URL(baseURL!).origin;
  const outside: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("blob:") || url.startsWith("data:")) return route.continue();
    outside.push(url);
    return route.abort("internetdisconnected");
  });
  await openWelcome(page);
  const editor = page.locator(".bn-editor");

  // Block-Gleichung über das Slash-Menü
  await newLineAtEnd(page);
  await page.keyboard.type("/equation");
  await page.getByRole("option", { name: /Block equation/ }).click();
  const field = editor.locator("textarea.bx-field");
  await expect(field).toBeFocused();
  await field.fill("\\frac{a}{b} = \\sqrt{x^2}");
  await expect(editor.locator(".bx-equation-preview .katex-display")).toBeVisible(); // Vorschau beim Tippen
  await field.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  const block = editor.locator(".bx-equation-view");
  await expect(block.locator(".katex-display")).toBeVisible();
  await expect(block.locator(".katex-mathml")).toContainText("a");

  // KaTeX-Schriften sind geladen (aus dem Bundle, nicht aus dem Netz)
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.family.includes("KaTeX") && f.status === "loaded").length;
  });
  expect(fonts).toBeGreaterThan(0);

  // Bearbeiten: Fehler wird angezeigt statt abzustürzen, dann korrigieren
  await block.click();
  await expect(field).toHaveValue("\\frac{a}{b} = \\sqrt{x^2}");
  await field.fill("\\frac{a}{");
  await expect(editor.locator(".bx-equation-preview [data-testid='equation-error']")).toBeVisible();
  await field.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect(block.getByTestId("equation-error")).toBeVisible();
  await block.click();
  await field.fill("E = mc^2");
  await field.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect(block.locator(".katex-display .katex-mathml")).toContainText("E");
  await expect(block.getByTestId("equation-error")).toHaveCount(0);

  // Gleichung im Text
  await newLineAtEnd(page);
  await page.keyboard.type("Fläche ");
  await page.keyboard.type("/inline");
  await page.getByRole("option", { name: /Inline equation/ }).click();
  const inlineField = editor.getByRole("textbox", { name: "Inline equation" });
  await expect(inlineField).toBeFocused();
  await inlineField.fill("\\pi r^2");
  await inlineField.press("Enter");
  const inline = editor.locator(".bx-inline-eq .katex").last();
  await expect(inline).toBeVisible();
  await expect(inline.locator(".katex-mathml")).toContainText("π");
  await editor.getByRole("button", { name: "Edit inline equation" }).last().locator(".katex-html").click(); // auf die Formel
  await expect(inlineField).toHaveValue("\\pi r^2");
  await inlineField.fill("\\pi r^2 h");
  await inlineField.press("Enter");
  await expect(editor.locator(".bx-inline-eq .katex .katex-mathml").last()).toContainText("h");

  expect(outside).toEqual([]);
});
