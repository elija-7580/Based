// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { overflows, overlaps } from "./layout-checks.js";

// BSD-609 (Entscheidung Elija 19.11.: „zeigen“): Based Notes Beta zeigt Rückfragen von KI-Apps unter Einstellungen →
// Connect AI apps als Liste (Frage, App, was passiert, Allow/Decline). Ein echter TS-Server mit BASED_CHANNEL=beta legt
// die Anfrage über MCP an, die App synchronisiert sie, Allow löscht die Seite auf dem Server, Decline lässt sie im
// Papierkorb. Läuft nur im Beta-Build (wie beta-build.spec.ts):
//   BASED_CHANNEL=beta BASED_E2E_PORT=4179 CI=1 pnpm --filter @based/web exec playwright test e2e/beta-requests.spec.ts

const BETA = process.env.BASED_CHANNEL === "beta";
test.skip(!BETA, "nur mit BASED_CHANNEL=beta (Beta-Build)");

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-beta-requests-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
let server: ChildProcess;
let dataDir: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  if (!BETA) return;
  const port = 20_000 + webPort + 1300 + (browserName === "webkit" ? 50 : 0);
  serverURL = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-beta-requests-"));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(port), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
    cwd: serverDir, env: { ...process.env, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning", BASED_CHANNEL: "beta" }, stdio: ["ignore", "ignore", "inherit"], detached: true,
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${serverURL}/health`)).ok) return; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("based-server did not start");
});

test.afterAll(async () => {
  if (server?.pid && server.exitCode === null) await new Promise<void>((r) => { server.once("exit", () => r()); try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill(); } setTimeout(r, 5000); });
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch { /* /tmp */ }
});

/** Ein Werkzeug über MCP aufrufen, wie es eine KI-App tut (Streamable HTTP, zustandslos). */
async function mcp(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(`${serverURL}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_tool", arguments: { name, args } } }),
  });
  const j = (await r.json()) as { result?: { content: { text: string }[] }; error?: { message: string } };
  if (!j.result) throw new Error(j.error?.message ?? `MCP ${r.status}`);
  return j.result.content.map((c) => c.text).join("\n");
}

async function trashedPage(title: string): Promise<string> {
  const id = /id: ([0-9A-Fa-f-]{36})/.exec(await mcp("create_page", { title }))?.[1];
  expect(id).toBeTruthy();
  await mcp("trash_page", { id });
  return id!;
}

async function openSettings(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name, exact: true }).click();
}

async function start(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const welcome = page.getByTestId("welcome");
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.getByRole("button", { name: "Skip" }).click();
    await welcome.getByRole("button", { name: /Start empty/ }).click();
  }
  await openSettings(page, "Sync & server");
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  await openSettings(page, "Connect AI apps");
  return page.getByTestId("settings-section-ai-requests");
}

async function clean(page: Page, where: string) {
  await page.mouse.move(0, 0);
  expect(await overflows(page), where).toEqual([]);
  expect(await overlaps(page), where).toEqual([]);
}

test("BSD-609: Rückfrage einer KI-App erscheint in der Beta, Allow löscht, Decline lässt im Papierkorb", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  // BSD-595: die Liste und ihre Antworten laden keinen Chat- oder Agenten-Code (die Einstellungen selbst laden schon
  // vorher die AI-Konfiguration; geprüft werden der Chunk mit der Liste und alles, was danach nachgeladen wird)
  const scripts = new Map<string, Promise<string>>();
  page.on("response", (r) => { if (/\.m?js(\?|$)/.test(r.url()) && !scripts.has(r.url())) scripts.set(r.url(), r.text().catch(() => "")); });
  const section = await start(page);
  await expect(section.getByRole("heading", { name: "Requests from AI apps" })).toBeVisible();
  const before = new Set(scripts.keys());
  await expect(section.getByTestId("ai-requests-empty")).toContainText("the request waits here");

  // Allow: die KI-App erfährt, wo die Anfrage wartet; nach Allow ist die Seite auf dem Server weg.
  const doomed = await trashedPage("Old meeting notes");
  expect(await mcp("delete_forever", { ids: [doomed] })).toContain("Asked the user in Based (Settings → Connect AI apps)");
  const row = section.getByTestId("ai-request");
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toContainText("Delete forever: “Old meeting notes”");
  await expect(row).toContainText("An AI app asked just now. Allowing deletes it for good.");
  await clean(page, "Liste mit einer Anfrage");
  await row.getByRole("button", { name: "Allow: Delete forever: “Old meeting notes”" }).click();
  await expect(section.getByTestId("ai-requests-status")).toHaveText("Allowed. Based carries it out now.");
  await expect(row).toHaveCount(0);
  await expect.poll(() => mcp("list_trash"), { timeout: 20_000 }).not.toContain("Old meeting notes");

  // Decline: Seite bleibt im Papierkorb, die Anfrage ist zu.
  const kept = await trashedPage("Keep this draft");
  await mcp("delete_forever", { ids: [kept] });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await row.getByRole("button", { name: "Decline: Delete forever: “Keep this draft”" }).click();
  await expect(section.getByTestId("ai-requests-status")).toHaveText("Declined. Nothing was changed.");
  await expect(row).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await mcp("list_trash")).toContain("Keep this draft");

  const offenders: string[] = [];
  for (const [url, body] of scripts) {
    const text = await body;
    if (before.has(url) && !text.includes("Requests from AI apps")) continue;
    for (const marker of ["anthropic-version", "api.anthropic.com", "edit_blocks", "draw_board", "save_skill"]) if (text.includes(marker)) offenders.push(`${url.split("/").pop()}: ${marker}`);
  }
  expect(offenders).toEqual([]);

  // Checkliste: zwei Anfragen, eine mit sehr langem Titel; hell/dunkel 1280 × 820 (Fotos), dazu 900 × 600 und 1728 × 1000 ohne Überlauf.
  const long = await trashedPage("Quarterly planning notes with a very long title that keeps going to check that the request list wraps instead of overflowing the row");
  await mcp("delete_forever", { ids: [long] });
  expect(await mcp("empty_trash")).toContain("Asked the user in Based");
  await expect(row).toHaveCount(2, { timeout: 20_000 });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await openSettings(page, "Connect AI apps");
    await expect(row).toHaveCount(2, { timeout: 20_000 });
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await clean(page, `${theme} ${w}×${h}`);
      if (w === 1280 && browserName === "chromium") await page.screenshot({ path: join(screens, `beta-ai-requests-${theme}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 820 });
  }
  await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
});
