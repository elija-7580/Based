import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-243 Teil 3b: Einstellungen → Agents & AI → Schedules sagt, ob Zeitpläne auch bei geschlossener App laufen
// (Server mit Modellzugang meldet agents.runsOnServer in /sync/v2/info).

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-schedules-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
let server: ChildProcess;
let dataDir: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  const port = 20_000 + webPort + 900 + (browserName === "webkit" ? 50 : 0);
  serverURL = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-sched-"));
  // Schlüssel nur, damit der Server „runsOnServer“ meldet; es wird kein Lauf gestartet.
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(port), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
    cwd: serverDir, env: { ...process.env, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning", BASED_ANTHROPIC_API_KEY: "sk-ant-e2e-not-used" }, stdio: ["ignore", "ignore", "inherit"], detached: true,
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

test("BSD-243: Hinweis unter Schedules – ohne Server nur bei offener App, mit Server mit Modellzugang auch geschlossen", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const open = async (name: string) => {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name }).click();
  };
  await open("Agents & AI");
  await expect(page.getByTestId("schedules-where")).toHaveText("Scheduled runs start while Based is open in this browser or app.");
  await open("Sync & server");
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  await open("Agents & AI");
  const hint = page.getByTestId("schedules-where");
  await expect(hint).toContainText("also start when Based is closed");
  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await open("Agents & AI");
      await expect(hint).toContainText("also start when Based is closed");
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await hint.scrollIntoViewIfNeeded();
        const box = (await hint.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(w);
        await page.screenshot({ path: join(screens, `web-settings-schedules-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
  }
});
