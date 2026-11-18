import { expect, test, type BrowserContext, type BrowserType, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-275 (Mac-Beta): erster Start ohne Konto. Frischer Speicher → Willkommensbildschirm statt Home → „Start empty“
// (Anleitungsseiten unter „Welcome to Based“) bzw. „Import from Notion“ (Import-Dialog). AI bleibt aus, „Turn on
// agents“ führt nur zu Einstellungen → Agents. Andere Specs sehen den Bildschirm nicht (navigator.webdriver); hier
// schaltet `__basedWelcome` ihn ein. Eigenes Profil je Test: WebKit hat OPFS nur in einem dauerhaften Kontext.

const SHOTS = "../../docs/design/screens/";

async function fresh(playwright: Record<"chromium" | "webkit" | "firefox", BrowserType>, browserName: "chromium" | "webkit" | "firefox", baseURL: string, force = true) {
  const dir = mkdtempSync(join(tmpdir(), "based-welcome-"));
  const ctx: BrowserContext = await playwright[browserName].launchPersistentContext(dir, { baseURL, viewport: { width: 1280, height: 820 } });
  if (force) await ctx.addInitScript(() => { (globalThis as { __basedWelcome?: boolean }).__basedWelcome = true; });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { page, close: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const welcome = (page: Page) => page.getByTestId("welcome");
const tour = (page: Page) => page.getByTestId("welcome-tour");

/** BSD-551: der geführte Einstieg kommt zuerst; „Skip“ führt zur Wahl (letzter Schritt). */
async function skipTour(page: Page) {
  await expect(tour(page)).toBeVisible();
  await tour(page).getByRole("button", { name: "Skip" }).click();
  await expect(welcome(page)).toBeVisible();
}

test("Frischer Speicher → Willkommen → Turn on agents → Start empty → Anleitungsseiten, danach Home", { tag: "@smoke" }, async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await skipTour(page);
    await expect(welcome(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "How do you want to start?" })).toBeVisible();
    await expect(page.getByTestId("home")).toHaveCount(0);
    // der erste Weg hat den Fokus (Enter wählt ihn ohne Maus)
    await expect(welcome(page).getByRole("button", { name: /Import from Notion/ })).toBeFocused();
    // BSD-463: der Datei-Import bringt keine Ansichten – die Karte verspricht sie nur für die direkte Verbindung
    await expect(welcome(page).getByRole("button", { name: /Import from Notion/ })).toContainText("Views come along when you connect Notion directly");
    // kein Composer, keine Agenten-Bedienung auf dem ersten Bildschirm
    await expect(page.getByLabel("Tell Based", { exact: true })).toHaveCount(0);

    // Neuladen vor der Wahl: der Bildschirm bleibt
    await page.reload();
    await ready(page);
    await expect(welcome(page)).toBeVisible();

    // AI erst auf Wunsch: führt zu Einstellungen → Agents, Willkommen bleibt offen
    await welcome(page).getByRole("button", { name: "Turn on agents" }).click();
    await expect(page).toHaveURL(/#prefs-agents$/);
    await page.getByRole("button", { name: "Home" }).click();
    await expect(welcome(page)).toBeVisible();

    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    for (const t of ["Basics", "Databases", "Keyboard", "Your data", "Everything in Based"]) await expect(page.getByTestId("page-content").getByText(t, { exact: true })).toBeVisible();

    // danach die gewohnte Startseite, auch nach dem Neuladen
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await page.reload();
    await ready(page);
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

// BSD-551 (Mac-Beta, Einstieg 1): geführter Einstieg in Schritten vor der Wahl. Return, Pfeiltasten, Neuladen, danach
// nie wieder automatisch; Hilfe (⌘K „Welcome tour“) zeigt ihn erneut, ohne Daten anzufassen.
test("Einstieg: Durchlauf mit Tastatur, danach die Wahl als letzter Schritt, nie wieder automatisch", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    const steps = tour(page).getByTestId("welcome-tour-steps");
    await expect(tour(page)).toHaveAttribute("data-step", "basics");
    await expect(steps).toHaveAttribute("aria-label", "Step 1 of 5");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome to Based Notes" })).toBeVisible();
    await expect(page.getByTestId("home")).toHaveCount(0);
    await expect(tour(page).getByRole("button", { name: "Continue" })).toBeFocused();
    await expect(tour(page).getByRole("button", { name: "Back" })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(tour(page)).toHaveAttribute("data-step", "data");
    await expect(steps).toHaveAttribute("aria-label", "Step 2 of 5");
    await expect(page.getByRole("heading", { level: 1, name: "Your data stays on this device" })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(tour(page)).toHaveAttribute("data-step", "basics");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(tour(page)).toHaveAttribute("data-step", "meetings");
    await tour(page).getByRole("button", { name: "Back" }).click();
    await expect(tour(page)).toHaveAttribute("data-step", "data");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(tour(page)).toHaveAttribute("data-step", "beta");
    await expect(tour(page)).toContainText("hello@basednotes.app");
    // Neuladen mitten im Einstieg: er bleibt (von vorn)
    await page.reload();
    await ready(page);
    await expect(tour(page)).toHaveAttribute("data-step", "basics");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(tour(page).getByRole("button", { name: "Get started" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(welcome(page)).toBeVisible();
    await expect(tour(page)).toHaveCount(0);
    await expect(welcome(page).getByTestId("welcome-tour-steps")).toHaveAttribute("aria-label", "Step 5 of 5");
    await expect(page.getByRole("heading", { level: 1, name: "How do you want to start?" })).toBeVisible();
    await expect(welcome(page).getByRole("button", { name: /Import from Notion/ })).toBeFocused();
    // Neuladen vor der Wahl: die Wahl bleibt, der Einstieg kommt nicht wieder
    await page.reload();
    await ready(page);
    await expect(welcome(page)).toBeVisible();
    await expect(tour(page)).toHaveCount(0);
    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    await page.reload();
    await ready(page);
    await expect(tour(page)).toHaveCount(0);
    await expect(welcome(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

test("Einstieg: Skip auf jedem Schritt führt zur Wahl; Escape auch", async ({ playwright, browserName, baseURL }) => {
  for (const at of [0, 2, 3]) {
    const { page, close } = await fresh(playwright, browserName, baseURL!);
    try {
      await page.goto("/");
      await ready(page);
      await expect(tour(page).getByRole("button", { name: "Continue" })).toBeFocused();
      for (let i = 0; i < at; i++) await page.keyboard.press("ArrowRight");
      await expect(tour(page).getByTestId("welcome-tour-steps")).toHaveAttribute("aria-label", `Step ${at + 1} of 5`);
      if (at === 3) await page.keyboard.press("Escape");
      else await tour(page).getByRole("button", { name: "Skip" }).click();
      await expect(welcome(page)).toBeVisible();
      await expect(welcome(page).getByTestId("welcome-tour-steps")).toHaveAttribute("aria-label", "Step 5 of 5");
    } finally {
      await close();
    }
  }
});

test("Einstieg in 900 × 600: jeder Schritt ohne Scrollen bedienbar, kein waagrechter Rollbalken, nichts gekürzt", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto("/");
    await ready(page);
    for (const step of ["basics", "data", "meetings", "beta"]) {
      await expect(tour(page)).toHaveAttribute("data-step", step);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const next = tour(page).getByRole("button", { name: /^(Continue|Later|Get started)$/ });
      await expect(next).toBeInViewport({ ratio: 1 });
      await expect(tour(page).getByRole("button", { name: "Skip" })).toBeInViewport({ ratio: 1 });
      const clipped = await tour(page).locator(".welcome-idea strong, h1").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      expect(clipped).toBe(0);
      await next.click();
    }
    await expect(welcome(page)).toBeVisible();
  } finally {
    await close();
  }
});

test("Einstieg erneut über ⌘K „Welcome tour“: ohne Wahl am Ende, Daten bleiben, Navigation schließt ihn", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await skipTour(page);
    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    const pages = await page.getByRole("treeitem").count();
    const openTour = async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.keyboard.type("welcome tour");
      await page.getByTestId("qf-command").filter({ hasText: "Welcome tour" }).click();
      await expect(tour(page)).toBeVisible();
    };
    await openTour();
    await expect(tour(page).getByTestId("welcome-tour-steps")).toHaveAttribute("aria-label", "Step 1 of 4");
    await expect(tour(page).getByRole("button", { name: "Skip" })).toHaveCount(0);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(tour(page)).toHaveAttribute("data-step", "beta");
    await tour(page).getByRole("button", { name: "Done" }).click();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    // Escape und „Close“ schließen ihn ebenso; Klick in die Seitenleiste auch
    await openTour();
    await page.keyboard.press("Escape");
    await expect(tour(page)).toHaveCount(0);
    await openTour();
    await page.getByRole("button", { name: "Home" }).click();
    await expect(tour(page)).toHaveCount(0);
    await expect(welcome(page)).toHaveCount(0);
    expect(await page.getByRole("treeitem").count()).toBe(pages);
    await page.reload();
    await ready(page);
    await expect(tour(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

// BSD-552 (Mac-Beta, Einstieg 2): „Everything in Based“ als fünfte Anleitung – echte Seite mit den Bereichen und
// „Not in this beta yet“, im ersten Schritt des Einstiegs genannt. Fotos 1280 × 820 hell/dunkel.
test("Everything in Based: fünfte Anleitung mit allen Bereichen, im Einstieg genannt", async ({ playwright, browserName, baseURL }) => {
  for (const theme of ["light", "dark"] as const) {
    const { page, close } = await fresh(playwright, browserName, baseURL!);
    try {
      await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.goto("/");
      await ready(page);
      await expect(tour(page).getByTestId("welcome-tour-foot")).toContainText("Everything in Based");
      await skipTour(page);
      await expect(welcome(page).getByRole("button", { name: /Start empty/ })).toContainText("Everything in Based");
      await welcome(page).getByRole("button", { name: /Start empty/ }).click();
      await page.getByTestId("page-content").getByText("Everything in Based", { exact: true }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Everything in Based");
      const editor = page.getByTestId("block-editor");
      for (const h of ["Pages and writing", "Databases", "Search and navigation", "Import and export", "Your data", "Meeting notes", "The Mac app", "Not in this beta yet"]) await expect(editor.getByText(h, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (browserName === "chromium") {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${SHOTS}web-welcome-everything-${theme}.png` });
      }
    } finally {
      await close();
    }
  }
});

test("Willkommen → Import from Notion öffnet den Import-Dialog mit „Connect Notion directly“", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await skipTour(page);
    await expect(welcome(page).getByRole("button", { name: /Import from Notion/ })).toBeFocused();
    await page.keyboard.press("Enter"); // ohne Maus
    const dialog = page.getByRole("dialog", { name: "Import" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Connect Notion directly/ })).toBeVisible();
    await dialog.getByRole("button", { name: /Connect Notion directly/ }).click();
    await expect(page.getByRole("dialog", { name: "Import from Notion" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Wahl getroffen: Home statt Willkommen, Anleitungsseiten liegen trotzdem bereit
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
    await expect(page.getByTestId("page-content").getByText("Your data", { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});

test("Automatisierter Browser ohne Haken: gewohnte Startseite (bestehende Specs)", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!, false);
  try {
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

test("Checkliste: 900 × 600 ohne waagrechten Rollbalken, beide Wege und „Turn on agents“ ohne Scrollen sichtbar, nichts gekürzt", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto("/");
    await ready(page);
    await skipTour(page);
    await expect(welcome(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const name of [/Import from Notion/, /Start empty/, /^Tasks$/, /^Notes$/, /^Journal$/, /^Wiki$/, /Turn on agents/]) await expect(welcome(page).getByRole("button", { name })).toBeInViewport({ ratio: 1 });
    // Beschriftungen der Wege laufen nicht heraus
    const clipped = await welcome(page).locator(".welcome-choice strong, .welcome-ai strong").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    expect(clipped).toBe(0);
  } finally {
    await close();
  }
});

// Bildschirmfotos (nur mit BASED_SCREENSHOTS=1, Chromium): Willkommen in 1280 × 820, 900 × 600 und 1728 × 1000, hell
// und dunkel; dazu die Willkommensseite mit den Anleitungsseiten in 1280 × 820.
test("Willkommen: Bildschirmfotos", async ({ playwright, browserName, baseURL }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium", "nur auf Wunsch");
  test.setTimeout(120_000);
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.addInitScript(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "system", style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false })));
    await page.goto("/");
    await ready(page);
    await expect(tour(page).getByTestId("logo-intro")).toHaveAttribute("data-state", "done"); // Logo-Intro abwarten
    const sizes = [{ w: 1280, h: 820, s: "" }, { w: 900, h: 600, s: "-900" }, { w: 1728, h: 1000, s: "-1728" }];
    const shoot = async (name: string, all = true) => {
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        for (const z of all ? sizes : sizes.slice(0, 1)) {
          await page.setViewportSize({ width: z.w, height: z.h });
          await page.waitForTimeout(250);
          // kein waagrechter Rollbalken, nichts läuft heraus
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: `${SHOTS}web-welcome-${name}-${theme}${z.s}.png` });
        }
      }
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 1280, height: 820 });
    };
    await page.mouse.move(0, 0);
    // BSD-551: jeder Schritt des Einstiegs, dann die Wahl
    for (;;) {
      const step = await tour(page).getAttribute("data-step");
      await shoot(`tour-${step}`);
      const next = tour(page).getByRole("button", { name: /^(Continue|Later|Get started)$/ });
      const label = await next.textContent();
      await next.click();
      if (label?.includes("Get started")) break;
    }
    await expect(welcome(page)).toBeVisible();
    await shoot("start");
    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByTestId("page-content").getByText("Your data", { exact: true })).toBeVisible();
    await page.getByRole("treeitem", { name: "Welcome to Based" }).getByRole("button", { name: /Expand|Open/ }).first().click().catch(() => undefined);
    await shoot("guides", false);
    await page.getByTestId("page-content").getByText("Keyboard", { exact: true }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Keyboard");
    await shoot("guide-keyboard", false);
  } finally {
    await close();
  }
});

// BSD-461 (Mac-Beta, AI aus wie auf beta): nach „Start empty“ ist Home die Willkommensseite – keine leere Seite „Home“
// daneben, auch nicht nach dem Neuladen. Bildschirmfotos 1280 × 820 hell/dunkel.
test("ohne AI: Start empty → Home ist „Welcome to Based“, keine leere Seite „Home“", async ({ playwright, browserName, baseURL }) => {
  for (const theme of ["light", "dark"] as const) {
    const { page, close } = await fresh(playwright, browserName, baseURL!);
    try {
      await page.addInitScript((t) => {
        if (localStorage.getItem("based.ai") === null) localStorage.setItem("based.ai", "false");
        localStorage.setItem("based.appearance", JSON.stringify({ theme: t }));
      }, theme);
      await page.goto("/");
      await ready(page);
      await skipTour(page);
      await welcome(page).getByRole("button", { name: /Start empty/ }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
      await page.getByRole("button", { name: "Home" }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
      await expect(page.getByTestId("page-content").getByText("Your data", { exact: true })).toBeVisible();
      await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toHaveCount(0);
      await expect(page.getByRole("treeitem", { name: "Welcome to Based" })).toHaveCount(1);
      await page.reload();
      await ready(page);
      await page.getByRole("button", { name: "Home" }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
      await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toHaveCount(0);
      if (browserName === "chromium") {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${SHOTS}beta-first-start-home-${theme}.png` });
      }
    } finally {
      await close();
    }
  }
});

// BSD-436 (Mac-Beta): dritter Weg „Start from a template“ – Tasks öffnet ein Board mit Beispielaufgaben, die
// Anleitungsseiten liegen trotzdem unter „Welcome to Based“; nach dem Neuladen kein Willkommen mehr. Fotos hell/dunkel.
test("Willkommen → Vorlage Tasks: Board mit Aufgaben in < 3 s, Anleitungen bereit, danach kein Willkommen", async ({ playwright, browserName, baseURL }) => {
  for (const theme of ["light", "dark"] as const) {
    const { page, close } = await fresh(playwright, browserName, baseURL!);
    try {
      await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.goto("/");
      await ready(page);
      await skipTour(page);
      const tpl = welcome(page).getByRole("group", { name: "Or start from a template" });
      await expect(tpl.getByRole("button")).toHaveText(["Tasks", "Notes", "Journal", "Wiki"]);
      if (browserName === "chromium") {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${SHOTS}web-welcome-templates-${theme}.png` });
      }
      const t0 = Date.now();
      await tpl.getByRole("button", { name: "Tasks" }).click();
      const board = page.locator(".shell-database.full");
      await expect(board).toBeVisible();
      await expect(board.getByText("Try Based for a day")).toBeVisible();
      expect(Date.now() - t0).toBeLessThan(3000);
      // jede Aufgabe hat einen Status: „No Status“ steht nur unter den ausgeblendeten Gruppen, nicht als Spalte
      await expect(board.getByRole("region", { name: "Hidden groups" })).toContainText("No Status");
      for (const col of ["Not started", "In progress", "Done"]) await expect(board.getByTestId("board").getByText(col, { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("treeitem", { name: "Tasks" })).toHaveCount(1);
      if (browserName === "chromium") {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${SHOTS}web-template-tasks-${theme}.png` });
      }
      await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
      await expect(page.getByTestId("page-content").getByText("Your data", { exact: true })).toBeVisible();
      await page.reload();
      await ready(page);
      await expect(welcome(page)).toHaveCount(0);
    } finally {
      await close();
    }
  }
});

test("Vorlagen auch später über ⌘N: Journal", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!, false);
  try {
    await page.goto("/");
    await ready(page);
    await page.keyboard.press("ControlOrMeta+n");
    await page.keyboard.type("journal");
    await page.keyboard.press("Enter");
    await expect(page.locator(".shell-database.full")).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "Journal" })).toHaveCount(1);
  } finally {
    await close();
  }
});

test("Logo-Intro: läuft einmal und steht dann; mit „Bewegung reduzieren“ sofort das fertige Zeichen", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    const logo = tour(page).getByTestId("logo-intro"); // BSD-551: das Zeichen steht im ersten Schritt des Einstiegs
    await expect(logo).toHaveAttribute("aria-label", "Based");
    await expect(logo).toHaveAttribute("data-state", "done");
    const rest = () => logo.evaluate((el) => ({
      base: el.querySelector(".base")!.getAttribute("width"),
      caret: el.querySelector(".caret")!.getAttribute("opacity"),
      blocks: [...el.querySelectorAll("g[opacity]")].map((g) => g.getAttribute("opacity")),
    }));
    const played = await rest();
    expect(Number(played.base)).toBe(80);
    expect(Number(played.caret)).toBe(0);
    expect(played.blocks).toEqual(["1", "1"]);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await ready(page);
    await expect(logo).toBeVisible();
    expect(await logo.getAttribute("data-state")).toBe("done"); // ohne Warten
    expect(await rest()).toEqual(played);
  } finally { await close(); }
});
