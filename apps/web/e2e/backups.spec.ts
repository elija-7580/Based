import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-274: Einstellungen → Sync & server → Backups gegen einen echten TS-Server mit --backups: Seite anlegen,
// „Back up now“, Seite löschen und Papierkorb leeren, „Restore…“ mit Vorschau → Seite ist wieder da.
// Im Browser gibt es keine Hülle: der lokale Server wird per Test-Haken auf diesen Server gezeigt.
// BSD-648: ein beschädigter Stand – die Rückfrage nennt ihn beschädigt, mit N von M lesbaren Records.

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
  await expect.poll(async () => JSON.stringify(await (await fetch(`${serverURL}/sync/v2/pull?after=0&limit=500`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Based-Protocol": "3" } })).json()), { timeout: 20_000 }).toContain("Precious notes");
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

  // BSD-648: ein beschädigter Stand (hier: nach zwei Records abgeschnitten) – die Rückfrage sagt das zuerst, mit
  // N von M lesbaren Records, und dass nichts entfernt wird (BSD-649); hier wird nur abgebrochen.
  const newest = readdirSync(join(backupDir, "snapshots")).filter((f) => f.endsWith(".based.jsonl")).sort().at(-1)!;
  const full = readFileSync(join(backupDir, "snapshots", newest), "utf8").split("\n").filter((l) => l !== "");
  const at = Date.now() - 3 * 86_400_000;
  const damagedName = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-") + ".based.jsonl";
  writeFileSync(join(backupDir, "snapshots", damagedName), full.slice(0, 3).join("\n") + "\n");
  for (const theme of browserName === "chromium" ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await openSettings();
    await patch({ status: "running", enabled: true, url: serverURL, token: TOKEN });
    const label = await page.evaluate((x) => new Date(x).toLocaleString(), Math.floor(at / 1000) * 1000);
    await page.getByTestId("backup-list").getByRole("listitem").filter({ hasText: label }).getByRole("button", { name: "Restore…" }).click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText(`This backup is damaged: only 2 of ${full.length - 1} records can be read. Restoring it brings back the readable part from`);
    await expect(ask).toContainText("and removes nothing:");
    await expect(ask).not.toContainText("away"); // BSD-649: nichts geht weg
    await page.waitForTimeout(400); // Einblenden abwarten (Bildschirmfoto)
    if (browserName === "chromium") await page.screenshot({ path: join(screens, `web-settings-backups-restore-damaged-${theme}.png`) });
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: "Precious notes" })).toBeVisible();
  }
  await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
});

// BSD-449: selbst gewählter Ordner (externes Laufwerk). Server mit BASED_BACKUP_CREATE=0 wie aus der App: Backup
// landet im Ordner; Laufwerk weg → sichtbarer Hinweis, kein Ersatzordner, Rückweg nur per Klick.
test("BSD-449: gewählter Backup-Ordner – Backup landet dort, fehlender Ordner sichtbar, kein stiller Rückfall", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  const port = 20_000 + webPort + 750 + (browserName === "webkit" ? 100 : 0);
  const url = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "based-e2e-drive-"));
  const drive = join(data, "Drive");
  const chosen = join(drive, "Based on Drive");
  mkdirSync(chosen, { recursive: true });
  const srv = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(data, "based.sqlite"), "--port", String(port), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
    cwd: serverDir, env: { ...process.env, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning", BASED_BACKUP_DIR: chosen, BASED_BACKUP_CREATE: "0" }, stdio: ["ignore", "ignore", "inherit"], detached: true,
  });
  try {
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* startet noch */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const patch = (p: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __basedLocalServerTest(p: unknown): void }).__basedLocalServerTest(x), p);
    const open = async () => {
      await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
      await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
      await patch({ status: "running", enabled: true, url, token: TOKEN, backupDir: chosen });
    };
    await open();
    await expect(page.getByText(`${chosen} — chosen by you`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Use standard folder" })).toBeVisible();
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByTestId("backup-message")).toHaveText(/Backed up\.|Nothing changed/);
    expect(readdirSync(join(chosen, "snapshots")).length).toBeGreaterThanOrEqual(1);

    // Laufwerk abgezogen
    rmSync(drive, { recursive: true, force: true });
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await open();
    const alert = page.getByTestId("backup-unreachable");
    await expect(alert).toContainText("isn't available");
    await expect(alert).toContainText("No backups are made until it's back.");
    await expect(page.getByRole("button", { name: "Show in Finder" })).toHaveCount(0);
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByTestId("backup-message")).toContainText("isn't available");
    expect(existsSync(chosen)).toBe(false); // nichts still angelegt
    if (browserName === "chromium") {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
        await page.reload();
        await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
        await open();
        await expect(page.getByTestId("backup-unreachable")).toBeVisible();
        await page.getByTestId("backup-unreachable").scrollIntoViewIfNeeded();
        const box = (await page.getByTestId("backup-unreachable").boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(1280);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(screens, `web-settings-backups-folder-missing-${theme}.png`) });
      }
      await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
    }
  } finally {
    await new Promise<void>((r) => { srv.once("exit", () => r()); try { process.kill(-srv.pid!, "SIGTERM"); } catch { srv.kill(); } setTimeout(r, 5000); });
    rmSync(data, { recursive: true, force: true });
  }
});
