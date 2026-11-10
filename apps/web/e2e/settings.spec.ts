import { expect, test, type Page } from "@playwright/test";

// Einstellungen aus Astryx-Komponenten: Navigation links, Abschnitte rechts, ehrliche „Not available yet“-Seiten.

async function open(page: Page, hash = "appearance") {
  await page.goto("/#" + hash);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("settings-page")).toBeVisible();
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Settings pages" });
/** Zeile der Navigation (Astryx setzt aria-current und den „Not yet“-Hinweis an das Listenelement, nicht an den Button). */
const navRow = (page: Page, name: string) => nav(page).getByRole("listitem").filter({ has: page.getByRole("button", { name, exact: true }) });

test("Navigation: 17 Seiten in Account und Workspace, Auswahl steht in der Adresse und übersteht das Neuladen", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "my-settings");
  await expect(nav(page).getByRole("button")).toHaveCount(17);
  await expect(nav(page).getByText("Account", { exact: true })).toBeVisible();
  await expect(nav(page).getByText("Workspace", { exact: true })).toBeVisible();

  await nav(page).getByRole("button", { name: "Sync & server" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sync & server" })).toBeVisible();
  await expect(page).toHaveURL(/#prefs-sync$/);
  await expect(navRow(page, "Sync & server")).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "sync");

  // Zurück im Verlauf führt zur vorigen Einstellungsseite
  await page.goBack();
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "my-settings");
});

test("Seiten ohne Logik sind ehrlich beschriftet und enthalten keine Schalter", async ({ page }) => {
  await open(page, "prefs-people");
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  const missing = page.getByTestId("settings-missing");
  await expect(missing.getByRole("heading", { name: "Not available yet" })).toBeVisible();
  await expect(missing.getByText("Members", { exact: true })).toBeVisible();
  await expect(missing.getByText("Invitations")).toBeVisible();
  const content = page.getByTestId("settings-page");
  for (const role of ["switch", "checkbox", "textbox", "radio", "button"] as const) await expect(content.getByRole(role)).toHaveCount(0);
  await expect(navRow(page, "People")).toContainText("Not yet");

  // Agents & AI hat seit BSD-159 einen echten Abschnitt (Modelle und Schlüssel); der Rest bleibt ehrlich offen.
  await nav(page).getByRole("button", { name: "Agents & AI", exact: true }).click();
  await expect(page.getByTestId("settings-section-ai-providers")).toBeVisible();
  await expect(page.getByTestId("settings-missing").getByText("API keys for AI providers")).toHaveCount(0);
  // BSD-160: „Main agent“ (Budget, Regeln, Projekte, Zeitpläne) ist jetzt auch echt; Skills bleiben offen.
  await expect(page.getByTestId("settings-section-main-agent")).toBeVisible();
  await expect(page.getByTestId("settings-missing").getByText("Agents and the main agent")).toHaveCount(0);
  await expect(page.getByTestId("settings-missing").getByText("Skills")).toBeVisible();

  await nav(page).getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByTestId("settings-missing").getByText("MCP connections")).toBeVisible();
  await expect(page.getByTestId("settings-page").getByRole("switch")).toHaveCount(0);
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
  await expect(page.getByTestId("settings-section-diagnostics")).toContainText("Web browser");
  await page.getByRole("button", { name: "Open design kit" }).click();
  await expect(page.getByTestId("astryx-kit")).toBeVisible();
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
