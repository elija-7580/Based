import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-300: Klick-Durchlauf. Jeder Screen wird geöffnet, alles Bedienbare darauf nacheinander angeklickt. Nach jedem
// Klick muss sich etwas tun (DOM, Adresse, Fokus woanders hin, Download, Dateiwahl, Rückfrage, neues Fenster) –
// sonst ist es ein toter Knopf. Während des ganzen Laufs: kein console.error, kein unbehandelter Fehler.
// Maßstab: docs/quality/checklist.md, Abschnitt 5.

const test = base.extend<{ page: Page }>({
  page: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "based-crawl-"));
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

/**
 * Nicht anklicken, mit Grund: endgültig Löschendes und Zerstörendes (verändert den Workspace für alle folgenden
 * Klicks), nach außen Gehendes (Links ins Netz, Konto, Updates), App-Steuerung.
 */
const SKIP: { re: RegExp; why: string }[] = [
  { re: /delete|remove|empty trash|discard|clear|reset|erase/i, why: "löscht oder setzt zurück" },
  { re: /sign (in|out)|log ?out|connect|disconnect|subscribe|upgrade|buy/i, why: "Konto oder Kauf, nach außen" },
  { re: /check for updates|install|restart|quit|relaunch/i, why: "App-Steuerung" },
  { re: /move to trash|trash page/i, why: "verschiebt die gerade geprüfte Seite" },
];

const CLICKABLE = 'button, [role=button], [role=tab], [role=menuitem], [role=switch], [role=radio], [role=checkbox], a[href], summary';

interface Target { name: string; nth: number }

/** Sichtbare, bedienbare Elemente im Bereich, als Name + laufende Nummer (übersteht neues Zeichnen). */
async function targets(page: Page, scope: string): Promise<Target[]> {
  return page.evaluate(([scope, sel]) => {
    const root = document.querySelector(scope);
    if (!root) return [];
    const seen = new Map<string, number>();
    const out: { name: string; nth: number }[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || el.closest("[inert], [aria-hidden=true]")) continue;
      if (el.closest(".bn-editor")) continue; // Editor-Inhalt prüfen die Editor-Tests
      if (el instanceof HTMLAnchorElement && /^https?:/.test(el.getAttribute("href") ?? "")) continue; // nach außen
      // Schon gewählt (Tab, Umschalter, aktuelle Seite): ein Klick darf nichts tun.
      if (["aria-selected", "aria-pressed", "aria-checked"].some((a) => el.getAttribute(a) === "true") || (el.closest("[aria-current]")?.getAttribute("aria-current") ?? "false") !== "false" || getComputedStyle(el).visibility === "hidden") continue;
      const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const n = seen.get(name) ?? 0;
      seen.set(name, n + 1);
      out.push({ name, nth: n });
    }
    return out;
  }, [scope, CLICKABLE] as const);
}

/** Klickt ein Element und meldet, ob sich etwas getan hat. */
async function probe(page: Page, scope: string, t: Target): Promise<"ok" | "dead" | "missing"> {
  const found = await page.evaluate(([scope, sel, t]) => {
    document.querySelector("[data-crawl-target]")?.removeAttribute("data-crawl-target");
    const root = document.querySelector(scope);
    if (!root) return false;
    let n = 0;
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || el.closest("[inert], [aria-hidden=true]")) continue;
      if (el.closest(".bn-editor")) continue;
      if (el instanceof HTMLAnchorElement && /^https?:/.test(el.getAttribute("href") ?? "")) continue;
      if (["aria-selected", "aria-pressed", "aria-checked"].some((a) => el.getAttribute(a) === "true") || (el.closest("[aria-current]")?.getAttribute("aria-current") ?? "false") !== "false" || getComputedStyle(el).visibility === "hidden") continue;
      const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (name !== t.name) continue;
      if (n++ === t.nth) {
        el.setAttribute("data-crawl-target", "");
        return true;
      }
    }
    return false;
  }, [scope, CLICKABLE, t] as const);
  if (!found) return "missing";
  const target = page.locator("[data-crawl-target]");
  let events = 0;
  const count = () => { events += 1; };
  page.on("download", count);
  page.on("filechooser", count);
  page.on("popup", count);
  page.on("dialog", count);
  try {
    await target.hover({ timeout: 500 }).catch(() => undefined);
    // Unruhe ohne Klick (Tooltips, Uhren, Sync-Punkt) messen und danach nicht mitzählen.
    await page.evaluate(() => {
      const w = window as unknown as { __crawl?: { noise: Set<Node>; hits: number; obs?: MutationObserver; href: string; focus: Element | null } };
      const state = { noise: new Set<Node>(), hits: 0, href: location.href, focus: document.activeElement, obs: undefined as MutationObserver | undefined };
      w.__crawl = state;
      let learning = true;
      state.obs = new MutationObserver((ms) => {
        for (const m of ms) {
          if (m.type === "attributes" && m.attributeName === "data-crawl-target") continue;
          if (learning) state.noise.add(m.target);
          else if (!state.noise.has(m.target)) state.hits += 1;
        }
      });
      state.obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      setTimeout(() => { learning = false; }, 200);
    });
    await page.waitForTimeout(220);
    await page.evaluate(() => {
      const s = (window as unknown as { __crawl: { focus: Element | null; href: string } }).__crawl;
      s.focus = document.activeElement;
      s.href = location.href;
    });
    // Unter Last kann ein beim Überfahren eingeblendeter Knopf noch animieren („stable“): dann einmal direkt klicken.
    await target.click({ timeout: 1000, noWaitAfter: true })
      .catch(() => target.click({ timeout: 1000, noWaitAfter: true, force: true }))
      .catch((e: Error) => { if (process.env.CRAWL_DEBUG) console.log("click failed:", String(e).split("\n").slice(0, 12).join(" | ")); });
    await page.waitForTimeout(250);
    const changed = await page.evaluate(() => {
      const s = (window as unknown as { __crawl: { hits: number; obs: MutationObserver; href: string; focus: Element | null } }).__crawl;
      s.obs.disconnect();
      const t = document.querySelector("[data-crawl-target]");
      const focusMoved = document.activeElement !== s.focus && document.activeElement !== t && document.activeElement !== document.body;
      return s.hits > 0 || location.href !== s.href || focusMoved;
    });
    return changed || events > 0 ? "ok" : "dead";
  } finally {
    page.off("download", count);
    page.off("filechooser", count);
    page.off("popup", count);
    page.off("dialog", count);
  }
}

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

async function goHash(page: Page, hash: string) {
  const moved = await page.evaluate((h) => {
    if (location.hash === h) return false;
    location.hash = h;
    return true;
  }, hash);
  if (moved) await page.waitForTimeout(250);
}

/** Zurück in den Ausgangszustand: Offenes schließen, Screen wieder öffnen. */
async function reset(page: Page, hash: string) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  // Zeiger weg vom linken Rand (dort zeigt sich die ausgeblendete Seitenleiste schwebend) und von Tooltips.
  await page.mouse.move(700, 780);
  await goHash(page, hash);
  // „Hide sidebar“ gehört zum Durchlauf – danach wieder einblenden.
  const show = page.getByTestId("sidebar-show");
  if (await show.isVisible().catch(() => false)) await show.click();
}

async function crawl(page: Page, screen: { name: string; hash: string; scope: string; limit?: number }, dead: string[], skipped: string[]) {
  await reset(page, screen.hash);
  const list = await targets(page, screen.scope);
  let clicked = 0;
  for (const t of list) {
    if (clicked >= (screen.limit ?? 25)) break;
    const skip = SKIP.find((s) => s.re.test(t.name));
    if (skip) {
      skipped.push(`${screen.name}: „${t.name}“ (${skip.why})`);
      continue;
    }
    const t0 = Date.now();
    const r = await probe(page, screen.scope, t);
    clicked += 1;
    if (process.env.CRAWL_DEBUG) console.log(screen.name, JSON.stringify(t.name), r, Date.now() - t0, "ms");
    if (r === "dead") dead.push(`${screen.name}: „${t.name || "(ohne Namen)"}“ #${t.nth}`);
    await reset(page, screen.hash);
  }
  return clicked;
}

test.describe.configure({ timeout: 240_000 });

test("Klick-Durchlauf: jeder Screen, kein toter Knopf, keine Konsolenfehler", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    errors.push(`console: ${m.text()}`);
    if (process.env.CRAWL_DEBUG) console.log("CONSOLE ERROR", m.text().slice(0, 80));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.dismiss().catch(() => undefined));

  await page.goto("/");
  await ready(page);
  const pageID = (await command(page, { op: "createPage", title: "Crawl page" })) as string;
  await command(page, { op: "createDatabase", title: "Crawl database" });
  await expect(page.getByRole("treeitem", { name: "Crawl database" })).toBeVisible();
  await page.getByRole("treeitem", { name: "Crawl database" }).click();
  await page.waitForTimeout(500);
  const dbHash = await page.evaluate(() => location.hash);

  const main = "main.main";
  const screens = [
    { name: "Home", hash: "#home", scope: main, limit: 15 },
    { name: "Seitenleiste", hash: "#home", scope: "nav.sidebar", limit: 20 },
    { name: "Seite", hash: "#page-" + pageID, scope: main, limit: 15 },
    { name: "Datenbank", hash: dbHash, scope: main, limit: 20 },
    { name: "Library", hash: "#library", scope: main, limit: 10 },
    { name: "Trash", hash: "#trash", scope: main, limit: 8 },
    { name: "Chat", hash: "#chat", scope: main, limit: 8 },
    // Navigation der Einstellungen einmal, danach nur der Inhalt jeder Unterseite.
    { name: "Settings", hash: "#prefs-my-settings", scope: main, limit: 25 },
    ...["workspace", "language", "import", "sync", "updates", "diagnostics", "agents", "about", "account"].map((p) => ({ name: "Settings " + p, hash: "#prefs-" + p, scope: "[data-testid=settings-page]", limit: 8 })),
  ];
  const dead: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const s of screens) total += await crawl(page, s, dead, skipped);

  info.annotations.push({ type: "crawl", description: JSON.stringify({ clicked: total, skipped: skipped.length }) });
  console.log(`[${info.project.name}] Klick-Durchlauf: ${total} Klicks, ${skipped.length} ausgelassen`);
  expect(total).toBeGreaterThan(60);
  expect(dead, "tote Knöpfe").toEqual([]);
  expect(errors, "Konsolenfehler").toEqual([]);
});

test("Start in einem frischen Profil ohne Konsolenfehler (OPFS-Pool nur einmal je Worker)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await ready(page);
  await command(page, { op: "createPage", title: "Persisted" });
  await page.waitForTimeout(800);
  await page.reload();
  await ready(page);
  await expect(page.getByRole("treeitem", { name: "Persisted" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test("Ein eingeschleuster toter Knopf fällt auf", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await goHash(page, "#home");
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.textContent = "Crawl dead probe";
    document.querySelector("main.main")!.prepend(b);
    const live = document.createElement("button");
    live.textContent = "Crawl live probe";
    live.onclick = () => { live.textContent = "Crawl live probe ✓"; };
    document.querySelector("main.main")!.prepend(live);
  });
  expect(await probe(page, "main.main", { name: "Crawl dead probe", nth: 0 })).toBe("dead");
  expect(await probe(page, "main.main", { name: "Crawl live probe", nth: 0 })).toBe("ok");
});

// Fotos der in BSD-300 geänderten Screens (Home ohne „Attach“, Chat mit „New chat“ aus, Diagnose-Kopieren), hell
// und dunkel in drei Größen: nur mit BASED_SCREENSHOTS=1 in Chromium.
test("Fotos: Home, Chat, Diagnose", async ({ page, browserName }) => {
  test.skip(process.env.BASED_SCREENSHOTS !== "1" || browserName !== "chromium", "nur für Fotos");
  await page.goto("/");
  await ready(page);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.reload();
    await ready(page);
    for (const [name, hash] of [["home", "#home"], ["chat-empty", "#chat"], ["settings-diagnostics", "#prefs-diagnostics"]] as const) {
      await goHash(page, hash);
      if (name === "settings-diagnostics") await page.getByRole("button", { name: "Copy diagnostics" }).click();
      for (const [w, h, suffix] of [[1280, 820, ""], [900, 600, "-900"], [1728, 1000, "-1728"]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.mouse.move(w - 10, h - 10);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `../../docs/design/screens/web-crawl-${name}-${theme}${suffix}.png` });
      }
    }
  }
});
