// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";
import { overflows } from "./layout-checks.js";

// Feedback 20. 11. (Entscheidungen Elija): Sync & server → „This computer“ geführt mit Karten und „Details“,
// Settings → General in drei Flächen (Icon im Popover), Diagnostics mit Übersicht, einem „Copy report“ und Details
// als Umschalter. Checkliste: drei Größen ohne waagrechtes Rollen, Bildschirmfotos hell und dunkel.

async function ready(page: Page, hash: string) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/#" + hash);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}
const patch = (page: Page, p: Record<string, unknown>) =>
  page.evaluate((x) => (globalThis as unknown as { __basedLocalServerTest(p: unknown): void }).__basedLocalServerTest(x), p);

async function shoot(page: Page, name: string, browserName: string) {
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    expect(await overflows(page)).toEqual([]);
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  if (browserName !== "chromium") return;
  await page.screenshot({ path: `../../docs/design/screens/${name}-light.png` });
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `../../docs/design/screens/${name}-dark.png` });
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
}

test("This computer: Server mit Details, Karten für Terminal, Coding-Agenten und Handy", async ({ page, browserName }) => {
  await ready(page, "prefs-sync");
  await patch(page, { status: "running", enabled: true, url: "http://127.0.0.1:47821", tailnet: false, node: { ok: true, bundled: true, message: "Node.js v22.11.0 (comes with Based)", path: "/Applications/Based.app/node" }, cli: { installed: false, busy: false } });
  const section = page.getByTestId("settings-section-local-server");
  await expect(section.getByTestId("local-server-status")).toHaveText("Running");
  // Technik erst unter „Details“
  await expect(section.getByText("http://127.0.0.1:47821")).toHaveCount(0);
  await section.getByRole("button", { name: "Show details for the local server" }).click();
  await expect(section.getByTestId("local-server-details")).toContainText("http://127.0.0.1:47821");
  await expect(section.getByTestId("node-status")).toContainText("Node.js v22");
  await section.getByRole("button", { name: "Hide details for the local server" }).click();
  await expect(section.getByTestId("local-server-details")).toHaveCount(0);
  const cli = section.getByTestId("tool-cli");
  await expect(cli.getByRole("button", { name: "Install…" })).toBeVisible();
  await expect(cli.getByLabel("Install location")).toHaveCount(0);
  await cli.getByRole("button", { name: "Show details for Terminal command" }).click();
  await expect(cli.getByLabel("Install location")).toBeVisible();
  await expect(section.getByTestId("tool-agents")).toContainText("AI apps");
  await expect(section.getByRole("switch", { name: /Reachable from your phone/ })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shoot(page, "settings-this-computer", browserName);
  // Coding-Agenten führen zu „Connect AI apps“; ohne laufenden Server gesperrt
  await section.getByTestId("tool-agents").getByRole("button", { name: "Set up…" }).click();
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "ai-apps");
  await page.goto("/#prefs-sync");
  await patch(page, { status: "off", enabled: false });
  await expect(page.getByTestId("tool-agents").getByRole("button", { name: "Set up…" })).toBeDisabled();
  // Node fehlt: immer sichtbar, ohne „Details“
  await patch(page, { node: { ok: false, bundled: false, message: "Install Node.js 22 or newer, then try again." } });
  await expect(page.getByTestId("node-status")).toContainText("Install Node.js 22");
});

test("General: Name und Icon in einer Zeile, Inhalt mit Export, Papierkorb", async ({ page, browserName }) => {
  await ready(page, "prefs-workspace");
  const section = page.getByTestId("settings-section-workspace");
  await expect(section.getByTestId("workspace-name").getByRole("textbox", { name: "Workspace name" })).toBeVisible();
  await expect(page.getByTestId("workspace-icon")).toBeHidden();
  await expect(section.getByTestId("workspace-counts")).toHaveText("1 page · 0 databases");
  await shoot(page, "settings-workspace", browserName);
  await section.getByRole("button", { name: "Add a workspace icon" }).click();
  await expect(page.getByTestId("workspace-icon")).toBeVisible();
  await page.waitForTimeout(400); // Einblendung fertig
  if (browserName === "chromium") await page.screenshot({ path: "../../docs/design/screens/settings-workspace-icon-light.png" });
});

test("Diagnostics: Übersicht mit einem Knopf, Details als Umschalter", async ({ page, browserName }) => {
  await ready(page, "prefs-diagnostics");
  const overview = page.getByTestId("settings-section-diagnostics-status");
  // WebKit-Testprofile haben kein OPFS (Warnung „Memory only“) – dann steht oben, was anzusehen ist
  await expect(overview).toContainText(/Nothing to report|1 thing to look at/);
  await expect(overview.getByRole("button", { name: "Copy report" })).toBeVisible();
  const details = page.getByTestId("settings-section-diagnostics-details");
  await expect(details.getByRole("radio", { name: "Hangs", exact: true })).toBeChecked();
  await expect(page.getByTestId("diagnostics-tab-hangs")).toBeVisible();
  for (const [name, id] of [["Log", "log"], ["Crash reports", "crash"], ["Reports", "reports"], ["Hangs", "hangs"]] as const) {
    await details.getByRole("radio", { name, exact: true }).click();
    await expect(page.getByTestId(`diagnostics-tab-${id}`)).toBeVisible();
  }
  // nur ein „Copy“-Knopf für alles; der Log-Reiter kopiert nur das Log
  await expect(page.getByRole("button", { name: "Copy diagnostics" })).toHaveCount(0);
  await shoot(page, "settings-diagnostics-overview", browserName);
});
