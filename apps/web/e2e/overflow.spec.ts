import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-301: Überlauf mit Extremdaten. Nirgendwo läuft Text aus seinem Kasten oder aus dem Fenster, gekürzter Text
// endet auf „…“, die Seite hat keinen waagrechten Rollbalken – leerer Workspace und Extrem-Workspace (Titel mit 150
// Zeichen, ein Wort mit 200 Zeichen, tiefe Verschachtelung, lange Namen), in 1280 × 820, 900 × 600 und 1728 × 1000.
// Maßstab: docs/quality/checklist.md, Abschnitt 2. Fotos mit BASED_SCREENSHOTS=1 (Chromium): web-overflow-*.png

const SHOTS = process.env.BASED_SCREENSHOTS === "1";

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-overflow-"));
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

const VIEWPORTS = [[1280, 820, ""], [900, 600, "-900"], [1728, 1000, "-1728"]] as const;

/**
 * Sucht Überläufe. Ein Fund: Element mit eigenem Text, dessen Inhalt breiter ist als sein Kasten, ohne dass das
 * gewollt ist (scrollender Bereich oder „…“), oder das aus dem Fenster ragt; dazu ein waagrechter Rollbalken der Seite.
 */
async function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth + 1) out.push(`Seite: waagrechter Rollbalken (${de.scrollWidth} > ${innerWidth})`);
    const label = (el: Element) => {
      const cls = typeof el.className === "string" && el.className ? "." + el.className.split(/\s+/).filter((c) => !/^x[0-9a-z]{5,8}$/.test(c)).slice(0, 2).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls} „${(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}“`;
    };
    /** Liegt das Element in einem Bereich, der absichtlich waagrecht rollt (Tabelle, Code, Tabs)? */
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth) return true;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      if (el.closest(".sr-only, [aria-hidden=true], script, style, svg, [hidden]")) continue;
      // Titel-Felder (Seite, Zeile): langer Titel muss umbrechen, nicht im Feld verschwinden.
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && /title/i.test(el.getAttribute("aria-label") ?? "") && el.value !== "") {
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push(`Titel-Feld schneidet ab: ${label(el)} „${el.value.slice(0, 40)}“`);
        continue;
      }
      const ecs = getComputedStyle(el);
      // Zeile ohne Umbruch, die abschneidet, ohne „…“ (Breadcrumb, Kopfzeilen)
      if (ecs.whiteSpace === "nowrap" && (ecs.overflowX === "hidden" || ecs.overflowX === "clip") && ecs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1 && (el.textContent ?? "").trim() !== "" && el.getBoundingClientRect().width > 1 && !inScroller(el)) {
        const kids = [...el.children].filter((k) => (k as HTMLElement).getBoundingClientRect().right > el.getBoundingClientRect().right + 1);
        if (kids.some((k) => getComputedStyle(k).textOverflow !== "ellipsis")) out.push(`Zeile schneidet ab ohne „…“: ${label(el)}`);
      }
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // auch „visually hidden“ (1 × 1 px, z. B. Astryx-Feldlabels)
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.opacity === "0" || cs.clipPath !== "none" || (cs.clip !== "auto" && cs.clip !== "")) continue;
      if (inScroller(el)) continue;
      // Mit „…“ gekürzt, aber auf fast nichts (weniger als drei Zeichen Platz)
      if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth < parseFloat(cs.fontSize) * 2) out.push(`auf fast nichts gekürzt: ${label(el)} (${el.clientWidth} px)`);
      // Toleranz 4 px: WebKit zählt das Leerzeichen am Zeilenende umbrochener Zeilen mit (unsichtbar).
      if (el.scrollWidth > el.clientWidth + 4 && cs.display !== "inline") {
        const clipped = cs.overflowX === "hidden" || cs.overflowX === "clip";
        if (!clipped) out.push(`läuft aus dem Kasten: ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`);
        else if (cs.textOverflow !== "ellipsis") out.push(`abgeschnitten ohne „…“: ${label(el)}`);
      }
      if (r.right > innerWidth + 1 || r.left < -1) {
        // Abgeschnitten durch einen Vorfahren (Menü am Rand, Seitenleiste eingefahren)? Dann ist es nicht sichtbar.
        let clippedBy = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const pc = getComputedStyle(p);
          if (pc.overflowX !== "visible" && p.getBoundingClientRect().right <= innerWidth + 1) { clippedBy = true; break; }
        }
        if (!clippedBy) out.push(`ragt aus dem Fenster: ${label(el)} (${Math.round(r.left)}…${Math.round(r.right)} von ${innerWidth})`);
      }
    }
    return [...new Set(out)];
  });
}

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function go(page: Page, hash: string) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(400);
}

async function check(page: Page, screens: { name: string; hash: string }[], shotPrefix: string, browserName: string) {
  const found: string[] = [];
  for (const [w, h, suffix] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    for (const s of screens) {
      await go(page, s.hash);
      await page.mouse.move(w / 2, h - 5);
      await page.waitForTimeout(200);
      for (const f of await overflows(page)) found.push(`${s.name} ${w}×${h}: ${f}`);
      if (SHOTS && browserName === "chromium") await page.screenshot({ path: `../../docs/design/screens/web-overflow-${shotPrefix}-${s.name}-light${suffix}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  if (SHOTS && browserName === "chromium") {
    // Dunkel wie über Settings → Appearance (gespeichert, neu geladen); Überlauf hängt nicht am Thema, die Fotos schon.
    await page.evaluate(() => localStorage.setItem("based.appearance", JSON.stringify({ theme: "dark" })));
    await page.reload();
    await ready(page);
    for (const s of screens) {
      await go(page, s.hash);
      await page.mouse.move(640, 815);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `../../docs/design/screens/web-overflow-${shotPrefix}-${s.name}-dark.png` });
    }
    await page.evaluate(() => localStorage.removeItem("based.appearance"));
  }
  return found;
}

test.describe.configure({ timeout: 180_000 });

test("Leerer Workspace: nichts läuft über", async ({ page, browserName }) => {
  await page.goto("/");
  await ready(page);
  const found = await check(page, [
    { name: "home", hash: "#home" }, { name: "library", hash: "#library" }, { name: "trash", hash: "#trash" },
    { name: "chat", hash: "#chat" }, { name: "settings", hash: "#prefs-my-settings" },
  ], "empty", browserName);
  expect(found).toEqual([]);
});

const LONG_TITLE = "A very long page title that keeps going on and on to test truncation in every place it appears, sidebar tabs breadcrumb";
const TITLE_150 = (LONG_TITLE + " and more words until one hundred fifty characters are reached").slice(0, 150);
const LONG_WORD = "Supercalifragilistic".repeat(10); // 200 Zeichen ohne Leerzeichen

test("Extrem-Workspace: lange Titel, langes Wort, tiefe Verschachtelung", async ({ page, browserName }) => {
  await page.goto("/");
  await ready(page);
  const long = (await command(page, { op: "createPage", title: TITLE_150 })) as string;
  let parent = long;
  for (let i = 1; i <= 10; i++) parent = (await command(page, { op: "createPage", title: `Level ${i} ${LONG_TITLE}`, parent })) as string;
  await page.getByRole("treeitem", { name: TITLE_150 }).click();
  const ed = page.locator(".bx-editor > .bx-doc .bn-editor").first();
  await expect(ed).toHaveAttribute("contenteditable", "true");
  await ed.locator(".bn-block-content").first().click();
  await page.keyboard.type(`Word: ${LONG_WORD} end.`);
  await page.waitForTimeout(600);
  const found = await check(page, [
    { name: "page", hash: "#page-" + long }, { name: "deep", hash: "#page-" + parent }, { name: "home", hash: "#home" }, { name: "library", hash: "#library" },
  ], "extreme", browserName);
  expect(found).toEqual([]);
});
