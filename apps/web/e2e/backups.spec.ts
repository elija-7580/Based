import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-274: Einstellungen → Sync & server → Backups gegen einen echten TS-Server mit --backups: Seite anlegen,
// „Back up now“, Seite löschen und Papierkorb leeren, „Restore…“ mit Vorschau → Seite ist wieder da.
// Im Browser gibt es keine Hülle: der lokale Server wird per Test-Haken auf diesen Server gezeigt.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-backups-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
let server: ChildProcess;
let dataDir: string;
let backupDir: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  const port = 20_000 + webPort + 700 + (browserName === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-backups-"));
  backupDir = join(dataDir, "Based Backups");
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(port), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`, "--backups", backupDir], {
    cwd: serverDir, env: { ...process.env, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning" }, stdio: ["ignore", "ignore", "inherit"], detached: true,
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${serverURL}/health`)).ok) return; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("based-server did not start");
});

test.afterAll(async () => {
  if (server?.pid && server.exitCode === null) await new Promise<void>((r) => { server.once("exit", () => r()); try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill(); } setTimeout(r, 5000); });
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* /tmp */ }
});

test("BSD-274: Back up now, Seite löschen und Papierkorb leeren, aus dem Backup wiederherstellen", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const cmd = (c: unknown) => page.evaluate((x) => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<unknown> } } }).__based.client.command(x), c);
  const patch = (p: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __basedLocalServerTest(p: unknown): void }).__basedLocalServerTest(x), p);
  const openSettings = async () => {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  };
  await openSettings();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  const id = await cmd({ op: "createPage", title: "Precious notes" }) as string;
  await expect(page.getByRole("treeitem", { name: "Precious notes" })).toBeVisible();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  await openSettings();
  await patch({ status: "running", enabled: true, url: serverURL, token: TOKEN });
  // der Server hat die Seite (sonst wäre sie nicht im Backup)
  await expect.poll(async () => JSON.stringify(await (await fetch(`${serverURL}/sync/v2/pull?after=0&limit=500`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()), { timeout: 20_000 }).toContain("Precious notes");
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByTestId("backup-message")).toHaveText("Backed up.");
  await expect(page.getByTestId("backup-not-synced")).toHaveCount(0);
  expect(readdirSync(join(backupDir, "snapshots")).length).toBeGreaterThanOrEqual(1);

  await cmd({ op: "trash", ids: [id] });
  await cmd({ op: "emptyTrash" });
  await expect(page.getByRole("treeitem", { name: "Precious notes" })).toHaveCount(0);
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  // warten, bis der Server die Löschung hat (Vorschau des neuesten Stands zeigt die Seite als „kommt zurück“)
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
  await expect.poll(async () => {
    const list = (await (await fetch(`${serverURL}/backups`, auth)).json()) as { snapshots: { name: string }[] };
    return ((await (await fetch(`${serverURL}/backups/${list.snapshots[0]!.name}/preview`, auth)).json()) as { pages: { added: number } }).pages.added;
  }, { timeout: 20_000 }).toBe(1);
  await page.waitForTimeout(1100); // eigener Name für den Stand vor dem Wiederherstellen (Sekunden)

  await page.getByTestId("backup-list").getByRole("button", { name: "Restore…" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("1 page comes back, 0 pages change, 0 pages go away");
  await page.waitForTimeout(400); // Einblenden abwarten (Bildschirmfoto)
  if (browserName === "chromium") await page.screenshot({ path: join(screens, "web-settings-backups-restore-light.png") });
  await dialog.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("backup-message")).toContainText("Restored the backup");
  await expect(page.getByRole("treeitem", { name: "Precious notes" })).toBeVisible({ timeout: 20_000 });

  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await openSettings();
      await patch({ status: "running", enabled: true, url: serverURL, token: TOKEN });
      const list = page.getByTestId("backup-list");
      await expect(list).toBeVisible();
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await list.scrollIntoViewIfNeeded();
        const box = (await list.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(w);
        await page.screenshot({ path: join(screens, `web-settings-backups-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
  }
});
