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
const step = (page: Page) => page.getByTestId("tour-step");

/** BSD-551: vom ersten Schritt des Einstiegs direkt zur Wahl („How do you want to start?“). */
async function toStart(page: Page) {
  await expect(step(page)).toHaveAttribute("data-step", "welcome");
  await welcome(page).getByRole("button", { name: "Skip" }).click();
  await expect(step(page)).toHaveAttribute("data-step", "start");
}

test("Frischer Speicher → Einstieg in Schritten → Turn on agents → Start empty → Anleitungsseiten, danach Home", { tag: "@smoke" }, async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await expect(welcome(page)).toBeVisible();
    await expect(page.getByTestId("home")).toHaveCount(0);
    // BSD-551: Schritt 1, dann mit Return, → und ← durch die Schritte (im Browser ohne Meeting-Schritt)
    await expect(page.getByRole("heading", { level: 1, name: "Welcome to Based Notes" })).toBeVisible();
    await expect(page.getByTestId("tour-progress")).toHaveAttribute("aria-label", "Step 1 of 4");
    await expect(welcome(page).getByRole("button", { name: "Continue" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(step(page)).toHaveAttribute("data-step", "data");
    await expect(page.getByRole("heading", { level: 1, name: "Your data stays on this device" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(step(page)).toHaveAttribute("data-step", "beta");
    await expect(step(page)).toContainText("hello@basednotes.app");
    await page.keyboard.press("ArrowLeft");
    await expect(step(page)).toHaveAttribute("data-step", "data");
    // Neuladen mitten im Einstieg: derselbe Schritt
    await page.reload();
    await ready(page);
    await expect(step(page)).toHaveAttribute("data-step", "data");
    await welcome(page).getByRole("button", { name: "Continue" }).click();
    await welcome(page).getByRole("button", { name: "Continue" }).click();
    await expect(step(page)).toHaveAttribute("data-step", "start");
    await expect(page.getByRole("heading", { level: 1, name: "How do you want to start?" })).toBeVisible();
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
    for (const t of ["Basics", "Databases", "Keyboard", "Your data"]) await expect(page.getByTestId("page-content").getByText(t, { exact: true })).toBeVisible();

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

test("Willkommen → Import from Notion öffnet den Import-Dialog mit „Connect Notion directly“", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await toStart(page);
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
    await expect(welcome(page)).toBeVisible();
    // BSD-551: jeder Schritt passt ohne Scrollen, „Continue“ und „Skip“ sind sichtbar
    for (const s of ["welcome", "data", "beta"]) {
      await expect(step(page)).toHaveAttribute("data-step", s);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), s).toBe(true);
      for (const name of ["Continue", "Skip"]) await expect(welcome(page).getByRole("button", { name }), `${s}: ${name}`).toBeInViewport({ ratio: 1 });
      const clippedTour = await step(page).locator(".tour-point strong").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      expect(clippedTour, s).toBe(0);
      await welcome(page).getByRole("button", { name: "Continue" }).click();
    }
    await expect(step(page)).toHaveAttribute("data-step", "start");
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
    await expect(welcome(page)).toBeVisible();
    await expect(welcome(page).getByTestId("logo-intro")).toHaveAttribute("data-state", "done"); // Logo-Intro abwarten
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
    await toStart(page);
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
      await toStart(page);
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
      await toStart(page);
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
    const logo = welcome(page).getByTestId("logo-intro");
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

// BSD-551: „Skip“ auf jedem Schritt führt zur Wahl; danach (nach der Wahl) nie wieder automatisch.
test("Einstieg: Skip auf jedem Schritt führt zur Wahl, nach der Wahl kein Einstieg mehr", async ({ playwright, browserName, baseURL }) => {
  test.setTimeout(90_000);
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    for (const [i, s] of (["welcome", "data", "beta"] as const).entries()) {
      for (let k = 0; k < i; k++) await welcome(page).getByRole("button", { name: "Continue" }).click();
      await expect(step(page)).toHaveAttribute("data-step", s);
      await welcome(page).getByRole("button", { name: "Skip" }).click();
      await expect(step(page)).toHaveAttribute("data-step", "start");
      // Zurück zum Anfang (über „Back“ bis zum ersten Schritt)
      while ((await step(page).getAttribute("data-step")) !== "welcome") await welcome(page).getByRole("button", { name: "Back" }).click();
    }
    await toStart(page);
    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    await page.reload();
    await ready(page);
    await page.getByRole("button", { name: "Home" }).click();
    await expect(welcome(page)).toHaveCount(0);
    await expect(step(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

// BSD-551: ⌘K → „Show the tour“ (in der Mac-App auch Hilfe → Show Welcome Tour) zeigt den Einstieg erneut – ohne
// die Wahl am Ende, ohne etwas anzulegen; Done, Close und Escape schließen.
test("Einstieg erneut über ⌘K: nur lesen, nichts angelegt, Done/Close/Escape schließen", async ({ playwright, browserName, baseURL }) => {
  test.setTimeout(90_000);
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await toStart(page);
    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    const tree = page.getByRole("treeitem");
    const before = await tree.count();
    const open = async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.keyboard.type("tour");
      await page.getByRole("option", { name: /Show the tour/ }).click();
      await expect(page.getByTestId("welcome-tour")).toBeVisible();
    };
    await open();
    const tour = page.getByTestId("welcome-tour");
    await expect(tour.getByRole("heading", { level: 1, name: "Welcome to Based Notes" })).toBeVisible();
    await expect(tour.getByRole("button", { name: "Continue" })).toBeFocused();
    for (const s of ["data", "beta"]) {
      await page.keyboard.press("Enter");
      await expect(tour.getByTestId("tour-step")).toHaveAttribute("data-step", s);
    }
    // letzter Schritt: „Done“ statt der Wahl
    await expect(tour.getByRole("button", { name: /Start empty|Import from Notion/ })).toHaveCount(0);
    await tour.getByRole("button", { name: "Done" }).click();
    await expect(tour).toHaveCount(0);
    await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
    expect(await tree.count()).toBe(before);
    await open();
    await tour.getByRole("button", { name: "Close" }).click();
    await expect(tour).toHaveCount(0);
    await open();
    await page.keyboard.press("Escape");
    await expect(tour).toHaveCount(0);
    // Wechsel zu einer Seite schließt ihn ebenfalls
    await open();
    await page.goto("/#trash");
    await expect(tour).toHaveCount(0);
    expect(await tree.count()).toBe(before);
    expect(await page.evaluate(() => localStorage.getItem("based.welcome"))).toBeNull();
  } finally {
    await close();
  }
});

// BSD-551: Workspaces aus 0.2.x mit noch ausstehendem Willkommen (Merker ohne Schritt) sehen den Einstieg nicht
// ungefragt, sondern direkt die Wahl.
test("Einstieg: alter Merker ohne Schritt (Update von 0.2.x) → direkt die Wahl", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.goto("/");
    await ready(page);
    await expect(step(page)).toHaveAttribute("data-step", "welcome");
    await page.evaluate(() => { const v = JSON.parse(localStorage.getItem("based.welcome")!) as { page: string }; localStorage.setItem("based.welcome", JSON.stringify({ page: v.page })); });
    await page.reload();
    await ready(page);
    await expect(step(page)).toHaveAttribute("data-step", "start");
    await expect(page.getByTestId("tour-progress")).toHaveCount(0);
    await expect(welcome(page).getByRole("button", { name: "Back" })).toHaveCount(0);
  } finally {
    await close();
  }
});

// BSD-551: Schritt „Meeting notes“ (sonst nur in der Mac-App) – hier mit `__basedTourMeetings` eingeschaltet.
test("Einstieg: Schritt Meeting notes mit „Turn on meeting notes“", async ({ playwright, browserName, baseURL }) => {
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.addInitScript(() => { (globalThis as { __basedTourMeetings?: boolean }).__basedTourMeetings = true; });
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("tour-progress")).toHaveAttribute("aria-label", "Step 1 of 5");
    await welcome(page).getByRole("button", { name: "Continue" }).click();
    await welcome(page).getByRole("button", { name: "Continue" }).click();
    await expect(step(page)).toHaveAttribute("data-step", "meetings");
    await expect(welcome(page).getByTestId("welcome-meetings")).toBeVisible();
    await expect(welcome(page).getByTestId("welcome-meetings")).toContainText("488 MB");
    await welcome(page).getByRole("button", { name: "Continue" }).click();
    await expect(step(page)).toHaveAttribute("data-step", "beta");
    await expect(step(page)).toContainText("meeting notes");
  } finally {
    await close();
  }
});

// Bildschirmfotos des Einstiegs (nur mit BASED_SCREENSHOTS=1, Chromium): jeder Schritt in 1280 × 820, 900 × 600 und
// 1728 × 1000, hell und dunkel; dazu „Everything in Based“ in 1280 × 820.
test("Einstieg: Bildschirmfotos", async ({ playwright, browserName, baseURL }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium", "nur auf Wunsch");
  test.setTimeout(180_000);
  const { page, close } = await fresh(playwright, browserName, baseURL!);
  try {
    await page.addInitScript(() => { (globalThis as { __basedTourMeetings?: boolean }).__basedTourMeetings = true; });
    await page.goto("/");
    await ready(page);
    await expect(welcome(page).getByTestId("logo-intro")).toHaveAttribute("data-state", "done");
    const sizes = [{ w: 1280, h: 820, s: "" }, { w: 900, h: 600, s: "-900" }, { w: 1728, h: 1000, s: "-1728" }];
    const shoot = async (name: string, all = true) => {
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        for (const z of all ? sizes : sizes.slice(0, 1)) {
          await page.setViewportSize({ width: z.w, height: z.h });
          await page.waitForTimeout(250);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: `${SHOTS}web-welcome-tour-${name}-${theme}${z.s}.png` });
        }
      }
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 1280, height: 820 });
    };
    await page.mouse.move(0, 0);
    for (const s of ["welcome", "data", "meetings", "beta", "start"]) {
      await expect(step(page)).toHaveAttribute("data-step", s);
      // Fokus sichtbar wie per Tastatur (nur auf dem ersten Foto je Schritt egal)
      await shoot(s);
      if (s !== "start") await welcome(page).getByRole("button", { name: "Continue" }).click();
    }
    await welcome(page).getByRole("button", { name: /Start empty/ }).click();
    await page.getByTestId("page-content").getByText("Everything in Based", { exact: true }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("Everything in Based");
    await page.mouse.move(0, 0);
    await shoot("everything", false);
  } finally {
    await close();
  }
});
