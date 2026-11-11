import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-249: Blöcke ziehen wie in Notion – davor/dahinter, nach rechts verschachteln, nach links ausrücken, an den Rand
// für Spalten (bis 5, zurückziehen löst leere Spalten auf), ein Undo-Schritt, bleibt nach dem Neuladen. Screenshots
// der Einfügelinien (hell/dunkel) nur mit BASED_SCREENSHOTS=1 in Chromium: docs/design/screens/web-editor-drag-*.png.

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

// Jeder Test in einem eigenen, dauerhaften Profil: WebKit hat OPFS nur dort (wie Shell- und Tab-Tests), und die
// Tests laden neu.
const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-editor-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 720 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

async function fresh(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

async function createPage(page: Page, title: string): Promise<string> {
  const id = await command(page, { op: "createPage", title });
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
  return id as string;
}

const editor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  }, theme);
  await expect(page.locator(".bn-container").first()).toHaveAttribute("data-color-scheme", theme);
}

const settled = (page: Page) => page.waitForTimeout(600);
test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => fresh(page));

const block = (page: Page, text: string) => editor(page).locator(".bn-block-outer", { has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }) }).last();
const content = (page: Page, text: string) => editor(page).locator(".bn-block-content", { has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }) }).last();

/** Griff ⋮⋮ des Blocks fassen und an (x, y) relativ zum Inhalt von `onto` loslassen; `shot` hält die Linie fest. */
async function dragBlock(page: Page, text: string, onto: string, at: (b: { x: number; y: number; width: number; height: number }) => { x: number; y: number }, shot?: string) {
  await content(page, text).hover();
  const handle = page.locator(".bn-side-menu [draggable=true]").first();
  await expect(handle).toBeVisible();
  let h = await handle.boundingBox();
  for (let i = 0; !h && i < 20; i++) {
    await page.waitForTimeout(50);
    await content(page, text).hover();
    h = await handle.boundingBox();
  }
  if (!h) throw new Error("no drag handle for " + text);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  // Erst ein Stück auf dem Griff bewegen, damit das Ziehen beginnt, bevor der Zeiger ihn verlässt.
  await page.mouse.move(h.x + h.width / 2 + 6, h.y + h.height / 2 + 6, { steps: 6 });
  const target = (await content(page, onto).boundingBox())!;
  const p = at(target);
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await page.mouse.move(p.x + 1, p.y, { steps: 2 });
  if (shot && SHOTS && test.info().project.name === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-drag-${shot}-${theme}.png` });
    }
    await setTheme(page, "light");
  }
  await page.mouse.up();
}

const columns = (page: Page) => editor(page).locator(".bn-block-outer:has(> .bn-block > .react-renderer > .bn-block-content[data-content-type=column])");
/** Texte je Spalte. */
const columnTexts = (page: Page) => columns(page).evaluateAll((cs) => cs.map((c) => [...c.querySelectorAll(".bn-inline-content")].map((e) => e.textContent)));
/** Text des Elternblocks (oder "" oben im Dokument). */
const parentOf = (page: Page, text: string) => block(page, text).evaluate((el) => {
  const p = el.parentElement?.closest(".bn-block-outer");
  return p ? p.querySelector(".bn-inline-content")?.textContent ?? "(atom)" : "";
});
const topOrder = (page: Page) => editor(page).locator(":scope > .bn-block-group > .bn-block-outer").evaluateAll((os) => os.map((o) => o.querySelector(".bn-inline-content")?.textContent ?? "(columns)"));

async function setup(page: Page) {
  await createPage(page, "Drag");
  await openPage(page, "Drag");
  const first = editor(page).locator(".bn-block-content").first();
  await first.click();
  for (const t of ["Alpha", "Beta", "Gamma", "Delta", "Omega"]) {
    await page.keyboard.type(t);
    if (t !== "Omega") await page.keyboard.press("Enter");
  }
  await expect(topOrder(page)).resolves.toEqual(["Alpha", "Beta", "Gamma", "Delta", "Omega"]);
}

test("Ziehen: davor/dahinter, verschachteln, ausrücken; ein Undo-Schritt; nach dem Neuladen gleich", async ({ page }) => {
  await setup(page);
  // Omega vor Beta (obere Hälfte)
  await dragBlock(page, "Omega", "Beta", (b) => ({ x: b.x + 20, y: b.y + 3 }));
  await expect.poll(() => topOrder(page)).toEqual(["Alpha", "Omega", "Beta", "Gamma", "Delta"]);
  // Gamma nach rechts unter Beta: wird Kind von Beta
  await dragBlock(page, "Gamma", "Beta", (b) => ({ x: b.x + 60, y: b.y + b.height - 3 }), "nest");
  await expect.poll(() => parentOf(page, "Gamma")).toBe("Beta");
  // Delta ebenfalls hinein, hinter Gamma (untere Hälfte von Gamma, gleiche Ebene)
  await dragBlock(page, "Delta", "Gamma", (b) => ({ x: b.x + 4, y: b.y + b.height - 3 }));
  await expect.poll(() => parentOf(page, "Delta")).toBe("Beta");
  // Undo nimmt nur das letzte Ziehen zurück
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => parentOf(page, "Delta")).toBe("");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => parentOf(page, "Delta")).toBe("Beta");
  // Delta (letztes Kind) nach links: ausgerückt hinter Beta
  await dragBlock(page, "Gamma", "Delta", (b) => ({ x: b.x - 40, y: b.y + b.height - 3 }), "outdent");
  await expect.poll(() => parentOf(page, "Gamma")).toBe("");
  await expect.poll(() => topOrder(page)).toEqual(["Alpha", "Omega", "Beta", "Gamma"]);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Drag");
  await expect.poll(() => topOrder(page)).toEqual(["Alpha", "Omega", "Beta", "Gamma"]);
  await expect.poll(() => parentOf(page, "Delta")).toBe("Beta");
});

test("Mehrere ausgewählte Blöcke gemeinsam ziehen (Esc-Blockauswahl, ⇧↓); ein Undo-Schritt", async ({ page }) => {
  await setup(page);
  // Beta und Gamma als Blockauswahl
  await content(page, "Beta").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".bx-doc[data-block-selection]").first()).toHaveAttribute("data-block-selection", /^\S+ \S+$/);
  // am Griff von Beta fassen und hinter Omega fallen lassen: beide wandern mit, Reihenfolge bleibt
  await dragBlock(page, "Beta", "Omega", (b) => ({ x: b.x + 4, y: b.y + b.height - 3 }));
  await expect.poll(() => topOrder(page)).toEqual(["Alpha", "Delta", "Omega", "Beta", "Gamma"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => topOrder(page)).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Omega"]);
});

test("Auto-Scroll: Ziehen am unteren Rand scrollt die Seite weiter", async ({ page }) => {
  await createPage(page, "Long");
  await openPage(page, "Long");
  await editor(page).locator(".bn-block-content").first().click();
  for (let i = 1; i <= 40; i++) {
    await page.keyboard.type(`Line ${i}`);
    if (i < 40) await page.keyboard.press("Enter");
  }
  // der scrollbare Bereich um den Editor
  const scrollTop = () => page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    if (!el) return -1;
    return el.scrollTop;
  });
  await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)); if (el) el.scrollTop = 0; });
  expect(await scrollTop()).toBe(0);
  await content(page, "Line 2").hover();
  const handle = page.locator(".bn-side-menu [draggable=true]").first();
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 6, h.y + h.height / 2 + 6, { steps: 6 });
  const vh = page.viewportSize()!.height;
  for (let i = 0; i < 30; i++) await page.mouse.move(400 + (i % 2), vh - 8, { steps: 1 });
  const after = await scrollTop();
  await page.mouse.up();
  expect(after).toBeGreaterThan(100);
});

test("Ziehen an den Rand: Spalten anlegen, erweitern, zurückziehen; nach dem Neuladen gleich", async ({ page }) => {
  await setup(page);
  // Delta an den rechten Rand von Alpha: zwei Spalten
  await dragBlock(page, "Delta", "Alpha", (b) => ({ x: b.x + b.width - 6, y: b.y + b.height / 2 }), "column");
  await expect(columns(page)).toHaveCount(2);
  await expect.poll(() => columnTexts(page)).toEqual([["Alpha"], ["Delta"]]);
  // Gamma links neben Delta: drei Spalten
  await dragBlock(page, "Gamma", "Delta", (b) => ({ x: b.x - 10, y: b.y + b.height / 2 }));
  await expect.poll(() => columnTexts(page)).toEqual([["Alpha"], ["Gamma"], ["Delta"]]);
  // Omega unter Alpha in dieselbe Spalte
  await dragBlock(page, "Omega", "Alpha", (b) => ({ x: b.x + 4, y: b.y + b.height - 3 }));
  await expect.poll(() => columnTexts(page)).toEqual([["Alpha", "Omega"], ["Gamma"], ["Delta"]]);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Drag");
  await expect.poll(() => columnTexts(page)).toEqual([["Alpha", "Omega"], ["Gamma"], ["Delta"]]);
  // Gamma und Delta wieder heraus hinter Beta: leere Spalten verschwinden, am Ende keine Spalten mehr
  await dragBlock(page, "Gamma", "Beta", (b) => ({ x: b.x + 4, y: b.y + b.height - 3 }));
  await expect.poll(() => columnTexts(page)).toEqual([["Alpha", "Omega"], ["Delta"]]);
  await dragBlock(page, "Delta", "Gamma", (b) => ({ x: b.x + 4, y: b.y + b.height - 3 }));
  await expect(columns(page)).toHaveCount(0);
  await expect.poll(() => topOrder(page)).toEqual(["Alpha", "Omega", "Beta", "Gamma", "Delta"]);
});

// Feedback 11. 11.: Im Streifen des Griffs ⋮⋮ sprang die Anzeige zwischen „davor“, „Spalte“ und „dahinter“; die
// Spalten-Zonen waren nur in der Mitte der Zeile aktiv. Jetzt: am Griff entlang wird umsortiert, Spalten gibt es links
// vom Griff und am rechten Rand über die ganze Höhe, und unter dem letzten Block landet man dahinter.
test("Ziehen: am Griff entlang sortiert um; links vom Griff und am rechten Rand entstehen Spalten; unter dem letzten Block dahinter", async ({ page }) => {
  await setup(page);
  // gerade nach oben im Griff-Streifen, Mitte der Zeile von Beta (früher: Spalte links)
  await dragBlock(page, "Omega", "Beta", (b) => ({ x: b.x - 16, y: b.y + b.height / 2 - 2 }));
  await expect(columns(page)).toHaveCount(0);
  await expect.poll(() => topOrder(page)).toEqual(["Alpha", "Omega", "Beta", "Gamma", "Delta"]);
  // unter den letzten Block ins Leere
  await dragBlock(page, "Alpha", "Delta", (b) => ({ x: b.x + 4, y: b.y + b.height + 60 }));
  await expect.poll(() => topOrder(page)).toEqual(["Omega", "Beta", "Gamma", "Delta", "Alpha"]);
  // rechter Rand, ganz oben in der Zeile (früher: davor)
  await dragBlock(page, "Alpha", "Omega", (b) => ({ x: b.x + b.width - 10, y: b.y + 3 }));
  await expect.poll(() => columnTexts(page)).toEqual([["Omega"], ["Alpha"]]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(columns(page)).toHaveCount(0);
  // links vom Griff, unten in der Zeile
  await dragBlock(page, "Alpha", "Omega", (b) => ({ x: b.x - 48, y: b.y + b.height - 4 }));
  await expect.poll(() => columnTexts(page)).toEqual([["Alpha"], ["Omega"]]);
});
