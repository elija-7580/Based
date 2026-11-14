import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor } from "./editor-helpers.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// BSD-290: Bild-Block wie Notion – Einfügen aus der Zwischenablage (Datei), Ablegen einer Datei, Größe per Griff,
// Ausrichtung (links/Mitte/rechts), Caption, Vollbild per Knopf; nach dem Neuladen und offline bleibt alles.
// Importiertes Notion-Bild mit Caption und Breite erscheint gleich.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-image-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 820 } });
    try {
      await use(ctx.pages()[0] ?? (await ctx.newPage()));
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

function png(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
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

/** Kleiner ZIP-Schreiber (gespeichert, ohne Kompression). */
function zip(files: { path: string; data: Uint8Array }[]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (d: Uint8Array) => { let c = 0xffffffff; for (const b of d) c = table[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8"), c = crc(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(c, 14);
    h.writeUInt32LE(f.data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
    local.push(h, name, Buffer.from(f.data));
    const e = Buffer.alloc(46);
    e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0x0800, 8); e.writeUInt32LE(c, 16);
    e.writeUInt32LE(f.data.length, 20); e.writeUInt32LE(f.data.length, 24); e.writeUInt16LE(name.length, 28); e.writeUInt32LE(offset, 42);
    central.push(e, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function notionExportZip(): Buffer {
  const fx = JSON.parse(readFileSync(new URL("../../../fixtures/import/notion-html.utc.json", import.meta.url), "utf8")) as { cases: { input: { files: { path: string; text?: string; base64?: string }[] } }[] };
  return zip(fx.cases[0]!.input.files.map((f) => ({ path: f.path, data: f.base64 !== undefined ? Buffer.from(f.base64, "base64") : Buffer.from(f.text ?? "", "utf8") })));
}

async function fresh(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function openPage(page: Page, title: string) {
  await page.getByRole("treeitem", { name: title }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
}

/** Ein PNG als Datei in die Zwischenablage legen und im fokussierten Editor einfügen (wie ⌘V nach einem Screenshot). */
async function pasteImageFile(page: Page, bytes: Buffer, name = "Screenshot.png") {
  await page.evaluate(({ b64, name }) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([data], name, { type: "image/png" }));
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { b64: bytes.toString("base64"), name });
}

/** Eine Datei wie aus dem Finder auf den Editor ziehen und ablegen. */
async function dropImageFile(page: Page, target: string, bytes: Buffer, name = "photo.png") {
  await page.evaluate(({ b64, name, target }) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([data], name, { type: "image/png" }));
    const el = document.querySelector(target)!;
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + 20, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, dataTransfer: dt };
    el.dispatchEvent(new DragEvent("dragenter", at));
    el.dispatchEvent(new DragEvent("dragover", at));
    el.dispatchEvent(new DragEvent("drop", at));
  }, { b64: bytes.toString("base64"), name, target });
}


test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => fresh(page));

test("Importiertes Notion-Bild erscheint mit Caption und Breite", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await dialog.getByLabel("Choose files to import").setInputFiles({ name: "Export-abc.zip", mimeType: "application/zip", buffer: notionExportZip() });
  await expect(dialog.getByTestId("import-summary")).toContainText("attached file");
  await dialog.getByRole("button", { name: "Done" }).click();
  await openPage(page, "Home");
  const block = blockEditor(page).locator('.bx2-block[data-type="image"]').first();
  await expect(block.getByRole("textbox", { name: "Caption" })).toHaveValue("The diagram");
  await expect(block.locator("img")).toHaveAttribute("src", /^blob:/);
  await expect.poll(async () => Math.round((await block.locator(".bx2-image-frame").boundingBox())!.width)).toBe(320);
});

// BSD-407 Teil 6.3: Bild-Block im Block-Editor wie im alten Editor – Ausrichtung (links/Mitte/rechts, `props.align`),
// Bildleiste (Beschriftung, Ersetzen, Herunterladen, Vollbild), Breite an beiden Rändern ziehen.
const bxImage = (page: Page) => blockEditor(page).locator('.bx2-block[data-type="image"] figure.bx2-image').first();
const bxImg = (page: Page) => bxImage(page).locator("img").first();
const bxTools = (page: Page) => bxImage(page).getByTestId("image-toolbar");

async function focusEnd(page: Page) {
  await blockEditor(page).getByTestId("block-editor-tail").click();
  await expect(blockEditor(page).locator("[data-editable-id]:focus")).toHaveCount(1);
}

test("Bild aus der Zwischenablage: Caption, Mitte, Größe, Vollbild; nach Neuladen und offline bleibt alles", async ({ page, context }) => {
  await command(page, { op: "createPage", title: "Gallery" });
  await command(page, { op: "createPage", title: "Other" });
  await openPage(page, "Gallery");
  await focusEnd(page);
  await pasteImageFile(page, png(320, 180));
  await expect(bxImg(page)).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => bxImg(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);

  // Überfahren → Leiste mit Ausrichtung, Caption, Ersetzen, Herunterladen, Vollbild
  await bxImg(page).hover();
  await expect(bxTools(page)).toBeVisible();
  for (const name of ["Align left", "Align center", "Align right", "Caption", "Replace image", "Download", "View full size"]) {
    await expect(bxTools(page).getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(bxTools(page).getByRole("button", { name: "Align left" })).toHaveAttribute("aria-pressed", "true");
  await bxTools(page).getByRole("button", { name: "Align center" }).click();
  await expect(bxImage(page)).toHaveAttribute("data-align", "center");
  await expect(bxTools(page).getByRole("button", { name: "Align center" })).toHaveAttribute("aria-pressed", "true");
  // mittig heißt: Bild steht in der Mitte der Spalte
  const col = (await bxImage(page).boundingBox())!;
  const pic = (await bxImg(page).boundingBox())!;
  expect(Math.abs(pic.x + pic.width / 2 - (col.x + col.width / 2))).toBeLessThan(4);

  // Caption über die Leiste
  await bxImg(page).hover();
  await bxTools(page).getByRole("button", { name: "Caption" }).click();
  const caption = bxImage(page).getByRole("textbox", { name: "Caption" });
  await expect(caption).toBeFocused();
  await page.keyboard.type("Sunset over the lake");
  await page.keyboard.press("Enter");
  await expect(caption).toHaveValue("Sunset over the lake");

  // Vollbild per Knopf, Esc schließt
  await bxImg(page).hover();
  await bxTools(page).getByRole("button", { name: "View full size" }).click();
  await expect(page.getByTestId("image-viewer")).toBeVisible();
  await expect(page.getByTestId("image-viewer").locator("img")).toHaveAttribute("src", /^blob:/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-viewer")).toHaveCount(0);

  // Größe per Griff (mittig: beide Seiten wandern)
  const frame = bxImage(page).locator(".bx2-image-frame");
  await frame.hover();
  const handle = frame.getByRole("separator", { name: "Resize image", exact: true });
  const before = (await frame.boundingBox())!.width;
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 40, h.y + h.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeLessThan(before - 40);
  const after = Math.round((await frame.boundingBox())!.width);
  // ⌘Z nimmt die Größe in einem Schritt zurück, ⇧⌘Z wieder her
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => Math.round((await frame.boundingBox())!.width)).toBe(Math.round(before));
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => Math.round((await frame.boundingBox())!.width)).toBe(after);

  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await openPage(page, "Gallery");
  await expect(bxImage(page)).toHaveAttribute("data-align", "center");
  await expect(bxImage(page).getByRole("textbox", { name: "Caption" })).toHaveValue("Sunset over the lake");
  await expect.poll(async () => Math.round((await bxImage(page).locator(".bx2-image-frame").boundingBox())!.width)).toBe(after);
  await expect.poll(() => bxImg(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);

  // Offline: Seite wechseln und zurück – das Bild kommt aus dem lokalen Speicher
  await context.setOffline(true);
  try {
    await openPage(page, "Other");
    await openPage(page, "Gallery");
    await expect(bxImg(page)).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => bxImg(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);
  } finally {
    await context.setOffline(false);
  }
});

test("Bilddatei ablegen; Ausrichtung rechts und zurück nach links; Ersetzen und Herunterladen", async ({ page }) => {
  await command(page, { op: "createPage", title: "Drops" });
  await openPage(page, "Drops");
  await focusEnd(page);
  await page.keyboard.type("Above the picture");
  await dropImageFile(page, "[data-testid=block-editor] [data-editable-id]", png(200, 120));
  await expect(bxImg(page)).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => bxImg(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(200);
  await expect(blockEditor(page)).toContainText("Above the picture");

  await bxImg(page).hover();
  await bxTools(page).getByRole("button", { name: "Align right" }).click();
  await expect(bxImage(page)).toHaveAttribute("data-align", "right");
  const col = (await bxImage(page).boundingBox())!;
  const pic = (await bxImg(page).boundingBox())!;
  expect(Math.abs(pic.x + pic.width - (col.x + col.width))).toBeLessThan(4);
  await bxImg(page).hover();
  await bxTools(page).getByRole("button", { name: "Align left" }).click();
  await expect(bxImage(page)).toHaveAttribute("data-align", "left");
  await expect.poll(async () => Math.round((await bxImg(page).boundingBox())!.x - (await bxImage(page).boundingBox())!.x)).toBeLessThan(4);

  // Herunterladen: eine Datei kommt an
  await bxImg(page).hover();
  const download = page.waitForEvent("download");
  await bxTools(page).getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$|^image/);

  // Ersetzen: andere Datei, gleicher Block
  const blockID = await blockEditor(page).locator('.bx2-block[data-type="image"]').first().getAttribute("data-block-id");
  await bxImage(page).getByLabel("Replace image file").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: png(260, 90) });
  await expect.poll(() => bxImg(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(260);
  expect(await blockEditor(page).locator('.bx2-block[data-type="image"]').first().getAttribute("data-block-id")).toBe(blockID);
});

// Bildschirmfotos für docs/design/screens (nur mit BASED_SCREENSHOTS=1, Chromium): Bild mit Leiste (Mitte, Caption) und
// Vollbild, in 1280 × 820, 900 × 600 und 1728 × 1000, hell und dunkel.
test("Bildschirmfotos: Bild-Block mit Leiste und Vollbild", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium");
  const id = (await command(page, { op: "createPage", title: "Trip to the lake" })) as string;
  await openPage(page, "Trip to the lake");
  await focusEnd(page);
  await page.keyboard.type("Photos from the weekend.");
  await page.keyboard.press("Enter");
  await pasteImageFile(page, png(640, 360));
  await expect(bxImg(page)).toHaveAttribute("src", /^blob:/);
  await bxImg(page).hover();
  await bxTools(page).getByRole("button", { name: "Align center" }).click();
  await bxImage(page).getByRole("textbox", { name: "Caption" }).fill("Sunset over the lake");
  await bxImage(page).getByRole("textbox", { name: "Caption" }).press("Enter");
  await page.waitForTimeout(800);
  for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("based.appearance") ?? "{}"), theme: t })), theme);
      await page.goto("/#page-" + id);
      await page.reload();
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await expect(bxImg(page)).toHaveAttribute("src", /^blob:/);
      await bxImg(page).hover();
      await expect(bxTools(page)).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `../../docs/design/screens/web-image-block-${w}x${h}-${theme}.png` });
      await bxTools(page).getByRole("button", { name: "View full size" }).click();
      await expect(page.getByTestId("image-viewer")).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-image-viewer-${w}x${h}-${theme}.png` });
      await page.keyboard.press("Escape");
    }
  }
});
