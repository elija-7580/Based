import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
let home: string;

const j = (o: unknown) => JSON.stringify(o);
/** BSD-251: ein Claude-Code- und ein Codex-Gespräch im (falschen) Home des Servers. */
function writeCliHistory(h: string, cwd: string) {
  mkdirSync(join(h, ".claude", "projects", "-p-web"), { recursive: true });
  writeFileSync(join(h, ".claude", "projects", "-p-web", "abc-1.jsonl"), [
    j({ type: "summary", summary: "Fix the login bug", leafUuid: "x" }),
    j({ type: "user", sessionId: "abc-1", cwd, gitBranch: "main", timestamp: "2026-11-01T10:00:01.000Z", message: { role: "user", content: "Why does login fail?" } }),
    j({ type: "assistant", timestamp: "2026-11-01T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: `${cwd}/a.txt` } }] } }),
    j({ type: "user", timestamp: "2026-11-01T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "old" }] }] } }),
    j({ type: "assistant", timestamp: "2026-11-01T10:00:09.000Z", message: { role: "assistant", content: [{ type: "text", text: "The token expired." }] } }),
  ].join("\n"));
  mkdirSync(join(h, ".codex", "sessions", "2026", "11", "02"), { recursive: true });
  writeFileSync(join(h, ".codex", "sessions", "2026", "11", "02", "rollout-2026-11-02T08-00-00-0199-uuid.jsonl"), [
    j({ timestamp: "2026-11-02T08:00:00.000Z", type: "session_meta", payload: { id: "0199-uuid", cwd, timestamp: "2026-11-02T08:00:00.000Z" } }),
    j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a health route with a very long description that has to be shortened in the list because it does not fit" }] } }),
    j({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
  ].join("\n"));
}

test.beforeAll(async ({ browserName }) => {
  const serverPort = 20_000 + webPort + 200 + (browserName === "webkit" ? 100 : 0);
  serverURL = `http://127.0.0.1:${serverPort}`;
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-coding-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "based-e2e-code-")));
  writeFileSync(join(root, "a.txt"), "old\n");
  home = mkdtempSync(join(tmpdir(), "based-e2e-home-"));
  writeCliHistory(home, root);
  const agents = join(dataDir, "agents.json");
  writeFileSync(agents, JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE] }, { id: "claude", enabled: false }, { id: "codex", enabled: false }, { id: "gemini", enabled: false }, { id: "opencode", enabled: false }]));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(serverPort), "--host", "127.0.0.1",
    "--public-url", `http://localhost:${webPort}`, "--coding-root", root, "--coding-agents", agents], {
    cwd: serverDir,
    env: { ...process.env, HOME: home, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning" },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
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

test.afterAll(async () => {
  // BSD-314: erst warten, bis der Server (und mit ihm die Terminal-Shell) beendet ist – die Shell schreibt beim
  // Beenden noch ihren Verlauf ins Home.
  // Prozessgruppe beenden (pnpm → tsx → Server → Shell), nicht nur pnpm.
  if (server?.pid && server.exitCode === null) {
    await new Promise<void>((r) => { server.once("exit", () => r()); try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill(); } setTimeout(r, 5000); });
  }
  // Aufräumen in /tmp darf den Lauf nicht rot machen (eine Shell kann ihren Verlauf noch schreiben).
  const rm = (p: string) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* bleibt in /tmp */ } };
  if (dataDir) rm(dataDir);
  if (root) rm(root);
  if (home) rm(home);
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

test("BSD-251: Gespräche aus Claude Code und Codex stehen im Chat, lassen sich lesen; Fortsetzen sagt ehrlich, was fehlt", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  // ohne Server: im Browser kein Angebot und keine leere Gruppe
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chat" }).click();
  await expect(page.getByTestId("chat-page")).toBeVisible();
  await expect(page.getByTestId("cli-chats")).toHaveCount(0);
  await expect(page.getByTestId("cli-chats-offer")).toHaveCount(0);

  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });

  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chat" }).click();
  const group = page.getByTestId("cli-chats");
  await expect(group.getByText("Claude Code & Codex")).toBeVisible({ timeout: 15_000 });
  // neuestes zuerst: Codex (2.11.) vor Claude Code (1.11.)
  const rows = group.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Add a health route");
  await expect(rows.nth(0)).toContainText("Codex");
  await expect(rows.nth(1)).toContainText("Fix the login bug");
  await expect(rows.nth(1)).toContainText("Claude Code");

  await group.getByText("Fix the login bug").click();
  const messages = page.getByTestId("cli-chat-messages");
  await expect(messages.getByText("Why does login fail?")).toBeVisible();
  await expect(messages.getByText("The token expired.")).toBeVisible();
  await expect(page.getByTestId("cli-chat-bar")).toContainText("Claude Code");
  // nur lesen: kein Eingabefeld, solange ein CLI-Gespräch offen ist
  await expect(page.locator("#chat-input-page")).toHaveCount(0);
  // kein hängendes „… is thinking“ in einem abgeschlossenen Gespräch
  await expect(messages.getByText(/is thinking/)).toHaveCount(0);

  // Live: schreibt das CLI im Terminal weiter, erscheint die neue Nachricht ohne Neuladen, mit „Live“-Marker
  await expect(page.getByTestId("cli-chat-live")).toHaveCount(0);
  appendFileSync(join(home, ".claude", "projects", "-p-web", "abc-1.jsonl"), "\n" + [
    j({ type: "user", timestamp: "2026-11-01T10:01:00.000Z", message: { role: "user", content: "And how do I renew it?" } }),
    j({ type: "assistant", timestamp: "2026-11-01T10:01:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Run the refresh script." }] } }),
  ].join("\n"));
  await expect(messages.getByText("And how do I renew it?")).toBeVisible({ timeout: 5000 });
  await expect(messages.getByText("Run the refresh script.")).toBeVisible();
  await expect(page.getByTestId("cli-chat-live")).toBeVisible();

  // Fortsetzen: der Agent „claude“ ist in diesem Test nicht eingerichtet → klare Meldung statt stillem Nichts
  await page.getByRole("button", { name: "Continue in Based" }).click();
  await expect(messages.getByRole("alert")).toContainText("Claude Code isn't set up as a coding agent here");

  // ein Based-Chat übernimmt wieder: neuer Chat zeigt das Eingabefeld
  await page.getByTestId("chat-page").getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("cli-chat-bar")).toHaveCount(0);
  await expect(page.getByTestId("chat-messages")).toBeVisible();

  // Checkliste „Fertig heißt poliert“: hell und dunkel in drei Fenstergrößen ansehen
  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chat" }).click();
      await page.getByTestId("cli-chats").getByText("Fix the login bug").click();
      await expect(page.getByTestId("cli-chat-messages").getByText("The token expired.")).toBeVisible();
      // Zustand „Live“ mitfotografieren: das CLI schreibt gerade
      appendFileSync(join(home, ".claude", "projects", "-p-web", "abc-1.jsonl"), "\n" + j({ type: "assistant", timestamp: "2026-11-01T10:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: `Still working (${theme}).` }] } }));
      await expect(page.getByTestId("cli-chat-live")).toBeVisible({ timeout: 5000 });
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        // nichts läuft waagrecht heraus, die Knöpfe bleiben ganz sichtbar
        const bar = (await page.getByTestId("cli-chat-bar").boundingBox())!;
        const go = (await page.getByRole("button", { name: "Continue in Based" }).boundingBox())!;
        expect(go.x + go.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
        const liveBox = (await page.getByTestId("cli-chat-live").boundingBox())!;
        expect(liveBox.x + liveBox.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
        expect(await page.getByTestId("chat-page").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: join(screens, `web-chat-cli-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
      }
    }
  }
});

// BSD-313: Slash-Befehle des Agenten, @Dateien als Chip (resource_link), ⇧Tab schaltet die Modi des Agenten.
test("BSD-313: / zeigt die Befehle, @ sucht Dateien im Ordner, ⇧Tab wechselt den Modus", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  await page.goto("/#coding");
  await expect(page.getByTestId("coding-screen")).toBeVisible();
  await page.getByLabel("Folder on the server").fill(root);
  await page.getByTestId("coding-start").click();
  const mode = page.getByTestId("coding-agent-mode");
  await expect(mode.getByRole("button", { name: "Mode: Default" })).toBeVisible({ timeout: 15_000 });

  const input = page.getByLabel("Message", { exact: true });
  // ⇧Tab im Eingabefeld: nächster Modus des Agenten, Fokus bleibt
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(mode.getByRole("button", { name: "Mode: Accept edits" })).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(mode.getByRole("button", { name: "Mode: Plan" })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(mode.getByRole("button", { name: "Mode: Default" })).toBeVisible();

  // „/“: Befehle des Agenten mit Beschreibung; Pfeil + Enter übernimmt, Esc schließt
  await input.pressSequentially("/");
  const cmds = page.getByTestId("coding-commands");
  await expect(cmds.getByText("/review")).toBeVisible({ timeout: 10_000 });
  await expect(cmds.getByText("Review the current changes")).toBeVisible();
  await expect(cmds.getByText("/compact")).toBeVisible();
  await input.pressSequentially("co");
  await expect(cmds.getByText("/review")).toHaveCount(0);
  await expect(cmds.getByText("/compact")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cmds).toHaveCount(0);
  await input.fill("");
  await input.pressSequentially("/");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("/init ");
  await expect(cmds).toHaveCount(0);

  // „@“: Dateien aus dem Arbeitsordner, Auswahl wird Chip, der Text bleibt ohne „@…“
  await input.fill("");
  await input.pressSequentially("look at @mai");
  const files = page.getByTestId("coding-files");
  await expect(files.getByText("main.ts", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(files.getByText("src/main.ts")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("look at ");
  const chips = page.getByTestId("coding-file-chips");
  await expect(chips.getByText("@main.ts")).toBeVisible();
  if (browserName === "chromium") await page.screenshot({ path: join(screens, "web-coding-chip-light.png") });
  await page.getByTestId("coding-send").click();
  // Fake-Agent wiederholt die Prompt-Blöcke: Text und Verweis auf die Datei
  await expect(page.getByTestId("coding-console").getByText(/resource_link/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("coding-console").getByText(/src\/main\.ts/).first()).toBeVisible();
  await expect(chips).toHaveCount(0);

  // Checkliste „Fertig heißt poliert“: Datei-Menü hell und dunkel in drei Fenstergrößen; nichts läuft heraus
  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await page.getByTestId("coding-sessions").getByRole("listitem").first().click();
      await input.fill("");
      await input.pressSequentially("look at @mai");
      await expect(files.getByText("main.ts", { exact: true })).toBeVisible({ timeout: 10_000 });
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await input.scrollIntoViewIfNeeded();
        const menu = (await files.boundingBox())!;
        const field = (await input.boundingBox())!;
        expect(menu.x + menu.width).toBeLessThanOrEqual(w);
        expect(menu.y + menu.height).toBeLessThanOrEqual(field.y + 1);
        await expect(page.getByTestId("coding-agent-mode")).toBeInViewport();
        await page.screenshot({ path: join(screens, `web-coding-files-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
  }
});

// BSD-314: echtes Terminal je Sitzung (xterm.js + PTY auf dem Server), im Arbeitsordner der Sitzung.
test("BSD-314: Terminal-Reiter – echo im Arbeitsordner, Farben hell/dunkel, Größe folgt dem Fenster", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  await page.goto("/#coding");
  await page.getByLabel("Folder on the server").fill(root);
  await page.getByTestId("coding-start").click();
  await expect(page.getByTestId("coding-agent-mode")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("radio", { name: "Terminal" }).click();
  const term = page.getByTestId("coding-terminal");
  await expect(term.locator(".xterm-rows")).toBeVisible({ timeout: 15_000 });
  await term.click();
  await page.keyboard.type("pwd; echo hi-$((40+2))");
  await page.keyboard.press("Enter");
  await expect(term.locator(".xterm-rows")).toContainText("hi-42", { timeout: 15_000 });
  await expect(term.locator(".xterm-rows")).toContainText(root.split("/").pop()!);
  // Zurück zum Transkript und wieder hin: dieselbe Shell, alte Ausgabe noch da
  await page.getByRole("radio", { name: "Transcript" }).click();
  await expect(page.getByTestId("coding-console")).toBeVisible();
  await page.getByRole("radio", { name: "Terminal" }).click();
  await expect(term.locator(".xterm-rows")).toContainText("hi-42", { timeout: 15_000 });
  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await page.getByTestId("coding-sessions").getByRole("listitem").last().click();
      await page.getByRole("radio", { name: "Terminal" }).click();
      await expect(term.locator(".xterm-rows")).toContainText("hi-42", { timeout: 15_000 });
      for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
        await page.setViewportSize({ width: w, height: h });
        const box = (await term.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(w);
        // xterm füllt die Fläche (Größe folgt dem Fenster)
        await expect.poll(async () => (await term.locator(".xterm-screen").boundingBox())!.width).toBeGreaterThan(box.width * 0.85);
        await expect(page.getByTestId("coding-agent-mode")).toBeInViewport();
        await page.screenshot({ path: join(screens, `web-coding-terminal-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
  }
});

// BSD-315: vom Handy (390 × 844) bedienbar – Sitzung starten, Freigabe mit großen Knöpfen, nichts läuft waagrecht heraus.
test("BSD-315: #coding auf dem Handy (390 × 844)", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  // verbinden im großen Fenster, dann aufs Handy-Format
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#coding");
  await expect(page.getByTestId("coding-screen")).toBeVisible();
  await page.getByLabel("Folder on the server").fill(root);
  await page.getByTestId("coding-start").click();
  await expect(page.getByTestId("coding-agent-mode")).toBeVisible({ timeout: 15_000 });
  writeFileSync(join(root, "a.txt"), "old\n");
  await page.getByLabel("Message", { exact: true }).fill(`edit ${root}/a.txt`);
  await page.getByTestId("coding-send").click();
  const ask = page.getByTestId("coding-permission");
  await expect(ask).toContainText("wants to: Edit");
  const allow = ask.getByRole("button", { name: "Allow", exact: true });
  await allow.scrollIntoViewIfNeeded();
  // große Knöpfe zum Tippen (≥ 44 px hoch)
  expect((await allow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // Reiter oben nicht abgeschnitten (kein „Sess…“)
  for (const name of ["Sessions", "CLI history", "Setup"]) {
    const r = page.getByRole("radio", { name });
    expect(await r.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), name).toBe(true);
  }
  expect(await overflow()).toBeLessThanOrEqual(1);
  if (browserName === "chromium") {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.reload();
      await expect(page.getByTestId("coding-permission")).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: join(screens, `web-coding-phone-${theme}.png`) });
    }
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "light" })));
  }
  await allow.click();
  await expect(page.getByTestId("coding-inbox")).toHaveCount(0);
});
