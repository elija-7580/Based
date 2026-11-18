import { expect, test, type Page } from "@playwright/test";

// Einstellungen aus Astryx-Komponenten: Navigation links, Abschnitte rechts, ehrliche „Coming later“-Seiten.

async function open(page: Page, hash = "appearance") {
  await page.goto("/#" + hash);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("settings-page")).toBeVisible();
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Settings pages" });
/** Zeile der Navigation (Astryx setzt aria-current und den „Not yet“-Hinweis an das Listenelement, nicht an den Button). */
const navRow = (page: Page, name: string) => nav(page).getByRole("listitem").filter({ has: page.getByRole("button", { name, exact: true }) });

test("Navigation: 20 Seiten in App, Workspace und System, Auswahl steht in der Adresse und übersteht das Neuladen", { tag: "@smoke" }, async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "appearance");
  await expect(nav(page).getByRole("button")).toHaveCount(20);
  for (const group of ["App", "Workspace", "System"]) await expect(nav(page).getByText(group, { exact: true })).toBeVisible();

  await nav(page).getByRole("button", { name: "Sync & server" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sync & server" })).toBeVisible();
  await expect(page).toHaveURL(/#prefs-sync$/);
  await expect(navRow(page, "Sync & server")).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "sync");

  // Zurück im Verlauf führt zur vorigen Einstellungsseite
  await page.goBack();
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "appearance");
});

test("Seiten ohne Logik sind ehrlich beschriftet und enthalten keine Schalter", async ({ page }) => {
  // Offene Punkte auf Seiten mit echten Abschnitten zeigt nur die Entwickler-Ansicht (unten eigens geprüft).
  await page.addInitScript(() => localStorage.setItem("based.devView", "true"));
  await open(page, "prefs-people");
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  const missing = page.getByTestId("settings-missing");
  await expect(missing.getByRole("heading", { name: "Coming later" })).toBeVisible();
  await expect(missing.getByText("Members", { exact: true })).toBeVisible();
  await expect(missing.getByText("Invitations")).toBeVisible();
  const content = page.getByTestId("settings-page");
  for (const role of ["switch", "checkbox", "textbox", "radio", "button"] as const) await expect(content.getByRole(role)).toHaveCount(0);
  await expect(navRow(page, "People")).toContainText("Not yet");

  // Agents & AI hat seit BSD-159 einen echten Abschnitt (Modelle und Schlüssel); der Rest bleibt ehrlich offen.
  await nav(page).getByRole("button", { name: "Agents & AI", exact: true }).click();
  await expect(page.getByTestId("settings-section-ai-providers")).toBeVisible();
  await expect(page.getByTestId("settings-missing").getByText("API keys for AI providers")).toHaveCount(0);
  // BSD-160: „Main agent“ (Budget, Regeln, Projekte, Zeitpläne) und BSD-163: Skills sind jetzt echt; Sandbox bleibt offen.
  await expect(page.getByTestId("settings-section-main-agent")).toBeVisible();
  await expect(page.getByTestId("settings-missing").getByText("Agents and the main agent")).toHaveCount(0);
  await expect(page.getByTestId("settings-section-brain-skills")).toBeVisible();
  await expect(page.getByTestId("settings-missing").getByText("Sandbox cleanup")).toBeVisible();

  // BSD-222: MCP-Server sind echt; „Tool permissions“ bleibt offen. Ohne Connection gibt es noch keine Schalter.
  await nav(page).getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByTestId("settings-section-mcp-connections")).toBeVisible();
  await expect(page.getByTestId("settings-missing").getByText("MCP connections")).toHaveCount(0);
  await expect(page.getByTestId("settings-missing").getByText("Tool permissions")).toBeVisible();
  await expect(page.getByTestId("settings-page").getByRole("switch")).toHaveCount(0);
});

test("Seiten mit echten Einstellungen zeigen keine Liste offener Punkte (Updates: kein „Update channel“)", async ({ page }) => {
  await open(page, "prefs-updates");
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
  await expect(page.getByTestId("settings-section-updates")).toBeVisible();
  await expect(page.getByTestId("settings-missing")).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).not.toContainText("Update channel");
  await expect(page.getByTestId("settings-page")).not.toContainText("Mac app");
  // Seiten ganz ohne Abschnitte sagen weiter ehrlich, was noch kommt.
  await nav(page).getByRole("button", { name: "People", exact: true }).click();
  await expect(page.getByTestId("settings-missing").getByRole("heading", { name: "Coming later" })).toBeVisible();
});

test("Sync-Formular prüft die Adresse, bevor es verbindet", async ({ page }) => {
  await open(page, "prefs-sync");
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeDisabled();
  await page.getByLabel("Server URL").fill("based.example.com");
  await connect.click();
  await expect(page.getByTestId("settings-section-sync-server").getByText(/doesn't look like an address/)).toBeVisible();
  await expect(page.getByTestId("sync-status")).toHaveText(/On this device|Not saved/);
  await page.getByLabel("Server URL").fill("http://127.0.0.1:9/");
  await page.getByLabel("Token").fill("secret");
  await connect.click();
  await expect(page.getByLabel("Server URL")).toHaveValue("http://127.0.0.1:9");
  await expect(page.getByLabel("Server URL")).toBeDisabled();
  await expect(page.getByTestId("sync-status")).toHaveText(/Offline|Sync error/);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByLabel("Server URL")).toBeEnabled();
});

test("General: Zahlen aus dem Workspace, Papierkorb leeren mit Rückfrage", async ({ page }) => {
  await open(page, "prefs-workspace");
  await expect(page.getByTestId("workspace-counts")).toHaveText(/^1 page · 0 databases$/);
  const empty = page.getByRole("button", { name: "Empty Trash…" });
  await expect(empty).toBeDisabled();

  await page.evaluate(async () => {
    const based = (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string>; getState(): { outline?: { children: Record<string, string[]> } } } } }).__based;
    const id = await based.client.command({ op: "createPage", title: "Throwaway" });
    await based.client.command({ op: "trash", ids: [id] });
  });
  await expect(empty).toBeEnabled();
  await expect(page.getByText("1 page waiting in the Trash")).toBeVisible();
  await empty.click();
  const dialog = page.getByRole("alertdialog", { name: "Empty the Trash?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(empty).toBeEnabled();
  await empty.click();
  await dialog.getByRole("button", { name: "Empty Trash" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("The Trash is empty")).toBeVisible();
  await expect(empty).toBeDisabled();
});

test("Account und Diagnostics zeigen echten Gerätezustand", async ({ page }) => {
  await open(page, "prefs-account");
  await expect(page.getByTestId("device-id")).not.toHaveText("not assigned yet");
  await nav(page).getByRole("button", { name: "Diagnostics" }).click();
  await expect(page.getByTestId("settings-section-diagnostics-status")).toContainText("Web browser");
  await page.getByRole("button", { name: "Open design kit" }).click();
  await expect(page.getByTestId("astryx-kit")).toBeVisible();
});

test("Diagnose (BSD-227): Hinweis nach unsauberem Ende, Log, Bericht ohne Inhalte und Token", async ({ page }) => {
  // Vorige Sitzung ohne sauberes Ende (Tab abgestürzt): Marke vor dem Start setzen, nur beim ersten Laden.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("based.diagnostics.session", JSON.stringify({ startedAt: 1_700_000_000_000, lastBeat: 1_700_000_060_000, clean: false, stalls: 2, log: [{ at: 1_700_000_050_000, level: "error", message: "boom before crash" }] }));
    (globalThis as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { (globalThis as unknown as { __copied: string[] }).__copied.push(t); } } });
  });
  await open(page, "prefs-diagnostics");
  // BSD-319: Diagnostics in Gruppen – vorige Sitzung unter „Problems“, Log und Bericht unter „Log“.
  await expect(page.getByTestId("settings-section-diagnostics-problems")).toContainText("didn't close normally");
  await expect(page.getByTestId("diagnostics-last-session")).toContainText("Ended unexpectedly");
  const section = page.getByTestId("settings-section-diagnostics-log");
  await expect(section.getByTestId("diagnostics-log")).toContainText("start");
  // Ein Fehler mit Token und Inhalt landet geschwärzt im Log.
  await page.evaluate(() => setTimeout(() => { throw new Error("failed with Bearer abc123 on “Secret page”"); }));
  await expect(section.getByTestId("diagnostics-log")).toContainText("Bearer ‹redacted›");
  await section.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(section.getByRole("button", { name: "Copied" })).toBeVisible();
  const report = await page.evaluate(() => (globalThis as unknown as { __copied: string[] }).__copied.at(-1) ?? "");
  expect(report).toContain("ended unexpectedly");
  expect(report).toContain("boom before crash");
  expect(report).not.toContain("abc123");
  expect(report).not.toContain("Secret page");
});

test("Registry: ein anderer Bereich hängt einen Abschnitt ein, ohne Settings.tsx anzufassen", async ({ page }) => {
  await open(page, "prefs-people");
  await expect(page.getByTestId("settings-missing").getByText("Members", { exact: true })).toBeVisible();
  // Die Registry ist für Tests am __based-Objekt erreichbar (main.tsx).
  await page.evaluate(() => {
    const based = (globalThis as unknown as { __based: { registerSettingsSection(s: unknown): () => void } }).__based;
    (globalThis as unknown as { __off: () => void }).__off = based.registerSettingsSection({
      id: "test-keys", page: "people", title: "Members list", provides: ["Members"], component: () => "Registered by another area",
    });
  });
  await expect(page.getByTestId("settings-section-test-keys")).toContainText("Registered by another area");
  await expect(page.getByRole("heading", { level: 2, name: "Members list" })).toBeVisible();
  await expect(page.getByTestId("settings-missing").getByText("Members", { exact: true })).toHaveCount(0);
  await expect(navRow(page, "People")).not.toContainText("Not yet");
  await page.evaluate(() => (globalThis as unknown as { __off: () => void }).__off());
  await expect(page.getByTestId("settings-section-test-keys")).toHaveCount(0);
  await expect(navRow(page, "People")).toContainText("Not yet");
});

for (const theme of ["light", "dark"] as const) {
  test(`Screenshot Einstellungen (${theme})`, async ({ page, browserName }) => {
    test.skip(!process.env.BASED_SCREENSHOTS || browserName !== "chromium", "nur mit BASED_SCREENSHOTS=1 auf Chromium");
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await open(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `../../docs/design/screens/web-settings-${theme}.png` });
    await nav(page).getByRole("button", { name: "Sync & server" }).click();
    await expect(page.getByLabel("Server URL")).toBeVisible();
    await page.screenshot({ path: `../../docs/design/screens/web-settings-sync-${theme}.png` });
  });
}

// ADR 0017 A3: im Browser sagt Einstellungen → Sync & server, ob der Browser den Workspace behält.
test("Sync & server zeigt, ob der Browser-Speicher geschützt ist", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit hat im flüchtigen Testprofil kein OPFS (kein Workspace im Browser)");
  await page.goto("/#prefs-sync");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByTestId("sync-settings-status").click(); // erste Eingabe: jetzt wird angefragt
  const row = page.getByTestId("sync-browser-keep");
  await expect(row).toHaveText(/^(Protected|Not protected)$/);
  await expect(page.getByText(/This browser keeps your workspace|Browsers may clear unused data/)).toBeVisible();
});

// ADR 0017 A3, Checkliste: die Zeile „Browser storage“ in drei Fenstergrößen, hell und dunkel – nichts gekürzt,
// kein waagrechter Rollbalken, Zeile ganz im Abschnitt.
for (const theme of ["light", "dark"] as const) {
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    test(`Browser storage: ${w}×${h} ${theme} – Zeile vollständig, nichts gekürzt`, async ({ page, browserName }) => {
      test.skip(browserName === "webkit", "WebKit hat im flüchtigen Testprofil kein OPFS (kein Workspace im Browser)");
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.goto("/#prefs-sync");
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await page.getByTestId("sync-settings-status").click();
      const row = page.getByTestId("sync-browser-keep");
      await expect(row).toHaveText(/^(Protected|Not protected)$/);
      await row.scrollIntoViewIfNeeded();
      const hint = page.getByText(/This browser keeps your workspace|Browsers may clear unused data/);
      await expect(hint).toBeVisible();
      for (const el of [row, hint]) {
        expect(await el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), "Text nicht abgeschnitten").toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "kein waagrechter Rollbalken").toBe(true);
      // Ab dem Startfenster steht der Wert rechts neben der Beschriftung, wie bei „Status“ (nicht darunter umgebrochen).
      if (w >= 1280) {
        const label = (await page.getByText("Browser storage", { exact: true }).boundingBox())!;
        const value = (await row.boundingBox())!;
        expect(value.x, "Wert rechts").toBeGreaterThan(label.x + label.width);
        expect(value.y, "Wert auf Höhe der Zeile").toBeLessThan(label.y + label.height * 2.5);
      }
      if (process.env.BASED_SCREENSHOTS) await page.screenshot({ path: `../../docs/design/screens/web-settings-browser-storage-${theme}-${w}x${h}.png` });
    });
  }
}

// ADR 0017 Stufe B: „Fast start (beta)“ – Schalter in Sync & server; gilt nach dem Neustart, der Inhalt bleibt derselbe.
for (const theme of ["light", "dark"] as const) {
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    test(`Fast start: ${w}×${h} ${theme} – Schalter sichtbar, nichts gekürzt; nach Neustart lädt Based nach Bedarf`, async ({ page, browserName }) => {
      test.skip(browserName === "webkit", "WebKit hat im flüchtigen Testprofil kein OPFS (kein Workspace im Browser)");
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript((t) => { if (!localStorage.getItem("based.appearance")) localStorage.setItem("based.appearance", JSON.stringify({ theme: t })); }, theme);
      await page.goto("/#prefs-sync");
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      const info = () => page.evaluate(() => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<{ partial: boolean; totalBlocks: number; fullLoads: string[] }> } } }).__based.client.command({ op: "storeInfo" }));
      expect((await info()).partial).toBe(false);
      const toggle = page.getByRole("switch", { name: "Fast start (beta)" });
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).not.toBeChecked();
      const hint = page.getByText("Applies after you restart Based.", { exact: false });
      await expect(hint).toBeVisible();
      expect(await hint.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), "Hinweis nicht abgeschnitten").toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "kein waagrechter Rollbalken").toBe(true);
      await toggle.click();
      await expect(toggle).toBeChecked();
      if (process.env.BASED_SCREENSHOTS) await page.screenshot({ path: `../../docs/design/screens/web-settings-fast-start-${theme}-${w}x${h}.png` });
      const before = (await info()).totalBlocks;
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      const after = await info();
      expect(after.partial).toBe(true);
      expect(after.totalBlocks).toBe(before);
      expect(after.fullLoads).toEqual([]);
      // BSD-515 Teil 1: Library und Graph kommen aus dem Gerüst – auch sie laden nicht alles nach
      await page.goto("/#library");
      await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 15_000 });
      await page.goto("/#graph");
      await expect(page.getByTestId("graph-stats")).toBeVisible({ timeout: 15_000 });
      expect((await info()).fullLoads, "Library und Graph laden nicht alles").toEqual([]);
      await page.goto("/#prefs-sync");
      await expect(page.getByRole("switch", { name: "Fast start (beta)" })).toBeChecked();
      // und wieder aus: nach dem Neustart wie früher
      await page.getByRole("switch", { name: "Fast start (beta)" }).click();
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      expect((await info()).partial).toBe(false);
    });
  }
}
