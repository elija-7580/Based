import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-315: Einstellungen → Sync & server → „Reachable from my other devices (Tailscale)“: Adresse im Tailnet,
// Gerät koppeln (QR-Code, eigenes Token), Geräteliste mit Revoke. Im Browser gibt es keine Hülle: der Zustand des
// lokalen Servers wird per Test-Haken vorgegeben, die Geräte-Routen laufen gegen einen echten TS-Server.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-tailnet-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
let server: ChildProcess;
let dataDir: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  const port = 20_000 + webPort + 500 + (browserName === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-tailnet-"));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(port), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
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

test("BSD-315: im Tailnet erreichbar – Adresse, Gerät koppeln (QR, eigenes Token), widerrufen", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const patch = (p: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __basedLocalServerTest(p: unknown): void }).__basedLocalServerTest(x), p);
  const open = async () => {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  };
  await open();
  // Server läuft, Tailscale fehlt: ehrlicher Hinweis, kein Koppeln
  await patch({ status: "running", enabled: true, url: serverURL, tailnet: true, tailnetUrls: [], token: TOKEN });
  await expect(page.getByTestId("tailnet-missing")).toContainText("Tailscale isn't running");
  await expect(page.getByRole("button", { name: "Pair…" })).toHaveCount(0);
  // mit Tailscale-Adresse
  await patch({ tailnetUrls: ["http://100.101.102.103:47821"] });
  await expect(page.getByTestId("tailnet-address")).toHaveText("http://100.101.102.103:47821");
  await page.getByLabel("Device name").fill("Elija's iPhone");
  await page.getByRole("button", { name: "Pair…" }).click();
  const pairing = page.getByTestId("tailnet-pairing");
  await expect(pairing.getByRole("img", { name: "Pairing code for your phone" })).toBeVisible();
  const token = (await pairing.getByText(/^bdo_/).textContent())!.trim();
  expect(token).not.toContain(TOKEN);
  // das Geräte-Token gilt beim Server, darf aber keine Geräte anlegen
  expect((await fetch(`${serverURL}/sync/v2/info`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  expect((await fetch(`${serverURL}/devices`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(403);
  const list = page.getByTestId("tailnet-devices");
  await expect(list.getByText("Elija's iPhone")).toBeVisible();
  await list.getByRole("button", { name: "Revoke" }).click();
  await expect(list).toHaveCount(0);
  expect((await fetch(`${serverURL}/sync/v2/info`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);

  // Checkliste „Fertig heißt poliert“: hell und dunkel, drei Fenstergrößen, mit offenem Kopplungs-Code
  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await open();
      await patch({ status: "running", enabled: true, url: serverURL, tailnet: true, tailnetUrls: ["http://100.101.102.103:47821"], token: TOKEN });
      await page.getByRole("button", { name: "Pair…" }).click();
      await expect(pairing.getByRole("img", { name: "Pairing code for your phone" })).toBeVisible();
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await pairing.scrollIntoViewIfNeeded();
        const box = (await pairing.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(w);
        await page.screenshot({ path: join(screens, `web-settings-tailnet-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
  }
});
