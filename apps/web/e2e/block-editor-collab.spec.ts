import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ADR 0016 (E7): Echtzeit-Text im neuen Block-Editor. Zwei Browser-Kontexte („Geräte“) am TS-based-server mit
// „Real-time text (beta)“ und dem neuen Editor: Text erscheint live auf dem anderen Gerät (Dokument `text:<seite>`,
// ein Y.Text je Block), nichts doppelt, der Server schreibt die Records, und man sieht, wo der andere schreibt.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const TOKEN = "e2e-collab-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));

async function startServer(port: number): Promise<{ proc: ChildProcess; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "based-e2e-collab2-"));
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
  await ctx.addInitScript(() => localStorage.setItem("based.newEditor", "true"));
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
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
  const live = page.getByRole("switch", { name: /Real-time text/ });
  await live.click();
  await expect(live).toBeChecked();
}

const pulled = async (serverURL: string, text: string) => {
  const r = await fetch(`${serverURL}/sync/v2/pull?after=0&limit=500`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return JSON.stringify(await r.json()).includes(text);
};

test("Neuer Editor, Echtzeit: zwei Geräte im selben Block, live, nichts doppelt, Schreibmarke des anderen", async ({ browser, baseURL, browserName }) => {
  test.setTimeout(150_000);
  const port = 20_000 + webPort + 600 + (browserName === "webkit" ? 100 : 0);
  const serverURL = `http://127.0.0.1:${port}`;
  const { proc, dir } = await startServer(port);
  try {
    const a = await deviceOn(browser, baseURL!);
    await connect(a, serverURL);
    const header = a.locator(".tree-header", { hasText: "Private" });
    await header.hover();
    await a.getByRole("button", { name: "New page in Private" }).click();
    await a.getByLabel("Page title").fill("Live2");
    const editorA = a.getByTestId("block-editor");
    await editorA.getByTestId("block-editor-tail").click();
    await a.keyboard.type("Hallo");
    await expect.poll(() => pulled(serverURL, "Hallo"), { timeout: 20_000 }).toBe(true);

    const b = await deviceOn(browser, baseURL!);
    await connect(b, serverURL);
    await b.getByRole("treeitem", { name: "Live2" }).click();
    const editorB = b.getByTestId("block-editor");
    await expect(editorB).toHaveAttribute("data-collab", "", { timeout: 20_000 });
    await expect(editorB.locator("[data-editable-id]").first()).toHaveText("Hallo");

    // A öffnet die Seite neu (jetzt mit /collab).
    await a.getByRole("button", { name: "Home" }).click();
    await a.getByRole("treeitem", { name: "Live2" }).click();
    await expect(editorA).toHaveAttribute("data-collab", "", { timeout: 20_000 });
    const fieldA = editorA.locator("[data-editable-id]").first();
    const fieldB = editorB.locator("[data-editable-id]").first();

    await fieldA.click();
    await a.keyboard.press("End");
    await a.keyboard.type(" von A");
    await expect(fieldB).toHaveText("Hallo von A", { timeout: 10_000 });
    await fieldB.click();
    await b.keyboard.press("End");
    await b.keyboard.type(" und B");
    await expect(fieldA).toHaveText("Hallo von A und B", { timeout: 10_000 });
    await expect(editorA.locator("[data-editable-id]")).toHaveCount(1);
    await expect(editorB.locator("[data-editable-id]")).toHaveCount(1);

    // A sieht, wo B schreibt (und umgekehrt).
    await expect(editorA.locator(".bx2-peer")).toHaveCount(1, { timeout: 10_000 });
    await expect(editorA.locator(".bx2-peer-name")).toBeVisible();
    if (browserName === "chromium") {
      for (const theme of ["light", "dark"] as const) {
        await a.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await a.mouse.move(0, 0);
        await a.screenshot({ path: `../../docs/design/screens/web-block-editor-presence-1280x800-${theme}.png` });
      }
      await a.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    }

    // Gleichzeitig: A schreibt vorne, B hinten – beide Änderungen bleiben, A's Schreibmarke bleibt an ihrer Stelle.
    await fieldA.click();
    await a.keyboard.press("Home");
    await Promise.all([a.keyboard.type(">> "), b.keyboard.type(" <<")]);
    await expect(fieldA).toHaveText(">> Hallo von A und B <<", { timeout: 10_000 });
    await expect(fieldB).toHaveText(">> Hallo von A und B <<", { timeout: 10_000 });
    await a.keyboard.type("!");
    await expect(fieldA).toHaveText(">> !Hallo von A und B <<", { timeout: 10_000 });

    await expect.poll(() => pulled(serverURL, ">> !Hallo von A und B <<"), { timeout: 20_000 }).toBe(true);
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
