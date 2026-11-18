import { expect, test, type Page } from "@playwright/test";

// Markdown auf dem Board (Elija 18.11.): Zettel und Text zeigen Markdown formatiert, Enter setzt Listen fort,
// ⌘B fettet, ein Klick aufs Kästchen hakt eine Aufgabe ab. Die Fläche ist ein Canvas – geprüft wird der gespeicherte
// Text (Eingabefeld beim erneuten Öffnen) und per Bildschirmfoto.

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function newBoard(page: Page) {
  await page.keyboard.press("ControlOrMeta+n");
  const palette = page.getByTestId("new-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("board");
  await palette.getByRole("option", { name: "New board" }).click();
  const board = page.getByTestId("board");
  await expect(board).toBeVisible();
  return board;
}

test("Markdown auf dem Board: Listen fortsetzen, ⌘B, Aufgabe per Klick abhaken", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fresh(page);
  const board = await newBoard(page);
  const b = (await board.boundingBox())!;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;

  // Zettel mit Überschrift und Aufgaben; Enter setzt „- [ ] “ fort, Enter auf leerem Punkt beendet die Liste (wie in Notion: die Zeile bleibt, der Punkt geht).
  await page.getByTestId("board-tool-note").click();
  await page.mouse.click(cx - 260, cy - 120);
  const edit = page.getByTestId("board-edit");
  await expect(edit).toBeFocused();
  await page.keyboard.type("## Einkauf");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] Milch");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Brot");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("ganz ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("wichtig");
  await expect(edit).toHaveValue("## Einkauf\n- [ ] Milch\n- [ ] Brot\nganz **wichtig**");
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);

  // Text-Objekt mit Inline-Markdown, Code und Liste.
  await page.keyboard.press("t");
  await page.mouse.click(cx + 20, cy - 140);
  await expect(edit).toBeFocused();
  await page.keyboard.type("# Markdown\nText mit *kursiv*, `code` und ~~alt~~ und ==markiert==.\n1. eins");
  await page.keyboard.press("Enter");
  // Enter auf dem leeren „3. “ beendet die Liste.
  await page.keyboard.type("zwei\n\n> Ein Zitat\n\n```\nconst a = 1;\n```");
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);
  await expect(board).toHaveAttribute("data-objects", "2");

  // Kästchen „Milch“ anklicken: hakt ab. Der Zettel (168 × 150) liegt mittig um den Klick, das Textfeld 14 px
  // eingerückt; darüber steht die Überschrift (18.75 px × 1.25).
  const note = { x: cx - 260 - 84 + 14 + 7, y: cy - 120 - 75 + 14 + 23.4 + 10.5 };
  await page.mouse.click(note.x, note.y);
  await page.screenshot({ path: "test-results/board-markdown-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/board-markdown-dark.png" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.mouse.dblclick(cx - 260 + 40, cy - 120 + 40);
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue("## Einkauf\n- [x] Milch\n- [ ] Brot\nganz **wichtig**");
});
