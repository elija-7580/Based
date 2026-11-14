import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor } from "./editor-helpers.js";
import { useLegacyEditor } from "./legacy-editor.js";
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
const editor = (page: Page) => page.locator(".bx-editor > .bx-doc .bn-editor").first();

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

const imageBlock = (page: Page) => editor(page).locator("[data-content-type=image]").first();
const imageEl = (page: Page) => imageBlock(page).locator("img").first();

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

// BSD-407 Teil 3: Ausrichtung (links/Mitte/rechts), Bildleiste und Vollbild-Knopf hat bisher nur der alte Editor; Einfügen, Ablegen, Breite, Caption und Doppelklick-Vollbild hat der Block-Editor (block-editor.spec.ts, switch-parity.spec.ts).
// Gepinnt auf den alten Editor (docs/editor-parity.md, „noch BlockNote“; Liste für Teil 4).
test.describe("alter Editor (BlockNote)", () => {
  useLegacyEditor(test);

  test("Bild aus der Zwischenablage: Caption, Mitte, Größe, Vollbild; nach Neuladen und offline bleibt alles", async ({ page, context }) => {
    await command(page, { op: "createPage", title: "Gallery" });
    await command(page, { op: "createPage", title: "Other" });
    await openPage(page, "Gallery");
    const ed = editor(page);
    await expect(ed).toHaveAttribute("contenteditable", "true");
    await ed.locator(".bn-block-content").first().click();
    await pasteImageFile(page, png(320, 180));
    await expect(imageEl(page)).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => imageEl(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);

    // Bild anklicken → Leiste mit Caption, Ausrichtung, Vollbild
    await imageEl(page).click();
    const toolbar = page.locator(".bn-formatting-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator("[data-test=alignTextCenter]")).toBeVisible();
    // Feinschliff: kein „Ask AI“ über einem Bild, Markierung ohne das Blau von BlockNote
    await expect(toolbar.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
    const ring = await imageBlock(page).evaluate((el) => {
      const inner = el.firstElementChild!;
      const after = getComputedStyle(inner, "::after");
      return { shadow: after.boxShadow, bg: after.backgroundColor };
    });
    expect(ring.shadow).not.toContain("100, 160, 255");
    expect(ring.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await toolbar.locator("[data-test=alignTextCenter]").click();
    await expect(imageBlock(page)).toHaveAttribute("data-text-alignment", "center");
    // mittig heißt: Bild steht in der Mitte der Spalte
    const col = (await imageBlock(page).boundingBox())!;
    const pic = (await imageEl(page).boundingBox())!;
    expect(Math.abs(pic.x + pic.width / 2 - (col.x + col.width / 2))).toBeLessThan(4);

    const capInput = page.getByPlaceholder("Edit caption");
    // WebKit unter Last: die Leiste baut sich nach dem Klick (und wenn der Upload fertig wird) neu auf – dann den
    // ganzen Schritt wiederholen, bis die Caption steht.
    await expect(async () => {
      await imageEl(page).click();
      await toolbar.getByRole("button", { name: "Edit caption" }).click({ timeout: 3000 });
      await capInput.fill("Sunset over the lake", { timeout: 2000 });
      await capInput.press("Enter", { timeout: 2000 });
      await expect(imageBlock(page).locator(".bn-file-caption")).toHaveText("Sunset over the lake", { timeout: 2000 });
    }).toPass({ timeout: 40_000 });
    await expect(imageBlock(page).locator(".bn-file-caption")).toHaveText("Sunset over the lake");

    // Vollbild per Knopf in der Leiste, Esc schließt und gibt den Fokus zurück
    await imageEl(page).click();
    await toolbar.getByRole("button", { name: "View full size" }).click();
    await expect(page.getByTestId("image-viewer")).toBeVisible();
    await expect(page.getByTestId("image-viewer").locator("img")).toHaveAttribute("src", /^blob:/);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("image-viewer")).toHaveCount(0);

    // Größe per Griff
    const wrapper = imageBlock(page).locator(".bn-visual-media-wrapper").first();
    await wrapper.hover();
    const handle = wrapper.locator(".bn-resize-handle").last();
    await expect(handle).toBeVisible();
    const before = (await wrapper.boundingBox())!.width;
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 - 80, h.y + h.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await wrapper.boundingBox())!.width).toBeLessThan(before - 40);
    const after = Math.round((await wrapper.boundingBox())!.width);

    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await openPage(page, "Gallery");
    await expect(imageBlock(page)).toHaveAttribute("data-text-alignment", "center");
    await expect(imageBlock(page).locator(".bn-file-caption")).toHaveText("Sunset over the lake");
    await expect.poll(async () => Math.round((await imageBlock(page).locator(".bn-visual-media-wrapper").boundingBox())!.width)).toBe(after);
    await expect.poll(() => imageEl(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);

    // Offline: Seite wechseln und zurück – das Bild kommt aus dem lokalen Speicher
    await context.setOffline(true);
    try {
      await openPage(page, "Other");
      await openPage(page, "Gallery");
      await expect(imageEl(page)).toHaveAttribute("src", /^blob:/);
      await expect.poll(() => imageEl(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);
      await expect(imageBlock(page).locator(".bn-file-caption")).toHaveText("Sunset over the lake");
    } finally {
      await context.setOffline(false);
    }
  });

  test("Bilddatei auf den Editor ablegen fügt ein Bild ein; Ausrichtung rechts und zurück nach links", async ({ page }) => {
    await command(page, { op: "createPage", title: "Drops" });
    await openPage(page, "Drops");
    const ed = editor(page);
    await expect(ed).toHaveAttribute("contenteditable", "true");
    await ed.locator(".bn-block-content").first().click();
    await page.keyboard.type("Above the picture");
    await dropImageFile(page, ".bx-editor > .bx-doc .bn-editor .bn-block-content", png(200, 120));
    await expect(imageEl(page)).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => imageEl(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(200);
    await expect(ed).toContainText("Above the picture");

    await imageEl(page).click();
    const toolbar = page.locator(".bn-formatting-toolbar");
    await toolbar.locator("[data-test=alignTextRight]").click();
    await expect(imageBlock(page)).toHaveAttribute("data-text-alignment", "right");
    const col = (await imageBlock(page).boundingBox())!;
    const pic = (await imageEl(page).boundingBox())!;
    expect(Math.abs(pic.x + pic.width - (col.x + col.width))).toBeLessThan(4);
    await imageEl(page).click();
    await toolbar.locator("[data-test=alignTextLeft]").click();
    // links ist die Vorgabe (BlockNote lässt das Attribut dann weg)
    await expect(imageBlock(page)).not.toHaveAttribute("data-text-alignment", "right");
    await expect.poll(async () => Math.round((await imageEl(page).boundingBox())!.x - (await imageBlock(page).boundingBox())!.x)).toBeLessThan(4);

    // In einem Textblock zeigt die Leiste keine Ausrichtung (Based richtet Text nicht aus).
    await ed.getByText("Above the picture").dblclick();
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator("[data-test^=alignText]")).toHaveCount(0);
  });

  // Bildschirmfotos für docs/design/screens (nur mit BASED_SCREENSHOTS=1, Chromium): markiertes Bild mit Leiste
  // (Mitte, Caption) und Vollbild, in 1280 × 820, 900 × 600 und 1728 × 1000, hell und dunkel.
  test("Bildschirmfotos: Bild-Block mit Leiste und Vollbild", async ({ page, browserName }) => {
    test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium");
    const id = (await command(page, { op: "createPage", title: "Trip to the lake" })) as string;
    await openPage(page, "Trip to the lake");
    const ed = editor(page);
    await ed.locator(".bn-block-content").first().click();
    await page.keyboard.type("Photos from the weekend.");
    await page.keyboard.press("Enter");
    await pasteImageFile(page, png(640, 360));
    await expect(imageEl(page)).toHaveAttribute("src", /^blob:/);
    await imageEl(page).click();
    await page.locator(".bn-formatting-toolbar [data-test=alignTextCenter]").click();
    await imageEl(page).click();
    await page.locator(".bn-formatting-toolbar").getByRole("button", { name: "Edit caption" }).click();
    await page.getByPlaceholder("Edit caption").fill("Sunset over the lake");
    await page.getByPlaceholder("Edit caption").press("Enter");
    await page.waitForTimeout(800);
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("based.appearance") ?? "{}"), theme: t })), theme);
        await page.goto("/#page-" + id);
        await page.reload();
        await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
        await expect(imageEl(page)).toHaveAttribute("src", /^blob:/);
        await imageEl(page).click();
        await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `../../docs/design/screens/web-image-block-${w}x${h}-${theme}.png` });
        await page.locator(".bn-formatting-toolbar").getByRole("button", { name: "View full size" }).click();
        await expect(page.getByTestId("image-viewer")).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `../../docs/design/screens/web-image-viewer-${w}x${h}-${theme}.png` });
        await page.keyboard.press("Escape");
      }
    }
  });
});
