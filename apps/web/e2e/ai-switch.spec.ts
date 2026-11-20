import { expect, test, type Page } from "@playwright/test";

// AI-Schalter (shell/ai.ts, entschieden 12.11.2026): Standard aus. Ohne AI keine Chat-, Agenten- und Coding-Flächen,
// Home ist eine Seite; Skills, Memories und MCP bleiben. Die übrigen Specs laufen mit BASED_AI_DEFAULT=on
// (playwright.config.ts); hier wird „aus“ ausdrücklich gesetzt, solange der Test es nicht selbst umschaltet.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("based.ai") === null) localStorage.setItem("based.ai", "false");
  });
});

async function ready(page: Page, hash = "") {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/" + hash);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Workspace" });
const topNames = async (page: Page) => (await nav(page).locator(":scope > .nav-item").allInnerTexts()).map((t) => t.split("\n")[0]!.trim());

test("ohne AI: kein Chat, keine Agenten, Home ist eine Seite", { tag: "@smoke" }, async ({ page }) => {
  await ready(page);
  // BSD-461: Home ist die vorhandene Willkommensseite – keine leere Seite „Home“ mehr
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("topbar-ai")).toHaveCount(0);
  expect(await topNames(page)).toEqual(["Search", "Home"]);

  // Neuladen: dieselbe Seite, keine neue
  const url = page.url();
  await page.reload();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  expect(page.url()).toBe(url);
  await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toHaveCount(0);

  // ⌘K kennt Chat, Tasks, Coding und Dashboard nicht
  for (const q of ["chat", "tasks", "coding", "dashboard"]) {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByLabel("Search pages").fill(q);
    await expect(page.getByTestId("qf-command")).toHaveCount(0);
    await page.keyboard.press("Escape");
  }

  // Alte AI-Links führen nach Home
  await page.goto("/#chat");
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");

  // BSD-461: Einstellungen → Home nennt die Seite, die Home ist (keine „neue Seite Home“ mehr)
  // (frisches Gerät: weder Home gewählt noch je vergeben – Feedback 20. 11.)
  await page.evaluate(() => { localStorage.removeItem("based.startPage"); localStorage.removeItem("based.startPage.decided"); });
  await page.goto("/#prefs-editor");
  await page.reload();
  await expect(page.getByTestId("settings-section-start-page")).toContainText("Welcome to Based");
  await expect(page.getByTestId("settings-section-start-page")).not.toContainText("A new page called Home");
});

test("Einstellungen: Schalter unter Agents & AI; ohne AI nur Skills und Memories, keine Connections", async ({ page }) => {
  await ready(page, "#prefs-agents");
  const settingsNav = page.getByRole("navigation", { name: "Settings pages" });
  await expect(settingsNav.getByRole("button", { name: "Connections", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("settings-section-ai-switch")).toBeVisible();
  await expect(page.getByTestId("settings-section-brain-skills")).toBeVisible();
  await expect(page.getByTestId("settings-section-brain-memories")).toBeVisible();
  await expect(page.getByTestId("settings-section-ai-providers")).toHaveCount(0);
  await expect(page.getByTestId("settings-section-main-agent")).toHaveCount(0);
  await expect(page.getByTestId("settings-missing")).toHaveCount(0);

  // Einschalten: Modelle, Connections und Chat erscheinen; bleibt nach Neuladen
  await page.getByTestId("settings-section-ai-switch").getByRole("switch").click();
  await expect(page.getByTestId("settings-section-ai-providers")).toBeVisible();
  await expect(settingsNav.getByRole("button", { name: "Connections", exact: true })).toBeVisible();
  expect(await topNames(page)).toEqual(["Search", "Home", "Chat"]);
  await page.reload();
  await expect(page.getByTestId("settings-section-ai-providers")).toBeVisible();

  // Wieder aus
  await page.getByTestId("settings-section-ai-switch").getByRole("switch").click();
  await expect(page.getByTestId("settings-section-ai-providers")).toHaveCount(0);
  expect(await topNames(page)).toEqual(["Search", "Home"]);
});

// Checkliste (docs/quality/checklist.md): Home als Seite und Einstellungen → Agents & AI ohne AI, drei Größen, hell/dunkel
for (const theme of ["light", "dark"] as const) {
  test(`Screenshots ohne AI (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots nur einmal");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/#home");
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
      await page.mouse.move(0, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `../../docs/design/screens/web-ai-off-home-${w}x${h}-${theme}.png` });
      await page.goto("/#prefs-agents");
      await expect(page.getByTestId("settings-section-ai-switch")).toBeVisible();
      await page.mouse.move(0, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `../../docs/design/screens/web-ai-off-settings-${w}x${h}-${theme}.png` });
    }
  });
}

// BSD-407 Teil 6.6: Ohne AI bietet der Block-Editor kein „Ask AI“ an (Leertaste, Slash-Menü, Formatleiste).
test("ohne AI: kein Ask AI im Block-Editor", async ({ page }) => {
  await ready(page);
  const id = await page.evaluate(() => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "No AI" }));
  await page.goto(`/#page-${id}`);
  const editor = page.getByTestId("block-editor");
  await editor.getByTestId("block-editor-tail").click();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("ai-box")).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/ask");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /Ask AI/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Some text to select");
  await page.keyboard.press("Shift+Home");
  await expect(page.getByTestId("format-bar")).toBeVisible();
  await expect(page.getByTestId("format-bar").getByRole("button", { name: "Ask AI" })).toHaveCount(0);
});

// BSD-504: Ohne AI gibt es kein Dashboard – an der Home-Seite fehlt „Use dashboard as Home“ (der Klick tat nichts);
// eine andere Seite lässt sich weiter als Home setzen.
test("ohne AI: Rechtsklick auf die Home-Seite ohne „Use dashboard as Home“, andere Seite „Set as Home“", async ({ page, browserName }) => {
  await ready(page);
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Page actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /dashboard/i })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Set as Home" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Remove as Home" })).toBeVisible();
  if (browserName === "chromium") {
    await page.screenshot({ path: "../../docs/design/screens/home-page-menu-no-ai-light.png" });
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+l");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.waitForTimeout(400);
    await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: "../../docs/design/screens/home-page-menu-no-ai-dark.png" });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Shift+l");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // andere Seite → Set as Home → Home öffnet sie
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page.getByLabel("Page title")).toBeFocused();
  await page.keyboard.type("Other home");
  await page.getByRole("treeitem", { name: "Other home" }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Set as Home" }).click();
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click();
  await nav(page).getByRole("button", { name: "Home" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Other home");
});

// Feedback 20. 11.: Home wurde nach „Remove as Home“ oder Löschen der Home-Seite sofort mit der nächsten Seite neu
// besetzt. Jetzt bleibt Home leer (Start-Ansicht mit „Choose a page…“), bis man selbst eine Seite wählt.
test("ohne AI: Home bleibt leer nach „Remove as Home“ und nach Löschen der Home-Seite", async ({ page, browserName }) => {
  await ready(page);
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
  const menu = page.getByRole("menu", { name: "Page actions" });
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Remove as Home" }).click();
  await nav(page).getByRole("button", { name: "Home" }).click();
  const plain = page.getByTestId("home-plain");
  await expect(plain).toBeVisible();
  await expect(plain.getByRole("heading", { name: "Home" })).toBeVisible();
  // keine Seite rückt nach – auch nicht nach einem Neuladen
  await page.waitForTimeout(500);
  await expect(page.getByLabel("Page title")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await nav(page).getByRole("button", { name: "Home" }).click();
  await expect(plain).toBeVisible();
  if (browserName === "chromium") {
    await page.screenshot({ path: "../../docs/design/screens/home-plain-light.png" });
    await page.keyboard.press("ControlOrMeta+Shift+l");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.waitForTimeout(400);
    await page.screenshot({ path: "../../docs/design/screens/home-plain-dark.png" });
    await page.keyboard.press("ControlOrMeta+Shift+l");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  }

  // Seite wählen → Home öffnet sie
  await plain.getByRole("button", { name: "Choose a page…" }).click();
  const picker = page.getByTestId("page-picker");
  await picker.getByRole("searchbox").fill("Welcome");
  await picker.getByText("Welcome to Based", { exact: true }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");

  // eine andere Seite als Home, dann in den Papierkorb → Home bleibt leer statt „Welcome to Based“
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page.getByLabel("Page title")).toBeFocused();
  await page.keyboard.type("Short-lived home");
  await page.getByRole("treeitem", { name: "Short-lived home" }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Set as Home" }).click();
  await page.getByRole("treeitem", { name: "Short-lived home" }).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Move to Trash" }).click();
  await nav(page).getByRole("button", { name: "Home" }).click();
  await expect(plain).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByLabel("Page title")).toHaveCount(0);
});
