import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";

// BSD-217 Teil 2: Import direkt aus Notion über die API – Dialog, Token prüfen, Fortschritt, Bericht; gegen die
// Routen der Golden Fixtures (fixtures/import/notion-api.utc.json, dieselben wie im Kern-Test), als Fake-Server über
// page.route. Geprüft wird, dass Struktur ankommt: Seiten, Spalten mit Breite, Datenbank mit ihren Ansichten, Bild.

interface Api { routes: Record<string, unknown>; failFirst?: Record<string, number>; files?: Record<string, string> }
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/import/notion-api.utc.json", import.meta.url), "utf8")) as { cases: { input: { api: Api; targets: string[] } }[] };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
const BASE = "http://notion.test/v1";

async function fakeNotion(page: Page, api: Api, seen: { auth: Set<string>; count: number }) {
  const fail = { ...(api.failFirst ?? {}) };
  await page.route("http://notion.test/**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const u = new URL(req.url());
    let key = `${req.method()} ${u.pathname.replace(/^\/v1\//, "")}`;
    const db = u.searchParams.get("database_id");
    if (db !== null) key += `?database_id=${db}`;
    seen.count += 1;
    seen.auth.add(req.headers()["authorization"] ?? "");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", "access-control-expose-headers": "retry-after", ...headers }, body: JSON.stringify(body) });
    if (req.headers()["authorization"] !== "Bearer ntn_test_token") return json(401, { code: "unauthorized", message: "API token is invalid." });
    if (key === "GET users/me") return json(200, { object: "user", name: "Based import", bot: { workspace_name: "Elija" } });
    if ((fail[key] ?? 0) > 0) {
      fail[key]! -= 1;
      return json(429, { code: "rate_limited", message: "slow down" }, { "retry-after": "0" });
    }
    const r = api.routes[key];
    return r !== undefined ? json(200, r) : json(404, { object: "error", code: "object_not_found", message: `Could not find ${key}` });
  });
  await page.route("https://files.example.com/**", (route) => {
    const f = api.files?.[new URL(route.request().url()).pathname];
    return f !== undefined ? route.fulfill({ status: 200, headers: { ...CORS, "content-type": "image/png" }, body: Buffer.from(f, "base64") }) : route.fulfill({ status: 404, headers: CORS });
  });
}

async function openNotionImport(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.evaluate((base) => { (globalThis as unknown as { __based: { notionBaseURL?: string } }).__based.notionBaseURL = base; }, BASE);
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByTestId("new-palette").getByRole("option", { name: /Import/ }).click();
  await page.getByRole("button", { name: /Connect Notion directly/ }).click();
  return page.getByRole("dialog", { name: "Import from Notion" });
}

test("Notion-API-Import: Token prüfen, importieren mit Fortschritt, Struktur und Ansichten kommen an", async ({ page }) => {
  test.setTimeout(90_000);
  const seen = { auth: new Set<string>(), count: 0 };
  const input = fixture.cases[0]!.input;
  await fakeNotion(page, input.api, seen);
  const dialog = await openNotionImport(page);

  // Falsches Token: verständliche Meldung, kein Import
  await dialog.getByLabel("Integration token").fill("wrong");
  await dialog.getByRole("button", { name: "Check" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Notion rejected the integration token");

  await dialog.getByLabel("Integration token").fill("ntn_test_token");
  await dialog.getByRole("button", { name: "Check" }).click();
  await expect(dialog.getByTestId("notion-verified")).toHaveText("Connected as Based import · Elija");

  await dialog.getByLabel("Notion links").fill(input.targets[0]! + "\nnot a link");
  await expect(dialog.getByRole("alert")).toContainText("One line isn’t a Notion link");
  await dialog.getByLabel("Notion links").fill(input.targets[0]!);
  await dialog.getByRole("button", { name: "Import 1 link" }).click();
  await expect(page.getByTestId("notion-progress")).toBeVisible();

  const summary = page.getByTestId("import-summary");
  await expect(summary).toHaveText("Imported 2 pages, 2 databases, 3 rows, 1 attached file.", { timeout: 60_000 });
  await expect(page.getByTestId("notion-copy-report")).toBeVisible();
  // Das Token steht nie im Bericht.
  const done = page.getByRole("dialog", { name: "Import" });
  await expect(done).not.toContainText("ntn_test_token");
  await done.getByRole("button", { name: "Open" }).click();

  // Struktur: Seite mit Spalten (30/70), Unterseite, Datenbank mit ihren Ansichten
  await expect(page.getByLabel("Page title")).toHaveValue("Project Hub");
  // Die Seite hat einen Synced Block: dessen Original bekommt einen eigenen (verschachtelten) Editor, sobald es
  // geladen ist – je nach Zeitpunkt 1 bis 3 Editoren (BSD-294). Geprüft wird der Editor der Seite selbst.
  const editor = page.locator(".bn-editor").first();
  await expect(editor).toBeVisible();
  await expect(editor.locator("[data-content-type=column], .bn-block-column, [data-node-type=column]").first()).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Project Hub", exact: true })).toBeVisible();
  for (const name of ["All tasks", "Board"]) await expect(page.getByRole("tab", { name, exact: true }).first()).toBeVisible();
  expect(seen.count).toBeGreaterThan(25);

  // Token gemerkt (verschlüsselt): beim nächsten Öffnen ohne Eingabe nutzbar; erneuter Import legt nichts doppelt an.
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByTestId("new-palette").getByRole("option", { name: /Import/ }).click();
  await page.getByRole("button", { name: /Connect Notion directly/ }).click();
  const again = page.getByRole("dialog", { name: "Import from Notion" });
  await expect(again.getByLabel("Integration token")).toHaveAttribute("placeholder", /Saved on this device/);
  await again.getByLabel("Notion links").fill(input.targets[0]!);
  await again.getByRole("button", { name: "Import 1 link" }).click();
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await page.getByRole("dialog", { name: "Import" }).getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("treeitem", { name: "Project Hub", exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("ntn_test_token");
});

test("Notion-API-Import: Abbrechen beendet den Lauf und schreibt nichts", async ({ page }) => {
  const seen = { auth: new Set<string>(), count: 0 };
  const input = fixture.cases[0]!.input;
  await fakeNotion(page, input.api, seen);
  const dialog = await openNotionImport(page);
  await dialog.getByLabel("Integration token").fill("ntn_test_token");
  await dialog.getByLabel("Notion links").fill(input.targets[0]!);
  await dialog.getByRole("button", { name: "Import 1 link" }).click();
  await expect(page.getByTestId("notion-progress")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.getByLabel("Integration token")).toBeVisible();
  const before = seen.count;
  await page.waitForTimeout(1500);
  expect(seen.count).toBeLessThanOrEqual(before + 3);
  await expect(page.getByRole("treeitem", { name: "Project Hub", exact: true })).toHaveCount(0);
});
