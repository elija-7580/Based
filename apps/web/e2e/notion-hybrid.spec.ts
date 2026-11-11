import { expect, test, type Page, type Route } from "@playwright/test";
import { smallWorld, uid, IDS, type World } from "../../../packages/core/test/fixtures/hybrid-world.js";

// BSD-317: Hybrid-Notion-Import im Browser – Export-ZIP wählen, Struktur zuerst, Inhalt im Hintergrund, gesperrte
// Platzhalterseite, Stand in der Seitenleiste, Fortsetzen nach einem Neuladen, Delta-Abgleich, Bericht mit
// Abweichungen. Notion ist dieselbe Fixture-Welt wie im Kern-Test (ZIP + API aus einer Quelle), als Fake-Server.

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
const BASE = "http://notion.test/v1";
const SHOTS = "../../docs/design/screens/";

interface Fake { world: World; hold?: Promise<void>; children: number }

async function fakeNotion(page: Page, fake: Fake) {
  const transport = fake.world.transport();
  await page.route("http://notion.test/**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const json = (status: number, body: string) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body });
    if (req.headers()["authorization"] !== "Bearer ntn_test_token") return json(401, JSON.stringify({ code: "unauthorized", message: "API token is invalid." }));
    const u = new URL(req.url());
    if (u.pathname === "/v1/users/me") return json(200, JSON.stringify({ object: "user", name: "Based import", bot: { workspace_name: "Elija" } }));
    if (/\/blocks\/[^/]+\/children$/.test(u.pathname)) { fake.children += 1; if (fake.hold) await fake.hold; }
    const r = await transport.send(req.method(), req.url(), {}, req.postData() ?? undefined);
    return json(r.status, Buffer.from(r.body).toString("utf8"));
  });
}

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.evaluate((base) => { (globalThis as unknown as { __based: { notionBaseURL?: string } }).__based.notionBaseURL = base; }, BASE);
}

async function openNotionImport(page: Page) {
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByTestId("new-palette").getByRole("option", { name: /Import/ }).click();
  await page.getByRole("button", { name: /Connect Notion directly/ }).click();
  return page.getByRole("dialog", { name: "Import from Notion" });
}

const zipFile = (w: World) => ({ name: "Export-elija.zip", mimeType: "application/zip", buffer: Buffer.from(w.zip()) });

test("Hybrid-Import: Struktur zuerst, gesperrte Platzhalterseite, Fortsetzen nach Neuladen, Delta", async ({ page, browserName }) => {
  test.setTimeout(180_000);
  const world = smallWorld();
  // „Notes“ fehlt im Export: ihr Inhalt kommt über die API – und die halten wir an, um den Zwischenstand zu sehen.
  world.pages.get(IDS.NOTES)!.inZip = false;
  let release!: () => void;
  const fake: Fake = { world, children: 0, hold: new Promise<void>((r) => (release = r)) };
  await fakeNotion(page, fake);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await ready(page);
  const dialog = await openNotionImport(page);
  await dialog.getByLabel("Integration token").fill("ntn_test_token");
  await dialog.getByTestId("hybrid-zip").setInputFiles(zipFile(world));
  await expect(dialog.locator(".hybrid-zip-name")).toHaveText("Export-elija.zip");
  // Mit Export gibt es keine Link-Liste: importiert wird alles Geteilte.
  await expect(dialog.getByLabel("Notion links")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Import with export" }).click();
  await expect(page.getByTestId("hybrid-running")).toBeVisible();

  // Struktur steht, 9 von 10 Seiten kommen sofort aus dem ZIP, eine wartet auf die (angehaltene) API.
  await expect(page.getByTestId("hybrid-running")).toHaveAttribute("data-phase", "content", { timeout: 60_000 });
  await expect(page.getByTestId("hybrid-progress")).toContainText("9 of 10 pages loaded", { timeout: 60_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("hybrid-pill")).toHaveText("Importing · 9 / 10");
  await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toBeVisible();

  // Die wartende Seite ist da, aber gesperrt.
  await page.getByRole("treeitem", { name: "Home", exact: true }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Home");
  await expect(page.locator(".bn-editor").first()).toContainText("Welcome home");
  await expect(page.getByTestId("import-pending")).toHaveCount(0);
  await page.locator(".bn-editor").first().getByText("Notes", { exact: true }).first().click();
  await expect(page.getByLabel("Page title")).toHaveValue("Notes");
  await expect(page.getByTestId("import-pending")).toBeVisible();
  await expect(page.getByLabel("Page title")).not.toBeEditable();

  // Neuladen mitten im Import: der Stand bleibt, die Seitenleiste bietet das Fortsetzen an.
  // (Neuladen nur in Chromium: WebKit-Testprofile haben kein OPFS, die Datenbank wäre weg. Dort: anhalten.)
  if (browserName === "chromium") {
    await page.reload();
    await ready(page);
  } else {
    await page.getByTestId("hybrid-pill").click();
    await page.getByRole("dialog").getByRole("button", { name: "Pause" }).click();
    await page.keyboard.press("Escape");
  }
  await expect(page.getByTestId("hybrid-pill")).toHaveText("Import paused · 1 page left");
  await expect(page.getByTestId("import-pending")).toBeVisible();
  release();
  fake.hold = undefined;
  await page.getByTestId("hybrid-pill").click();
  const again = page.getByRole("dialog", { name: "Import from Notion" });
  await expect(again.getByTestId("hybrid-paused")).toContainText("1 page is still waiting for content");
  await again.getByLabel("Integration token").fill("ntn_test_token");
  await again.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("hybrid-summary")).toContainText("Imported 6 pages, 4 rows, 2 databases.", { timeout: 60_000 });
  await expect(page.getByTestId("hybrid-report")).toContainText("1 page is in Notion but not in the export");
  await expect(page.getByTestId("hybrid-report")).not.toContainText("ntn_test_token");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("hybrid-pill")).toHaveCount(0);
  // Die Seite ist entsperrt und hat ihren Inhalt; genau eine Inhaltsanfrage ging an Notion.
  await expect(page.getByTestId("import-pending")).toHaveCount(0);
  await expect(page.locator(".bn-editor").first()).toContainText("Notes body");
  // Inhaltsanfragen gab es nur für diese eine Seite (die vor dem Neuladen angehaltene zählt mit).
  const contentRequests = world.get("children");
  expect(contentRequests).toBeGreaterThanOrEqual(1);
  expect(contentRequests).toBeLessThanOrEqual(2);

  // Delta: in Notion ändert sich eine Seite; „Update from Notion“ holt nur sie.
  const spec = world.pages.get(IDS.SPEC)!;
  spec.body = [{ t: "p", id: uid(0xb, 10), text: "Spec body, changed in Notion" }, { t: "sub", id: IDS.DEEP }];
  spec.edited = new Date(Date.now() + 60_000).toISOString();
  const third = await openNotionImport(page);
  await third.getByLabel("Integration token").fill("ntn_test_token");
  await third.getByTestId("hybrid-update").getByRole("button", { name: "Update from Notion" }).click();
  await expect(page.getByTestId("hybrid-summary")).toContainText("Updated from Notion", { timeout: 60_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  expect(world.get("children")).toBe(contentRequests + 1);
  await page.getByRole("treeitem", { name: "Home", exact: true }).click();
  await page.locator(".bn-editor").first().getByText("Spec", { exact: true }).first().click();
  await expect(page.getByLabel("Page title")).toHaveValue("Spec");
  await expect(page.locator(".bn-editor").first()).toContainText("Spec body, changed in Notion");
});

test("Hybrid-Import: Markdown-Export wird erklärt statt halb importiert", async ({ page }) => {
  const world = smallWorld();
  await fakeNotion(page, { world, children: 0 });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await ready(page);
  const dialog = await openNotionImport(page);
  await dialog.getByLabel("Integration token").fill("ntn_test_token");
  const { writeZip } = await import("../../../packages/core/src/interop/zip.js");
  const md = writeZip([{ path: "Export/Home 11111111111111111111111111111111.md", data: new TextEncoder().encode("# Home\n") }]);
  await dialog.getByTestId("hybrid-zip").setInputFiles({ name: "Export-md.zip", mimeType: "application/zip", buffer: Buffer.from(md) });
  await dialog.getByRole("button", { name: "Import with export" }).click();
  await expect(page.getByTestId("hybrid-error")).toContainText("needs the HTML export");
  await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toHaveCount(0);
});

// Bildschirmfotos für docs/design/screens (nur mit BASED_SCREENSHOTS=1, Chromium): Dialog mit Export, laufend,
// Bericht, gesperrte Seite mit Stand in der Seitenleiste – hell und dunkel in 1280 × 820.
test("Hybrid-Import: Bildschirmfotos", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium", "nur auf Wunsch");
  test.setTimeout(240_000);
  const sizes = [{ w: 1280, h: 820, s: "" }];
  const world = smallWorld();
  world.pages.get(IDS.NOTES)!.inZip = false;
  world.pages.get(IDS.DEEP)!.zipTitle = "Deep (old name)";
  let release!: () => void;
  const fake: Fake = { world, children: 0, hold: new Promise<void>((r) => (release = r)) };
  await fakeNotion(page, fake);
  // Theme „System“, damit emulateMedia hell/dunkel ohne Neuladen umschaltet.
  await page.addInitScript(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "system", style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false })));
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await ready(page);
  const shoot = async (name: string) => {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const z of sizes) {
        await page.setViewportSize({ width: z.w, height: z.h });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}web-notion-hybrid-${name}-${theme}${z.s}.png` });
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 820 });
  };
  const dialog = await openNotionImport(page);
  await dialog.getByLabel("Integration token").fill("ntn_test_token");
  await dialog.getByTestId("hybrid-zip").setInputFiles(zipFile(world));
  await shoot("form");
  await dialog.getByRole("button", { name: "Import with export" }).click();
  await expect(page.getByTestId("hybrid-progress")).toContainText("9 of 10 pages loaded", { timeout: 60_000 });
  await shoot("running");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("treeitem", { name: "Home", exact: true }).click();
  await page.locator(".bn-editor").first().getByText("Notes", { exact: true }).first().click();
  await expect(page.getByTestId("import-pending")).toBeVisible();
  await shoot("pending");
  release();
  fake.hold = undefined;
  await page.getByTestId("hybrid-pill").click();
  await expect(page.getByTestId("hybrid-summary")).toBeVisible({ timeout: 60_000 });
  await shoot("report");
});
