// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-581: Einstellungen → System → „Connect AI apps“. Ein Dialog, zwei Ziele: „This Mac“ (Client startet `based mcp`,
// kein Token im Schnipsel) und „Server“ (eigenes, widerrufbares Token je Client). Im Browser gibt es keine Hülle: der
// lokale Server wird per Test-Haken vorgegeben; das Ziel „Server“ läuft gegen einen echten TS-Server.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-ai-apps-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
let server: ChildProcess;
let dataDir: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  const port = 20_000 + webPort + 600 + (browserName === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-ai-apps-"));
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

const patch = (page: Page, p: Record<string, unknown>) => page.evaluate((x) => (globalThis as unknown as { __basedLocalServerTest(p: unknown): void }).__basedLocalServerTest(x), p);

async function openDialog(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Connect AI apps" }).click();
  await page.getByRole("button", { name: "Connect…" }).click();
  const dialog = page.getByTestId("ai-apps-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const MAC = { status: "running", enabled: true, url: "http://127.0.0.1:47821", cli: { installed: true, target: "/Users/tester/.local/bin/based", message: undefined, busy: false } };

test("BSD-581: This Mac – ohne Mac-App ein Hinweis, mit lokalem Server Schnipsel ohne Token", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId("ai-apps-mac-unavailable")).toContainText("Open Based on your Mac");

  // lokaler Server aus, Befehl fehlt: „Copy setup“ gesperrt, Einschalten und Installieren angeboten
  await patch(page, { status: "off", enabled: false, url: undefined, cli: { installed: false, target: undefined, message: undefined, busy: false } });
  await expect(dialog.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Install…" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy setup for Claude Code" })).toBeDisabled();

  await patch(page, MAC);
  await expect(dialog).toContainText("Running. Apps reach Based on this Mac");
  await expect(dialog.getByRole("button", { name: "Install…" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Copy setup for Claude Desktop" }).click();
  const setup = dialog.getByTestId("ai-apps-setup-claude-desktop");
  const text = (await setup.locator(".settings-snippet").textContent())!;
  expect(JSON.parse(text)).toEqual({ mcpServers: { based: { command: "/Users/tester/.local/bin/based", args: ["mcp"] } } });
  expect(text).not.toMatch(/token|bdo_/i);
  if (browserName === "chromium") {
    await expect(setup).toContainText("Copied. Paste it into Claude Desktop.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  }
  await dialog.getByRole("button", { name: "Copy setup for Claude Code" }).click();
  await expect(dialog.getByTestId("ai-apps-setup-claude-code")).toContainText("claude mcp add --scope user based -- /Users/tester/.local/bin/based mcp");
  await expect(dialog.getByTestId("ai-apps-setup-claude-desktop")).toHaveCount(0);

  // Ziel „Server“ ohne eingestellten Server: ehrlicher Hinweis mit dem Weg dorthin
  await dialog.getByTestId("ai-apps-target").getByRole("radio", { name: "Server" }).click();
  await expect(dialog.getByTestId("ai-apps-no-server")).toBeVisible();
  await dialog.getByRole("button", { name: "Open Sync & server" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sync & server", level: 1 })).toBeVisible();
});

test("BSD-581: Server – eigenes Token je App, gilt für /mcp, widerrufbar", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await page.addInitScript(([url, token]) => { if (!sessionStorage.getItem("ai-apps-init")) { localStorage.setItem("based.sync", JSON.stringify({ url, token })); sessionStorage.setItem("ai-apps-init", "1"); } }, [serverURL, TOKEN] as const);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const dialog = await openDialog(page);
  await dialog.getByTestId("ai-apps-target").getByRole("radio", { name: "Server" }).click();
  await expect(dialog.getByTestId("ai-apps-server-url")).toHaveText(serverURL);
  await expect(dialog).toContainText("only serves areas that are open to agents");
  await dialog.getByRole("button", { name: "Copy setup for Claude Code" }).click();
  const snippet = (await dialog.getByTestId("ai-apps-setup-claude-code").locator(".settings-snippet").textContent())!;
  const token = /Bearer (bdo_[\w-]+)/.exec(snippet)?.[1];
  expect(token, snippet).toBeTruthy();
  expect(snippet).toContain(`--transport http based ${serverURL}/mcp`);
  expect(snippet).not.toContain(TOKEN);
  // das Token spricht MCP mit dem Server
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } };
  const mcp = (t: string) => fetch(`${serverURL}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
  expect((await mcp(token!)).status).toBe(200);
  const tokens = dialog.getByTestId("ai-apps-tokens");
  await expect(tokens.getByText("Claude Code", { exact: true })).toBeVisible();
  // eine zweite App bekommt ein zweites Token mit eigenem Namen
  await dialog.getByRole("button", { name: "Copy setup for Cursor" }).click();
  await expect(tokens.getByText("Cursor", { exact: true })).toBeVisible();

  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      const d = await openDialog(page);
      await patch(page, MAC);
      await d.getByRole("button", { name: "Copy setup for Claude Desktop" }).click();
      await expect(d.getByTestId("ai-apps-setup-claude-desktop")).toBeVisible();
      await page.screenshot({ path: `${screens}/web-ai-apps-mac-${theme}.png` });
      await d.getByTestId("ai-apps-target").getByRole("radio", { name: "Server" }).click();
      await expect(d.getByTestId("ai-apps-tokens")).toBeVisible();
      await page.screenshot({ path: `${screens}/web-ai-apps-server-${theme}.png` });
      // Checkliste: in 900 × 600 und 1728 × 1000 nichts breiter als der Dialog, alles erreichbar
      for (const [w, h] of [[900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        const overflow = await d.evaluate((el) => [...el.querySelectorAll("*")].some((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1));
        expect(overflow, `${w}×${h}`).toBe(false);
        await d.getByRole("button", { name: "Done" }).scrollIntoViewIfNeeded();
        await expect(d.getByRole("button", { name: "Done" })).toBeInViewport();
      }
      await page.setViewportSize({ width: 1280, height: 820 });
    }
  }

  // Widerrufen: Token gilt nicht mehr
  const d = page.getByTestId("ai-apps-dialog");
  await d.getByTestId("ai-apps-target").getByRole("radio", { name: "Server" }).click();
  await d.getByTestId("ai-apps-tokens").getByRole("button", { name: "Revoke Claude Code" }).click();
  await expect(d.getByTestId("ai-apps-tokens").getByText("Claude Code", { exact: true })).toHaveCount(0);
  expect((await mcp(token!)).status).toBe(401);
});

// BSD-630 (Elija 20.11.): Die Adresse, die ein MCP-Client braucht, steht kopierbar da – auf der Seite und im Dialog die
// des lokalen Servers (http://127.0.0.1:<port>/mcp), im Ziel „Server“ die des eigenen Servers. „Copy“ legt genau sie in
// die Zwischenablage und meldet „Copied“.
test("BSD-630: MCP-Adresse kopierbar – lokal auf der Seite und im Dialog, Server im Dialog", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(([url, token]) => { if (!sessionStorage.getItem("ai-apps-init")) { localStorage.setItem("based.sync", JSON.stringify({ url, token })); sessionStorage.setItem("ai-apps-init", "1"); } }, [serverURL, TOKEN] as const);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Connect AI apps" }).click();
  const settings = page.getByTestId("settings-page");
  // ohne laufenden lokalen Server keine lokale Adresse
  await expect(settings.getByTestId("ai-apps-local-mcp")).toHaveCount(0);
  await patch(page, { ...MAC, url: "http://127.0.0.1:47822" });
  const local = settings.getByTestId("ai-apps-local-mcp").first();
  await expect(local.getByTestId("ai-apps-local-mcp-value")).toHaveText("http://127.0.0.1:47822/mcp");
  await local.getByRole("button", { name: "Copy local mcp address" }).click();
  await expect(local.getByRole("button", { name: "Copied" })).toBeVisible();
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("http://127.0.0.1:47822/mcp");
  await expect(local.getByRole("button", { name: "Copy local mcp address" })).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: "Connect…" }).click();
  const dialog = page.getByTestId("ai-apps-dialog");
  await expect(dialog.getByTestId("ai-apps-local-mcp-value")).toHaveText("http://127.0.0.1:47822/mcp");
  await dialog.getByTestId("ai-apps-target").getByRole("radio", { name: "Server" }).click();
  const remote = dialog.getByTestId("ai-apps-server-mcp");
  await expect(remote.getByTestId("ai-apps-server-mcp-value")).toHaveText(`${serverURL}/mcp`);
  await remote.getByRole("button", { name: "Copy mcp address" }).click();
  await expect(remote.getByRole("button", { name: "Copied" })).toBeVisible();
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${serverURL}/mcp`);
  // die Adresse spricht wirklich MCP (mit dem Token des Servers)
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } };
  const r = await fetch(`${serverURL}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
  expect(r.status).toBe(200);
});
