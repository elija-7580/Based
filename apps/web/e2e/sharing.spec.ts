import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Teilen (BSD-219, docs/sharing.md): TS-based-server als Prozess, Seite im Web-Client anlegen, über das Share-Panel
// veröffentlichen → /p/<id> in einem frischen Kontext ohne Token lesbar → zurückziehen → 404. Ohne Server zeigt
// das Panel einen ehrlichen Hinweis.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-sharing-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));

let server: ChildProcess;
let dataDir: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  // eigener Port je Browser (die Projekte laufen parallel) und nicht der von sync-assets
  const serverPort = 20_000 + webPort + (browserName === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${serverPort}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-share-"));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(serverPort), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
    cwd: serverDir,
    env: { ...process.env, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${serverURL}/health`)).ok) return;
    } catch {
      // startet noch
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("based-server did not start");
});

test.afterAll(() => {
  server?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function deviceOn(browser: Browser, baseURL: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  return page;
}

async function connect(page: Page, opts: { dark?: boolean } = {}) {
  await page.getByRole("button", { name: "Settings" }).click();
  if (opts.dark) await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
}

async function newPage(page: Page, title: string, text: string) {
  const header = page.locator(".tree-header", { hasText: "Private" });
  await header.hover();
  await page.getByRole("button", { name: "New page in Private" }).click();
  await page.getByLabel("Page title").fill(title);
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type(text);
}

test("Veröffentlichen → /p/<id> ohne Token lesbar → zurückziehen → 404", async ({ browser, baseURL, browserName }) => {
  test.setTimeout(120_000);
  const a = await deviceOn(browser, baseURL!);
  await connect(a);
  await newPage(a, "Launch Plan", "Ship the public beta in March.");
  // Seite muss auf dem Server sein, bevor man sie teilen kann
  await expect.poll(async () => {
    const r = await fetch(`${serverURL}/sync/v2/pull?after=0&limit=5000`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return JSON.stringify(await r.json()).includes("Ship the public beta");
  }, { timeout: 20_000 }).toBe(true);

  await a.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = a.getByRole("dialog");
  await expect(dialog.getByText("Publish to web")).toBeVisible();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  const urlText = dialog.getByTestId("share-published-url");
  await expect(urlText).toHaveText(new RegExp(`^${serverURL.replace(/[.]/g, "\\.")}/p/[A-Za-z0-9_-]+$`), { timeout: 10_000 });
  const published = (await urlText.textContent())!.trim();
  // ein Access-Link mit Rolle dazu, damit das Panel alles zeigt
  await dialog.getByRole("button", { name: "Can view" }).click();
  await a.getByRole("menuitem", { name: "Can edit" }).click();
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(dialog.getByTestId("share-new-url")).toHaveText(/\/s\/bdl_/);
  await expect(dialog.getByText("Anyone with the link", { exact: true })).toBeVisible();
  if (browserName === "chromium") await a.screenshot({ path: join(screens, "web-share-light.png") });

  // frischer Kontext, kein Token, kein Web-Client: die Seite ist lesbar
  const guest = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const g = await guest.newPage();
  const res = await g.goto(published);
  expect(res?.status()).toBe(200);
  await expect(g.getByRole("heading", { name: "Launch Plan" })).toBeVisible();
  await expect(g.getByText("Ship the public beta in March.")).toBeVisible();
  expect(res?.headers()["content-security-policy"]).toContain("default-src 'none'");
  if (browserName === "chromium") await g.screenshot({ path: join(screens, "web-share-published-light.png") });
  // privater Bereich bleibt privat
  expect((await g.goto(`${serverURL}/p/does-not-exist`))?.status()).toBe(404);

  // zurückziehen
  await dialog.getByRole("button", { name: "Unpublish" }).click();
  await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  const gone = await g.goto(published);
  expect(gone?.status()).toBe(404);
  await expect(g.getByText("isn't published")).toBeVisible();
  await guest.close();
  await a.context().close();
});

test("dunkel: Panel und veröffentlichte Seite; ohne Server ein ehrlicher Hinweis", async ({ browser, baseURL, browserName }) => {
  test.setTimeout(120_000);
  // ohne Server
  const offline = await deviceOn(browser, baseURL!);
  await newPage(offline, "Offline Notes", "Only on this device.");
  await offline.getByRole("button", { name: "Share", exact: true }).click();
  await expect(offline.getByRole("dialog").getByText("Sharing needs a sync server")).toBeVisible();
  await offline.getByRole("dialog").getByRole("button", { name: "Open settings" }).click();
  await expect(offline.getByLabel("Server URL")).toBeVisible();
  await offline.context().close();

  const d = await deviceOn(browser, baseURL!);
  await connect(d, { dark: true });
  await newPage(d, "Field Guide", "Read-only for the world.");
  await expect.poll(async () => {
    const r = await fetch(`${serverURL}/sync/v2/pull?after=0&limit=5000`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return JSON.stringify(await r.json()).includes("Read-only for the world");
  }, { timeout: 20_000 }).toBe(true);
  await d.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = d.getByRole("dialog");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  const published = (await dialog.getByTestId("share-published-url").textContent({ timeout: 10_000 }))!.trim();
  if (browserName === "chromium") await d.screenshot({ path: join(screens, "web-share-dark.png") });

  const guest = await browser.newContext({ viewport: { width: 1024, height: 700 }, colorScheme: "dark" });
  const g = await guest.newPage();
  expect((await g.goto(published))?.status()).toBe(200);
  await expect(g.getByText("Read-only for the world.")).toBeVisible();
  if (browserName === "chromium") await g.screenshot({ path: join(screens, "web-share-published-dark.png") });
  await guest.close();
  await d.context().close();
});
