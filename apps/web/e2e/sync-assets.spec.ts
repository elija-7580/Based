import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

// BSD-78: Bilder über den Server-Sync. Startet den TS-based-server als Prozess (apps/server), verbindet zwei
// Browser-Kontexte („Geräte“) damit: Bild auf A einfügen → auf B sichtbar, Bytes identisch. Ein drittes Gerät,
// das die Datei nicht laden kann, zeigt den Platzhalter.

const webPort = Number(process.env.BASED_E2E_PORT ?? 4173);
const serverPort = 10_000 + webPort;
const serverURL = `http://127.0.0.1:${serverPort}`;
const TOKEN = "e2e-assets-token-0123456789";
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));
const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));

/** Ein gültiges PNG (Farbverlauf), ohne Datei im Repo. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (1 + width * 3) + 1 + x * 3;
      raw[i] = 90 + Math.round((120 * x) / width);
      raw[i + 1] = 110 + Math.round((90 * y) / height);
      raw[i + 2] = 150;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let server: ChildProcess;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "based-e2e-assets-"));
  server = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--db", join(dataDir, "based.sqlite"), "--port", String(serverPort), "--host", "127.0.0.1", "--public-url", `http://localhost:${webPort}`], {
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
});

async function deviceOn(browser: Browser, baseURL: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  return page;
}

async function connect(page: Page, opts: { dark?: boolean } = {}) {
  await page.getByRole("button", { name: "Settings" }).click();
  if (opts.dark) await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Sync & server" }).click();
  await page.getByLabel("Server URL").fill(serverURL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", { timeout: 20_000 });
}

test("Bild auf Gerät A → auf Gerät B sichtbar, Bytes identisch; Platzhalter, wenn die Datei nicht ladbar ist", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const image = png(320, 180);
  const hash = createHash("sha256").update(image).digest("hex");

  // Gerät A: verbinden, Seite anlegen, Bild einfügen.
  const a = await deviceOn(browser, baseURL!);
  await connect(a);
  const header = a.locator(".tree-header", { hasText: "Private" });
  await header.hover();
  await a.getByRole("button", { name: "New page in Private" }).click();
  await a.getByLabel("Page title").fill("Photos");
  await expect(a.getByRole("treeitem", { name: "Photos" })).toBeVisible();
  const editor = a.locator(".bn-editor[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  await a.keyboard.type("/image");
  await a.keyboard.press("Enter");
  await a.locator("input[type='file']").setInputFiles({ name: "gradient.png", mimeType: "image/png", buffer: image });
  const imgA = a.locator(".shell-editor img.bn-visual-media");
  await expect(imgA).toHaveAttribute("src", /^blob:/);

  // Der Server hat die Datei unter ihrem Hash; ohne Token gibt es sie nicht.
  await expect.poll(async () => (await fetch(`${serverURL}/sync/v2/asset/${hash}`, { method: "HEAD", headers: { Authorization: `Bearer ${TOKEN}` } })).status, { timeout: 20_000 }).toBe(200);
  expect((await fetch(`${serverURL}/sync/v2/asset/${hash}`)).status).toBe(401);
  const stored = Buffer.from(await (await fetch(`${serverURL}/sync/v2/asset/${hash}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).arrayBuffer());
  expect(stored.equals(image)).toBe(true);
  await expect(a.getByTestId("sync-assets")).toHaveCount(0);

  // Gerät B: verbinden, Seite öffnen, Bild erscheint; Bytes wie auf A.
  const b = await deviceOn(browser, baseURL!);
  await connect(b);
  await b.getByRole("treeitem", { name: "Photos" }).click();
  const imgB = b.locator(".shell-editor img.bn-visual-media");
  await expect(imgB).toHaveAttribute("src", /^blob:/, { timeout: 20_000 });
  await expect.poll(() => imgB.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);
  const hashB = await imgB.evaluate(async (el: HTMLImageElement) => {
    const bytes = await (await fetch(el.src)).arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
  });
  expect(hashB).toBe(hash);
  await b.screenshot({ path: join(screens, "web-sync-assets-light.png") });

  // Gerät C (dunkel): Records kommen an, die Datei nicht (Asset-Routen blockiert) → Platzhalter mit Hinweis;
  // sobald sie erreichbar ist, erscheint das Bild ohne Neuladen.
  const c = await deviceOn(browser, baseURL!);
  await c.route("**/sync/v2/asset/**", (route) => route.abort());
  await connect(c, { dark: true });
  await c.getByRole("treeitem", { name: "Photos" }).click();
  const imgC = c.locator(".shell-editor img.bn-visual-media");
  await expect(imgC).toHaveAttribute("data-asset-state", "offline", { timeout: 20_000 });
  await expect(imgC).toHaveAttribute("alt", /loads when the sync server is reachable/);
  await expect(c.locator(`.shell-editor [data-url="based-asset:${hash}"]`)).toHaveAttribute("data-asset-notice", /loads when the sync server is reachable/);
  await expect(c.locator(`.shell-editor [data-url="based-asset:${hash}"]`)).toHaveCount(1);
  expect(await imgC.getAttribute("src")).toBeNull();
  await c.screenshot({ path: join(screens, "web-sync-assets-placeholder-dark.png") });
  await c.unroute("**/sync/v2/asset/**");
  await expect(imgC).toHaveAttribute("src", /^blob:/, { timeout: 30_000 });
  await expect(c.locator(`.shell-editor [data-url="based-asset:${hash}"]`)).not.toHaveAttribute("data-asset-notice", /.*/);
  await c.screenshot({ path: join(screens, "web-sync-assets-dark.png") });

  for (const p of [a, b, c]) await p.context().close();
});
