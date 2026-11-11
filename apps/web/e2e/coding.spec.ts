import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Coding-Agenten (BSD-223): TS-based-server mit --coding-root und einem Fake-ACP-Agenten (--coding-agents),
// Sitzung im Web-Client starten, Prompt, Freigabe in der Inbox erteilen → Datei geändert, Diff in der Konsole.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-coding-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
const FAKE = fileURLToPath(new URL("../../../packages/brain/test/fixtures/fake-acp-agent.mjs", import.meta.url));

let server: ChildProcess;
let dataDir: string;
let root: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  const serverPort = 20_000 + webPort + 200 + (browserName === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${serverPort}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-coding-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "based-e2e-code-")));
  writeFileSync(join(root, "a.txt"), "old\n");
  const agents = join(dataDir, "agents.json");
  writeFileSync(agents, JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE] }, { id: "claude", enabled: false }, { id: "codex", enabled: false }, { id: "gemini", enabled: false }, { id: "opencode", enabled: false }]));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(serverPort), "--host", "127.0.0.1",
    "--public-url", `http://localhost:${webPort}`, "--coding-root", root, "--coding-agents", agents], {
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
  if (root) rmSync(root, { recursive: true, force: true });
});

test("ohne Server: ehrlicher Hinweis", async ({ page }) => {
  await page.goto("/#coding");
  await expect(page.getByRole("heading", { name: "Connect a based-server" })).toBeVisible();
});

test("Sitzung starten, Prompt, Freigabe aus der Inbox → Datei geändert", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });

  // BSD-281: Coding steht nur im erweiterten Agenten-Modus in der Leiste – sonst über ⌘K
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search pages").fill("coding");
  await page.getByTestId("qf-command").filter({ hasText: "Coding" }).click();
  await expect(page.getByTestId("coding-screen")).toBeVisible();
  await page.getByLabel("Folder on the server").fill(root);
  await page.getByTestId("coding-start").click();
  await expect(page.getByTestId("coding-sessions").getByText("Fake Agent")).toBeVisible();

  await page.getByLabel("Message", { exact: true }).fill("hello");
  await page.getByTestId("coding-send").click();
  await expect(page.getByTestId("coding-console").getByText("Hi there")).toBeVisible({ timeout: 15_000 });

  await page.getByLabel("Message", { exact: true }).fill(`edit ${root}/a.txt`);
  await page.getByTestId("coding-send").click();
  const ask = page.getByTestId("coding-permission");
  await expect(ask).toContainText("Fake Agent wants to: Edit");
  if (browserName === "chromium") await page.screenshot({ path: join(screens, "web-coding-light.png") });
  await ask.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("coding-console").getByText("edited")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("coding-inbox")).toHaveCount(0);
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new\n");

  await page.getByRole("radio", { name: "Setup" }).click();
  await expect(page.getByTestId("coding-setup").getByText("Fake Agent")).toBeVisible({ timeout: 20_000 });
});
