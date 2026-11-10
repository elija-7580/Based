import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BSD-220 Teil 3: Echtzeit-Text (Beta). Zwei Browser-Kontexte („Geräte“) am TS-based-server, beide mit
// „Real-time text (beta)“: Text erscheint live auf dem anderen Gerät, Inhalt steht nirgends doppelt – auch nicht auf
// dem Gerät, das die Seite vorher ohne Echtzeit-Text (lokal gefüllter Y-Stand) bearbeitet hat.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-collab-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));

async function startServer(port: number): Promise<{ proc: ChildProcess; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "based-e2e-collab-"));
  const proc = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dir, "based.sqlite"), "--port", String(port), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
    cwd: serverDir,
    env: { ...process.env, BASED_TOKEN: TOKEN, BASED_LOG_LEVEL: "warning" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { proc, dir };
    } catch {
      // startet noch
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("based-server did not start");
}

async function deviceOn(browser: Browser, baseURL: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  return page;
}

async function connect(page: Page, serverURL: string) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 20_000 });
  const live = page.getByRole("switch", { name: /Real-time text/ });
  await live.click();
  await expect(live).toBeChecked();
}

test("Echtzeit-Text: zwei Geräte schreiben in denselben Absatz, live und ohne Doppelungen", async ({ browser, baseURL, browserName }) => {
  test.setTimeout(150_000);
  const port = 20_000 + webPort + 400 + (browserName === "webkit" ? 100 : 0);
  const serverURL = `http://127.0.0.1:${port}`;
  const { proc, dir } = await startServer(port);
  try {
    // Gerät A: Seite anlegen und schreiben (der Server kennt sie noch nicht: erst ohne /collab).
    const a = await deviceOn(browser, baseURL!);
    await connect(a, serverURL);
    const header = a.locator(".tree-header", { hasText: "Private" });
    await header.hover();
    await a.getByRole("button", { name: "New page in Private" }).click();
    await a.getByLabel("Page title").fill("Live");
    const editorA = a.locator(".bn-editor[contenteditable='true']");
    await expect(editorA).toBeVisible();
    await editorA.click();
    await a.keyboard.type("Hallo");
    await expect(editorA).toContainText("Hallo");
    await expect.poll(async () => {
      const r = await fetch(`${serverURL}/sync/v2/pull?after=0&limit=500`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      return JSON.stringify(await r.json()).includes("Hallo");
    }, { timeout: 20_000 }).toBe(true);

    // Gerät B öffnet die Seite mit Echtzeit-Text.
    const b = await deviceOn(browser, baseURL!);
    await connect(b, serverURL);
    await b.getByRole("treeitem", { name: "Live" }).click();
    await expect(b.locator(".bx-doc[data-collab]")).toBeVisible({ timeout: 20_000 });
    const editorB = b.locator(".bn-editor[contenteditable='true']");
    await expect(editorB).toContainText("Hallo");

    // A öffnet die Seite neu: jetzt mit /collab; der lokal gefüllte Y-Stand wird verworfen (nichts doppelt).
    await a.getByRole("button", { name: "Home" }).click();
    await a.getByRole("treeitem", { name: "Live" }).click();
    await expect(a.locator(".bx-doc[data-collab]")).toBeVisible({ timeout: 20_000 });
    await expect(editorA.getByText("Hallo")).toHaveCount(1);

    // Live in beide Richtungen, im selben Absatz.
    await editorA.getByText("Hallo").click();
    await a.keyboard.press("End");
    await a.keyboard.type(" von A");
    await expect(editorB).toContainText("Hallo von A", { timeout: 10_000 });
    await editorB.getByText("Hallo von A").click();
    await b.keyboard.press("End");
    await b.keyboard.type(" und B");
    await expect(editorA).toContainText("Hallo von A und B", { timeout: 10_000 });
    await expect(editorA.getByText("Hallo von A und B")).toHaveCount(1);
    await expect(editorB.getByText("Hallo von A und B")).toHaveCount(1);

    // Der Server hat die Records (für Sync v2 / Swift) aus dem Y.Doc geschrieben.
    await expect.poll(async () => {
      const r = await fetch(`${serverURL}/sync/v2/pull?after=0&limit=500`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      return JSON.stringify(await r.json()).includes("Hallo von A und B");
    }, { timeout: 20_000 }).toBe(true);
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
