import { expect, test as base, type Page } from "@playwright/test";
import { blockEditor, expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { overflows, overlaps } from "./layout-checks.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-305: Feinschliff-Durchgang Editor. Eine Seite mit vielen Blocktypen in Ruhe und in den wichtigsten Zuständen
// (leere Seite, Slash-Menü oben/gefiltert/ohne Treffer, Formatleiste, Blockmenü am Griff, Blockauswahl), hell und
// dunkel, 1280 × 820 und 900 × 600. Fotos mit BASED_SCREENSHOTS=1 (Chromium): docs/design/screens/web-editor-polish-*.
// Ohne Fotos prüft der Test die Zustände selbst (jede Fläche erscheint, nichts läuft über das Fenster).

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-polish-"));
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
const editor = (page: Page) => blockEditor(page);

const MD = [
  "# Heading one", "Plain paragraph with **bold**, *italic*, `code` and a [link](https://example.com).",
  "## Heading two", "- Bullet one", "- Bullet two", "1. First", "2. Second", "- [ ] Open task", "- [x] Done task",
  "> A quote that says something worth quoting.", "> [!NOTE] A callout with an icon and some text.",
  "```js\nconst answer = 42;\nconsole.log(answer);\n```", "---",
  "| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |",
  "### Heading three", "Supercalifragilistic".repeat(8) + " long word paragraph.",
].join("\n\n");

async function paste(page: Page, md: string) {
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, md);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test.describe.configure({ timeout: 240_000 });

test("Editor in Ruhe und in seinen Zuständen", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Polish" });
  await command(page, { op: "createPage", title: "Empty" });
  await page.getByRole("treeitem", { name: "Polish" }).click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await paste(page, MD);
  await expect(editor(page).locator('.bx2-block[data-type="code"]').first()).toBeVisible();
  await page.waitForTimeout(800);
  const pageHash = await page.evaluate(() => location.hash);
  const shoot = async (name: string, theme: string, w: number) => {
    await noHorizontalOverflow(page);
    await page.waitForTimeout(350); // Ein- und Ausblenden (--duration) abwarten
    if (SHOTS && browserName === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-editor-polish-${name}-${theme}${w === 1280 ? "" : "-" + w}.png` });
  };
  const firstText = () => editor(page).getByText("Plain paragraph", { exact: false });

  for (const theme of SHOTS && browserName === "chromium" ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    // BSD-407 Teil 3: Block-Editor als Standard, dazu 1728 × 1000 (Checkliste: drei Größen)
    for (const w of [1280, 900, 1728] as const) {
      await page.setViewportSize({ width: w, height: w === 1280 ? 820 : w === 900 ? 600 : 1000 });
      await page.evaluate((h) => { location.hash = h; }, pageHash);
      await expectEditable(page);
      await page.mouse.move(w - 5, 300);
      await page.waitForTimeout(400);
      await shoot("rest", theme, w);
      // Formatleiste über einem markierten Wort
      await firstText().dblclick();
      await expect(page.getByTestId("format-bar")).toBeVisible();
      await shoot("toolbar", theme, w);
      // Slash-Menü: oben, gefiltert, ohne Treffer (vorher Leiste schließen, sonst trifft der Klick die Leiste)
      await page.keyboard.press("Escape");
      await page.mouse.move(w - 5, 300);
      await expect(page.getByTestId("format-bar")).toHaveCount(0);
      await firstText().click({ position: { x: 4, y: 4 } });
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await expect(page.getByTestId("slash-menu")).toBeVisible();
      await shoot("slash", theme, w);
      await page.keyboard.type("hea");
      await page.waitForTimeout(200);
      await shoot("slash-filtered", theme, w);
      // Keine leeren Gruppenüberschriften (BSD-305: doppelte Gruppen ließen sie beim Filtern stehen)
      const empty = await page.getByTestId("slash-menu").evaluate((m) => [...m.querySelectorAll(".bx2-menu-label")].filter((l) => !l.parentElement?.querySelector("[role=option]")).map((c) => c.textContent));
      expect(empty).toEqual([]);
      await page.keyboard.type("zzzz");
      // BSD-305 Teil 3: ohne Treffer bleibt das Menü mit „No results“ stehen (wie Notion), statt zu verschwinden
      await expect(page.getByTestId("slash-menu").getByRole("status")).toHaveText("No results");
      await page.waitForTimeout(200);
      await shoot("slash-empty", theme, w);
      // Zurück: „/heazzzz“ und die leere Zeile wieder weg
      for (let i = 0; i < 9; i++) await page.keyboard.press("Backspace");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(firstText()).toBeVisible();
      // Blockmenü am Griff
      await firstText().hover({ timeout: 5000 });
      const handle = editor(page).locator(".bx2-block", { hasText: "Plain paragraph" }).last().getByTestId("block-handle").first();
      await expect(handle).toBeVisible();
      await handle.click();
      await expect(page.getByTestId("block-menu")).toBeVisible();
      await shoot("block-menu", theme, w);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      // Blockauswahl über mehrere Blöcke
      await firstText().click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      await page.waitForTimeout(300);
      await shoot("block-selection", theme, w);
      await page.keyboard.press("Escape");
      // Leere Seite mit Platzhalter
      await page.getByRole("treeitem", { name: "Empty" }).click();
      await expectEditable(page);
      await focusEditorEnd(page);
      await page.waitForTimeout(300);
      await shoot("empty", theme, w);
    }
  }
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
});

test("Links und Häkchen im Editor ohne Browser-Blau", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Colors" });
  await page.getByRole("treeitem", { name: "Colors" }).click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await paste(page, "A [link](https://example.com) here.\n\n- [x] Done");
  const link = editor(page).locator("a").first();
  await expect(link).toBeVisible();
  // Der Block-Editor rendert den Absatz nach dem Einfügen einmal neu – erst messen, wenn der Link im Dokument hängt
  // (sonst greift evaluate das abgehängte alte <a>). Geprüft wird weiter: Linkfarbe = Textfarbe.
  await expect.poll(() => link.evaluate((a) => {
    const host = a.isConnected ? (a.closest("[data-editable-id]") ?? a.parentElement) : null;
    return host ? getComputedStyle(a).color === getComputedStyle(host).color : "detached";
  })).toBe(true);
  const accent = await editor(page).locator("input[type=checkbox]").first().evaluate((c) => getComputedStyle(c).accentColor);
  const ink = await page.evaluate(() => { const d = document.createElement("div"); d.style.color = "var(--ink)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  expect(accent).toBe(ink);
});

// BSD-323: Blockfarben kommen hell und dunkel aus den Tokens (block-*), nicht aus BlockNotes grellen Dunkelfarben.
test("Blockfarben im Dunkelmodus aus den Tokens", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await command(page, { op: "createPage", title: "Block colors" });
  await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "dark" })));
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("treeitem", { name: "Block colors" }).click();
  await expectEditable(page);
  await focusEditorEnd(page);
  await paste(page, "> [!NOTE] Blue callout\n\n> [!WARNING] Warning callout\n\nAfter");
  // Block-Editor: die Farbe sitzt an der Zeile des Blocks (bx2-color-<farbe>Background), der Callout-Kasten ist durchsichtig
  const callout = editor(page).locator('.bx2-block[data-type="callout"] > .bx2-row').first();
  await expect(callout).toBeVisible();
  const [bg, token, inner] = await callout.evaluate((el) => {
    const color = /bx2-color-(\w+)Background/.exec(el.className)?.[1] ?? "none";
    const probe = document.createElement("div");
    probe.style.background = `var(--block-${color})`;
    document.body.appendChild(probe);
    const t = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(el).backgroundColor, t, getComputedStyle(el.querySelector(".bx2-callout")!).backgroundColor];
  });
  expect(bg).toBe(token);
  expect(inner).toBe("rgba(0, 0, 0, 0)");
  if (SHOTS && browserName === "chromium") await page.screenshot({ path: "../../docs/design/screens/web-editor-polish-block-colors-dark.png" });
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
});

// BSD-305 Teil 3: Slash ohne Treffer – „No results“; Enter schließt das Menü und macht wie sonst eine neue Zeile.
test("Slash ohne Treffer: „No results“, Enter macht eine neue Zeile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const id = await page.evaluate(() => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "Slash empty" }));
  await page.goto(`/#page-${id}`);
  await expectEditable(page);
  await focusEditorEnd(page);
  await page.keyboard.type("/qqqxyz");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("status")).toHaveText("No results");
  await expect(menu.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await page.keyboard.type("next line");
  const fields = blockEditor(page).locator("[data-editable-id]");
  await expect(fields).toHaveText(["/qqqxyz", "next line"]);
});

// BSD-305 Teil 4: Rest-Zustände. Jeder Blocktyp (Swift-Korpus: Gleichung, Bild, Spalten, Bookmark, Embed, Inline-
// Datenbank, Synced Block, Datei, Meeting …) in drei Größen hell und dunkel: nichts läuft über, keine Texte überdecken
// sich; dazu Suche in der Seite mit Treffern und der Link-Dialog. Fotos: web-editor-polish-corpus-*, -find-*, -link-*.
interface Wire { kind: string; data: Record<string, unknown> & { id: string; parent?: string } }
const CORPUS = readFileSync(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Wire);

function corpusBlocks(root = "p-root"): Wire[] {
  const blocks = CORPUS.filter((r) => r.kind === "block");
  const keep = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const b of blocks) {
      const p = b.data.parent ?? "";
      if (!keep.has(b.data.id) && (p === "b:" + root || keep.has(p.slice(2)))) { keep.add(b.data.id); grew = true; }
    }
  }
  return blocks.filter((b) => keep.has(b.data.id));
}

type Seeder = { __based: { client: { openPage(id: string): Promise<{ store: { transact(n: string, f: (tx: { put(r: unknown): void }) => void): void } }> } } };

test("Rest-Zustände: alle Blocktypen, Suche in der Seite, Link-Dialog", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const pid = (await command(page, { op: "createPage", title: "Every block" })) as string;
  await page.evaluate(async ([id, blocks]) => {
    const { store } = await (globalThis as unknown as Seeder).__based.client.openPage(id);
    store.transact("Seed corpus", (tx) => { for (const b of blocks) tx.put({ kind: "block", data: { ...b.data, parent: b.data.parent === "b:p-root" ? "b:" + id : b.data.parent } }); });
  }, [pid, corpusBlocks()] as const);
  const shots = SHOTS && browserName === "chromium";
  const found: string[] = [];
  for (const theme of shots ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.goto("/#page-" + pid);
    await page.reload(); // nur der Hash ändert sich: neu laden, damit das Thema greift
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expectEditable(page);
    // Datei ohne Bytes auf diesem Gerät: Hinweis als leise Zeile unter dem Namen, kein Bild-Kasten daneben
    const file = editor(page).locator('a.bx2-file[data-asset-notice]').first();
    await expect(file).toBeVisible();
    const note = await file.evaluate((el) => { const a = getComputedStyle(el, "::after"); return { border: a.borderTopStyle, minHeight: a.minHeight, h: el.getBoundingClientRect().height }; });
    expect(note.border).toBe("none");
    expect(note.h).toBeLessThan(80);
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.mouse.move(w - 5, h / 2);
      await page.waitForTimeout(500);
      const suffix = `${theme}${w === 1280 ? "" : "-" + w}`;
      // ganze Seite abrollen: jede Bildschirmhöhe einzeln prüfen
      const scroller = page.locator(".panel").first();
      const total = await scroller.evaluate((el) => el.scrollHeight);
      for (let y = 0, i = 0; y < total && i < 12; y += h - 120, i++) {
        await scroller.evaluate((el, top) => { el.scrollTop = top; }, y);
        await page.waitForTimeout(250);
        for (const f of [...(await overflows(page)), ...(await overlaps(page))]) found.push(`${w}×${h} @${y}: ${f}`);
        if (shots && i < 3) await page.screenshot({ path: `../../docs/design/screens/web-editor-polish-corpus-${i}-${suffix}.png` });
      }
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      // Suche in der Seite mit Treffern
      await editor(page).locator("[data-editable-id]").first().click();
      await page.keyboard.press("ControlOrMeta+f");
      await expect(page.getByTestId("find-bar")).toBeVisible();
      await page.keyboard.type("Text");
      await expect(page.getByTestId("find-count")).not.toHaveText("");
      await page.waitForTimeout(300);
      for (const f of [...(await overflows(page)), ...(await overlaps(page))]) found.push(`find ${w}×${h}: ${f}`);
      if (shots) await page.screenshot({ path: `../../docs/design/screens/web-editor-polish-find-${suffix}.png` });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("find-bar")).toHaveCount(0);
      // Link-Dialog über einem markierten Wort
      await editor(page).getByText("Einfacher Text", { exact: true }).first().click();
      await page.keyboard.press("End");
      await page.keyboard.press("Shift+Home");
      await expect(page.getByTestId("format-bar")).toBeVisible();
      await page.getByTestId("format-link").click();
      await expect(page.getByTestId("link-popover")).toBeVisible();
      await page.waitForTimeout(300);
      for (const f of [...(await overflows(page)), ...(await overlaps(page))]) found.push(`link ${w}×${h}: ${f}`);
      if (shots) await page.screenshot({ path: `../../docs/design/screens/web-editor-polish-link-${suffix}.png` });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
  }
  await page.evaluate(() => localStorage.removeItem("based.appearance"));
  expect([...new Set(found)]).toEqual([]);
});

// BSD-447: Video- und Audio-Block mit Based-Bedienung – keine Browser-Steuerleiste (controls) mehr. Abspielen/Pause,
// Zeit, Ton aus, Tastatur auf dem Player (Leertaste, M). Fotos 1280 × 820 hell/dunkel (BASED_SCREENSHOTS=1).
function silentWav(seconds: number): string {
  const n = 8000 * seconds, b = Buffer.alloc(44 + n, 128);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return "data:audio/wav;base64," + b.toString("base64");
}

test("Video und Audio: Based-Leiste statt Browser-Steuerung", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const pid = (await command(page, { op: "createPage", title: "Media" })) as string;
  const src = silentWav(2);
  await page.evaluate(async ([id, url]) => {
    const { store } = await (globalThis as unknown as Seeder).__based.client.openPage(id);
    store.transact("Seed media", (tx) => {
      tx.put({ kind: "block", data: { id: "MEDIA-AUDIO", type: "audio", parent: "b:" + id, sk: "a0", props: { url }, createdAt: 0, updatedAt: 0 } });
      tx.put({ kind: "block", data: { id: "MEDIA-VIDEO", type: "video", parent: "b:" + id, sk: "a1", props: { url }, createdAt: 0, updatedAt: 0 } });
    });
  }, [pid, src] as const);
  for (const theme of SHOTS && browserName === "chromium" ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.goto("/#page-" + pid);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const players = editor(page).getByTestId("media-player");
    await expect(players).toHaveCount(2);
    // keine System-Steuerung
    expect(await editor(page).locator("video[controls], audio[controls]").count()).toBe(0);
    const audio = players.first();
    await expect(audio.getByTestId("media-time")).toHaveText("0:00 / 0:02");
    await expect(players.nth(1).getByRole("button", { name: "Full screen" })).toBeVisible();
    await expect(audio.getByRole("button", { name: "Full screen" })).toHaveCount(0);
    if (SHOTS && browserName === "chromium") {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `../../docs/design/screens/web-editor-media-${theme}.png` });
    }
  }
  const audio = editor(page).getByTestId("media-player").first();
  // Ton aus per Knopf, wieder an per Taste M auf dem Player
  await audio.getByRole("button", { name: "Mute" }).click();
  await expect(audio.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
  await audio.focus();
  await page.keyboard.press("m");
  await expect(audio.getByRole("button", { name: "Mute" })).toBeVisible();
  // Abspielen per Leertaste, Pause per Knopf
  await page.keyboard.press(" ");
  await expect(audio.getByRole("button", { name: "Pause" })).toBeVisible();
  await audio.getByRole("button", { name: "Pause" }).click();
  await expect(audio.getByRole("button", { name: "Play" })).toBeVisible();
});

// BSD-305 Teil 6: Ziehen am Griff – Einfügestrich und Geisterbild mitten im Ziehen ansehen (Checkliste: Zustand
// „wird gezogen“). Strich und Geist nur aus Tokens, der gezogene Block blass; Fotos 1280 × 820 hell/dunkel.
test("Ziehen: Einfügestrich und Geisterbild mitten im Ziehen", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  for (const theme of SHOTS && browserName === "chromium" ? (["light", "dark"] as const) : (["light"] as const)) {
    await page.goto("/");
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const pid = (await command(page, { op: "createPage", title: `Drag ${theme}` })) as string;
    await page.goto("/#page-" + pid);
    await expectEditable(page);
    await focusEditorEnd(page);
    for (const t of ["Alpha", "Beta", "Gamma"]) { await page.keyboard.type(t); await page.keyboard.press("Enter"); }
    await page.keyboard.press("Backspace");
    const blocks = editor(page).locator(".bx2-block");
    const gamma = blocks.nth(2), alpha = blocks.nth(0);
    await gamma.locator(".bx2-row").hover();
    const h = (await gamma.locator(":scope > .bx2-gutter [data-handle]").boundingBox())!;
    const a = (await alpha.locator(".bx2-row").boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 20, h.y + 10, { steps: 4 });
    await page.mouse.move(a.x + 40, a.y + 3, { steps: 8 });
    const drop = page.locator(".bx2-drop");
    await expect(drop).toBeVisible();
    await expect(gamma).toHaveAttribute("data-dragging", "");
    // der Strich liegt über Alpha (davor) und hat die Farbe von --ink-2
    const look = await drop.evaluate((el) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--ink-2)";
      document.body.append(probe);
      const ink2 = getComputedStyle(probe).color;
      probe.remove();
      return { bg: getComputedStyle(el).backgroundColor, ink2, top: el.getBoundingClientRect().top };
    });
    expect(look.bg).toBe(look.ink2);
    expect(Math.abs(look.top - a.y)).toBeLessThan(12);
    if (SHOTS && browserName === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-editor-drag-${theme}.png` });
    await page.mouse.up();
    await expect.poll(() => editor(page).locator("[data-editable-id]").allInnerTexts()).toEqual(["Gamma", "Alpha", "Beta"]);
  }
});
