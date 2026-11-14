import { expect, test, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";

// Feedback 10. Nov.: die Oberfläche ließ sich verschieben (Dokument scrollte/federte, Kopfzeile wanderte weg),
// Seitenleiste nicht in der Breite änderbar, „/Database – Inline“ legte keine Datenbank an, Datenbankseiten schmal.

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("Dokument scrollt nie, die Kopfzeile bleibt beim Scrollen der Seite stehen", async ({ page }) => {
  await ready(page);
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expectEditable(page);
  await page.setViewportSize({ width: 1100, height: 360 }); // Willkommensseite länger als das Panel
  const top = page.locator(".topbar");
  const before = (await top.boundingBox())!.y;

  await page.locator(".panel").hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.locator(".panel").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => [document.scrollingElement!.scrollTop, document.body.scrollTop])).toEqual([0, 0]);
  expect((await top.boundingBox())!.y).toBe(before);
  await expect(top).toBeInViewport();
  // Programmgesteuertes Scrollen (Fokus, scrollIntoView) verschiebt das Dokument ebenfalls nicht.
  await page.evaluate(() => window.scrollTo(0, 500));
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
});

test("Seitenleiste: Breite ziehen (gemerkt), ⌘\\ blendet aus und ein", async ({ page }) => {
  await ready(page);
  const sidebar = page.locator("nav.sidebar");
  const w0 = (await sidebar.boundingBox())!.width;
  const handle = page.getByTestId("sidebar-resize");
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 80, h.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(w0 + 80));

  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(w0 + 80));

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(sidebar).toBeHidden();
  await expect(page.getByTestId("sidebar-show")).toBeVisible();
  await page.getByTestId("sidebar-show").click();
  await expect(sidebar).toBeVisible();
});

test("„/Database – Inline“ legt eine echte Datenbank an; Datenbankseiten nutzen die volle Breite", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  await expect(page.locator(".bx-database-placeholder")).toHaveCount(0);
  await expect(page.locator(".shell-database.inline").getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New database" }).click();
  await expect(page.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  const panel = (await page.locator(".panel").boundingBox())!;
  const db = (await page.locator(".shell-database.full").boundingBox())!;
  expect(db.width).toBeGreaterThan(panel.width * 0.85);
});

test("Fokusrahmen per Tastatur neutral (Token focus-ring, nicht Marker – BSD-367)", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Home" }).focus();
  await page.keyboard.press("Tab");
  const [outline, marker] = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const probe = document.createElement("i");
    probe.style.color = "var(--focus-ring)";
    document.body.append(probe);
    const m = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(el).outlineColor, m];
  });
  expect(outline).toBe(marker);
});

test("Letzten Tab schließen (⌘W) führt zur selbst gewählten Startseite", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page.getByTestId("settings-section-start-page")).toBeVisible();
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  const pageID = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/?page-/, ""));
  await page.evaluate((v) => localStorage.setItem("based.startPage", JSON.stringify(v)), pageID);
  // BSD-281: Graph ist ein Reiter der Library
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  await expect(page.getByTestId("based-root")).toBeVisible();
});

test("Rad über einer Inline-Datenbank scrollt die Seite weiter (Elija 11.11.)", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await ready(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New page" }).first().click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/database");
  await page.getByRole("option", { name: "Database", exact: true }).click();
  const db = page.locator(".shell-database.inline");
  await expect(db.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible();
  // Seite länger machen als das Fenster
  await page.locator(".page-title").click();
  for (let i = 0; i < 30; i++) await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 1200, height: 420 });
  const scroller = await db.evaluateHandle((el) => {
    let p: HTMLElement | null = el.parentElement;
    while (p) { const s = getComputedStyle(p); if ((s.overflowY === "auto" || s.overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p; p = p.parentElement; }
    return document.scrollingElement as HTMLElement;
  });
  await db.scrollIntoViewIfNeeded();
  // Je nach Schrift der Umgebung steht die Datenbank am Seitenende (dann ist nach unten kein Platz mehr) und ragt
  // unten aus dem Fenster. Also: in die Richtung drehen, in der Platz ist, und den Zeiger sicher im Fenster halten.
  const { before, room } = await scroller.evaluate((el) => { const e = el as HTMLElement; return { before: e.scrollTop, room: e.scrollHeight - e.clientHeight - e.scrollTop }; });
  const down = room > 120;
  const box = (await db.boundingBox())!;
  const y = Math.min(Math.max(box.y, 0) + Math.min(box.height / 2, 100), 400);
  await page.mouse.move(box.x + box.width / 2, y);
  await expect.poll(() => page.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest(".shell-database.inline"), [box.x + box.width / 2, y])).toBe(true);
  await page.mouse.wheel(0, down ? 200 : -200);
  await expect.poll(() => scroller.evaluate((el, b) => (el as HTMLElement).scrollTop - b, before).then((d) => d * (down ? 1 : -1))).toBeGreaterThan(50);
});
