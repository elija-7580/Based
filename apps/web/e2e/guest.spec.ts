import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-235 Teil 2: Gast-Modus. Der Besitzer teilt eine Seite per Bearbeiten-Link; ein anderer Browser öffnet
// <web>/#/share/<Share-URL>, landet auf ?guest=<id>, sieht nur die geteilte Seite (mit Inhalt), seine Änderung
// kommt beim Server an. Das Geheimnis steht danach weder in der Adresse noch im localStorage.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
// Je Browser ein eigener Server (die Projekte laufen parallel).
let serverURL = "";
const TOKEN = "e2e-guest-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const owner = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let server: ChildProcess;
let dataDir: string;

// eslint-disable-next-line no-empty-pattern -- Playwright verlangt das Objektmuster
test.beforeAll(async ({}, info) => {
  const serverPort = 11_000 + webPort + (info.project.name === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${serverPort}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-guest-"));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(serverPort), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
    cwd: serverDir,
    env: { ...process.env, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${serverURL}/health`)).ok) break;
    } catch {
      // startet noch
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const stamp = { millis: Date.now(), counter: 0, node: "owner" };
  const block = (id: string, type: string, parent: string, sk: string, text: string) => ({ kind: "block", data: { id, type, parent, sk, text, createdAt: 0, updatedAt: 0, stamp } });
  const r = await fetch(`${serverURL}/sync/v2/push`, { method: "POST", headers: owner, body: JSON.stringify({ deletions: [], records: [
    block("11111111-1111-4111-8111-111111111111", "page", "w", "a0", "Team Wiki"),
    block("22222222-2222-4222-8222-222222222222", "text", "b:11111111-1111-4111-8111-111111111111", "a0", "Welcome to the shared wiki"),
    block("33333333-3333-4333-8333-333333333333", "page", "w", "a1", "Private Diary"),
    block("44444444-4444-4444-8444-444444444444", "text", "b:33333333-3333-4333-8333-333333333333", "a0", "secret thoughts"),
  ] }) });
  if (!r.ok) throw new Error(`push ${r.status}`);
});

test.afterAll(() => {
  server?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("Bearbeiten-Link öffnet den Gast-Modus: nur die geteilte Seite, Änderungen kommen an", async ({ page }) => {
  const link = await fetch(`${serverURL}/share/v1/links`, { method: "POST", headers: owner, body: JSON.stringify({ pageID: "11111111-1111-4111-8111-111111111111", kind: "access", role: "edit" }) });
  const { secret } = (await link.json()) as { secret: string };
  const shareURL = `${serverURL}/s/${secret}`;
  await page.goto("/#/share/" + encodeURIComponent(shareURL));
  await expect(page).toHaveURL(/\?guest=[0-9a-f]{16}/);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("page-content")).toContainText("Welcome to the shared wiki", { timeout: 20_000 });
  await expect(page.getByRole("treeitem", { name: "Team Wiki" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Private Diary" })).toHaveCount(0);
  await expect(page.getByText("secret thoughts")).toHaveCount(0);
  // Geheimnis weder in der Adresse noch im Klartext im localStorage
  expect(page.url()).not.toContain(secret);
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(stored).not.toContain(secret);
  // Gast schreibt: neuer Absatz kommt beim Server an
  const editor = page.getByTestId("page-content").getByText("Welcome to the shared wiki");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" – edited by guest");
  await expect.poll(async () => {
    const pull = await fetch(`${serverURL}/sync/v2/pull?after=0&limit=5000`, { headers: owner });
    return JSON.stringify(await pull.json());
  }, { timeout: 20_000 }).toContain("edited by guest");
  // Neu laden: Gast-Modus bleibt (Konfiguration aus der verschlüsselten Ablage)
  await page.reload();
  await expect(page.getByTestId("page-content")).toContainText("edited by guest", { timeout: 20_000 });
});

test("Nur-Lesen-Link: Seite sichtbar, Editor und Titel gesperrt (BSD-235)", async ({ page }) => {
  const res = await fetch(`${serverURL}/share/v1/links`, { method: "POST", headers: owner, body: JSON.stringify({ pageID: "11111111-1111-4111-8111-111111111111", kind: "access", role: "view" }) });
  const link = (await res.json()) as { secret: string };
  await page.goto("/#/share/" + encodeURIComponent(`${serverURL}/s/${link.secret}`));
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const content = page.getByTestId("page-content");
  await expect(content).toContainText("Welcome to the shared wiki", { timeout: 20_000 });
  await expect(content.locator("[contenteditable='true']")).toHaveCount(0);
  await expect(page.getByLabel("Page title")).not.toBeEditable();
  // Gast-Oberfläche: ein Abschnitt ohne „+“, keine Teamspaces, kein Papierkorb-Knopf an der Seite, Status „Shared link“
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await expect(nav.getByText("Shared with you")).toBeVisible();
  await expect(nav.getByText("Create a teamspace")).toHaveCount(0);
  await expect(nav.getByRole("button", { name: /^New page in/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  await expect(page.getByTestId("sync-status")).toContainText("Shared link");
  // BSD-402: kein „Share“, keine Favoriten; im „…“-Menü nur, was nicht schreibt
  await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Favorites$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Page menu" }).click();
  const pageMenu = page.getByRole("menu", { name: "Page menu" });
  await expect(pageMenu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(pageMenu.getByRole("menuitem", { name: "Version history" })).toBeVisible();
  for (const name of ["Duplicate", "Move to…", "Move to Trash", "Add to Favorites"]) await expect(pageMenu.getByRole("menuitem", { name })).toHaveCount(0);
  await expect(pageMenu.getByRole("menuitemcheckbox", { name: /Lock page|Full width/ })).toHaveCount(0);
  if (process.env.BASED_SCREENSHOTS === "1" && test.info().project.name === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.screenshot({ path: `../../docs/design/screens/web-guest-view-only-menu-${theme}.png` });
    }
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  }
  await page.keyboard.press("Escape");
  await expect(pageMenu).toHaveCount(0);
  // Einstellungen → Sync & server: kein Server-Formular (der Link ist die Verbindung), nur der Hinweis
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await expect(page.getByTestId("sync-guest")).toContainText("127.0.0.1");
  await expect(page.getByLabel("Token")).toHaveCount(0);
  if (process.env.BASED_SCREENSHOTS === "1" && test.info().project.name === "chromium") await page.screenshot({ path: "../../docs/design/screens/web-guest-settings-sync-light.png" });
  await page.getByRole("treeitem", { name: "Team Wiki" }).click();
  await expect(content).toContainText("Welcome to the shared wiki");
  if (process.env.BASED_SCREENSHOTS === "1" && test.info().project.name === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(content).toContainText("Welcome to the shared wiki", { timeout: 20_000 });
      for (const [w, h, suffix] of [[1280, 820, ""], [900, 600, "-900"], [1728, 1000, "-1728"]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `../../docs/design/screens/web-guest-view-only-${theme}${suffix}.png` });
      }
    }
  }
});

test("Teil 3: widerrufener Link zeigt „This link no longer works“ statt eines leeren Gast-Arbeitsbereichs", async ({ page }) => {
  const res = await fetch(`${serverURL}/share/v1/links`, { method: "POST", headers: owner, body: JSON.stringify({ pageID: "11111111-1111-4111-8111-111111111111", kind: "access", role: "view" }) });
  const link = (await res.json()) as { id: string; secret: string };
  await page.goto("/#/share/" + encodeURIComponent(`${serverURL}/s/${link.secret}`));
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  expect((await fetch(`${serverURL}/share/v1/links/${link.id}/revoke`, { method: "POST", headers: owner })).ok).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("based-root")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Based" }).click();
  await expect(page).not.toHaveURL(/guest=/);
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "", { timeout: 20_000 });
});

test("Teil 3: Widerruf wirkt, während der Gast die Seite offen hat (ohne Neuladen von Hand)", async ({ page }) => {
  const res = await fetch(`${serverURL}/share/v1/links`, { method: "POST", headers: owner, body: JSON.stringify({ pageID: "11111111-1111-4111-8111-111111111111", kind: "access", role: "edit" }) });
  const link = (await res.json()) as { id: string; secret: string };
  await page.goto("/#/share/" + encodeURIComponent(`${serverURL}/s/${link.secret}`));
  await expect(page.getByTestId("page-content")).toContainText("Welcome to the shared wiki", { timeout: 20_000 });
  expect((await fetch(`${serverURL}/share/v1/links/${link.id}/revoke`, { method: "POST", headers: owner })).ok).toBe(true);
  // Zurück ins Fenster (oder der nächste Sync-Fehler, spätestens der Takt) → Hinweis statt weiter bearbeitbarer Seite
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("page-content")).toHaveCount(0);
});

test("BSD-282: Gast mit „Can edit“ bekommt kein endgültiges Löschen angeboten", async ({ page }) => {
  const link = await fetch(`${serverURL}/share/v1/links`, { method: "POST", headers: owner, body: JSON.stringify({ pageID: "11111111-1111-4111-8111-111111111111", kind: "access", role: "edit" }) });
  const { secret } = (await link.json()) as { secret: string };
  await page.goto("/#/share/" + encodeURIComponent(`${serverURL}/s/${secret}`));
  await expect(page).toHaveURL(/\?guest=[0-9a-f]{16}/);
  await expect(page.getByTestId("page-content")).toContainText("Welcome to the shared wiki", { timeout: 20_000 });
  const go = (r: unknown) => page.evaluate((route) => (globalThis as unknown as { __based: { history: { navigate(r: unknown): void } } }).__based.history.navigate(route), r);
  // Einstellungen → Workspace: „Open Trash“ ja, „Empty Trash…“ nein
  await go({ name: "settings", page: "workspace" });
  await expect(page.getByRole("button", { name: "Open Trash" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Empty Trash…" })).toHaveCount(0);
  // Papierkorb: Hinweis statt „endgültig löschen“
  await go({ name: "trash" });
  await expect(page.getByText("until the owner deletes them")).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete .*forever|Empty Trash/ })).toHaveCount(0);
});
