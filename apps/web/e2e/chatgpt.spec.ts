import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-257: „Mit ChatGPT anmelden“ über den Codex-Login. TS-based-server mit --coding-root, Fake-`codex` im PATH
// (`codex login status` → „Logged in using ChatGPT“) und dem Fake-ACP-Agenten als „codex“. Anbieter ChatGPT in
// Einstellungen → Agents & AI wählen, Status sehen, Chat-Turn über die Codex-Sitzung.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-chatgpt-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const FAKE = fileURLToPath(new URL("../../../packages/brain/test/fixtures/fake-acp-agent.mjs", import.meta.url));

let server: ChildProcess;
let dataDir: string;
let serverURL: string;

test.beforeAll(async ({ browserName }) => {
  const serverPort = 20_000 + webPort + 600 + (browserName === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${serverPort}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-chatgpt-"));
  const root = realpathSync(mkdtempSync(join(dataDir, "root-")));
  const bin = join(dataDir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nif [ \"$1\" = \"login\" ]; then echo 'Logged in using ChatGPT' >&2; exit 0; fi\necho 'codex-cli 0.58.0'\n");
  chmodSync(join(bin, "codex"), 0o755);
  const agents = join(dataDir, "agents.json");
  writeFileSync(agents, JSON.stringify([{ id: "codex", command: process.execPath, args: [FAKE] }, { id: "claude", enabled: false }, { id: "gemini", enabled: false }, { id: "opencode", enabled: false }]));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(serverPort), "--host", "127.0.0.1",
    "--public-url", `http://localhost:${webPort}`, "--coding-root", root, "--coding-agents", agents], {
    cwd: serverDir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning" },
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

test("ChatGPT über Codex: Anbieter wählen, Status, Chat-Turn", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings pages" });

  // ohne Server: ehrlicher Hinweis
  await nav.getByRole("button", { name: "Agents & AI", exact: true }).click();
  const section = page.getByTestId("settings-section-ai-providers");
  await section.getByRole("radio", { name: "ChatGPT" }).click();
  await expect(section.getByTestId("chatgpt-status")).toHaveAttribute("data-state", "no-server");

  await nav.getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 20_000 });

  await nav.getByRole("button", { name: "Agents & AI", exact: true }).click();
  await section.getByRole("radio", { name: "ChatGPT" }).click();
  const status = section.getByTestId("chatgpt-status");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(status).toContainText("Signed in with ChatGPT through Codex");
  await section.getByRole("button", { name: "Use ChatGPT" }).click();
  await expect(section.getByText("In use")).toBeVisible();

  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+j`);
  const panel = page.getByTestId("chat-panel");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Ask Based").fill("hello");
  await panel.getByLabel("Ask Based").press("Enter");
  await expect(panel.getByTestId("assistant-message").last()).toContainText("Hi there", { timeout: 30_000 });
});
