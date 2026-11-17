import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-302 Teil 1: Zustands-Galerie. Jeder Based-Baustein im Design-Kit (Settings → Diagnostics → Design kit) und die
// häufigsten Bedienelemente der Shell werden in Ruhe, Überfahren, gedrückt, Tastaturfokus und deaktiviert angesehen.
// Jede Farbe, die dabei sichtbar wird (Hintergrund, Schrift, Rand, Fokusring, Schatten), muss ein Token-Wert sein –
// kein fremdes Blau aus einer Bibliothek; ein Token darf mit eigener Deckkraft vorkommen (Überfahren = Tinte 6 %).
// Teil 2: neue Beta-Bausteine (Media-Player, Willkommens-Karten). Teil 3: erzwungene Zustände und Bildvergleich (unten).

type State = "rest" | "hover" | "pressed" | "focus" | "disabled";

/** Alle Farben, die die Tokens (Based und das Astryx-Theme) auf :root ergeben, als berechnete rgb()/rgba(). */
async function tokenColors(page: Page): Promise<Set<string>> {
  return new Set(await page.evaluate(() => {
    const names = new Set<string>();
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list: CSSRuleList) => {
        for (const r of list) {
          if (r instanceof CSSStyleRule) for (const p of r.style) if (p.startsWith("--")) names.add(p);
          if ("cssRules" in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
        }
      };
      walk(rules);
    }
    const probe = document.createElement("span");
    document.body.append(probe);
    const out: string[] = [];
    const rootStyle = getComputedStyle(document.documentElement);
    const add = (value: string) => {
      probe.style.color = "";
      probe.style.color = value;
      if (probe.style.color) out.push(getComputedStyle(probe).color);
    };
    for (const n of names) {
      add(`var(${n})`);
      // Zusammengesetzte Tokens (Schatten, Verläufe): jede Farbe darin zählt auch
      for (const c of rootStyle.getPropertyValue(n).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|color\([^)]*\)/g) ?? []) add(c);
    }
    probe.remove();
    return out;
  }));
}

/**
 * Sichtbare Farben eines Bausteins in seinem jetzigen Zustand: das Element, seine Nachfahren und deren ::before/::after
 * (Astryx legt Überfahren/Gedrückt als eigene Ebene an), bei Eingabefeldern dazu der Rahmen um das Feld.
 */
function colorsOf(loc: Locator): Promise<Record<string, string>> {
  return loc.evaluate((root) => {
    const COLOR_RE = /rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)/g;
    const out: Record<string, string> = {};
    const els: Element[] = [root, ...root.querySelectorAll("*")];
    // Eingabefeld: der Rahmen liegt ein paar Ebenen höher; Token: die Pille ist das Elternelement des Knopfs.
    const up = root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement ? 3 : 1;
    for (let p = root.parentElement, i = 0; p && i < up; p = p.parentElement, i++) els.push(p);
    els.forEach((el, n) => {
      for (const pseudo of [null, "::before", "::after"] as const) {
        const cs = getComputedStyle(el, pseudo);
        if (pseudo && (cs.content === "none" || cs.content === "normal")) continue;
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
        const tag = `${n}${pseudo ?? ""}`;
        out[`${tag} background`] = cs.backgroundColor;
        // Überfahren/Gedrückt legt Astryx als Verlauf über den Hintergrund
        (cs.backgroundImage.match(COLOR_RE) ?? []).forEach((c, i) => { out[`${tag} layer${i}`] = c; });
        if (n === 0 || el.childNodes.length) out[`${tag} text`] = cs.color;
        for (const side of ["top", "right", "bottom", "left"] as const) {
          if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0 && cs.getPropertyValue(`border-${side}-style`) !== "none") out[`${tag} border-${side}`] = cs.getPropertyValue(`border-${side}-color`);
        }
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) out[`${tag} outline`] = cs.outlineColor;
        const shadows = cs.boxShadow === "none" ? [] : cs.boxShadow.match(COLOR_RE) ?? [];
        shadows.forEach((s, i) => { out[`${tag} shadow${i}`] = s; });
      }
    });
    return out;
  });
}

/** Farbe → „r,g,b“ und Deckkraft (rgb(), rgba(), color(srgb …)); ein Token darf mit eigener Deckkraft vorkommen. */
function parse(c: string): { rgb: string; alpha: number } | undefined {
  let m = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c);
  if (m) return { rgb: [m[1], m[2], m[3]].map((v) => Math.round(Number(v))).join(","), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(c);
  if (m) return { rgb: [m[1], m[2], m[3]].map((v) => Math.round(Number(v) * 255)).join(","), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  m = /^oklab\(\s*([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.e]+))?\)$/.exec(c);
  if (m) {
    // OKLab → lineares sRGB → sRGB (WebKit liefert Zwischenstände von Übergängen so)
    const [L, A, B] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s];
    const srgb = lin.map((v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))));
    return { rgb: srgb.join(","), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  }
  return undefined;
}
const transparent = (c: string) => c === "transparent" || parse(c)?.alpha === 0;
/** Gehört die Farbe zu einem Token (gleiche Farbe, Deckkraft egal)? Rundung ±1 je Kanal. */
function isToken(c: string, allowed: Set<string>): boolean {
  const p = parse(c);
  if (!p) return false;
  const [r, g, b] = p.rgb.split(",").map(Number) as [number, number, number];
  for (const a of allowed) {
    const q = parse(a);
    if (!q) continue;
    const [r2, g2, b2] = q.rgb.split(",").map(Number) as [number, number, number];
    if (Math.abs(r - r2) <= 1 && Math.abs(g - g2) <= 1 && Math.abs(b - b2) <= 1) return true;
  }
  return false;
}

async function setState(page: Page, loc: Locator, state: State) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (state === "hover") await loc.hover();
  if (state === "pressed") { await loc.hover(); await page.mouse.down(); }
  if (state === "focus") {
    await loc.focus();
    // Tastaturfokus (:focus-visible): einmal weg und mit der Tastatur zurück
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
  }
  await settle(loc);
}

/**
 * Warten, bis die Übergänge des Bausteins (und seiner Rahmen-Eltern) fertig sind – statt fest 220 ms je Zustand.
 * BSD-302 Teil 3: Die feste Pause lag bei ~50 Zuständen allein bei 11 s; unter Last kamen je Zustand mehrere langsame
 * Protokoll-Runden dazu, und die Galerie lief in WebKit in die 30-s-Grenze. Ohne Übergang (Ruhe, deaktiviert) geht es
 * jetzt sofort weiter; Endlos-Animationen zählen nicht, nach 1 s geht es auf jeden Fall weiter.
 */
async function settle(loc: Locator) {
  await loc.evaluate(async (root) => {
    // zwei Frames: erst danach hat der Browser die Übergänge des neuen Zustands angelegt
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const els: Element[] = [root];
    for (let p = root.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) els.push(p);
    const running = els.flatMap((el) => el.getAnimations({ subtree: el === root })).filter((a) => a.effect?.getTiming().iterations !== Infinity);
    await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
  });
}

/** Gedrückt lösen, ohne zu klicken: erst wegfahren, dann loslassen (sonst öffnet z. B. „Search“ Quick Find). */
async function release(page: Page, state: State) {
  if (state === "pressed") { await page.mouse.move(1, 1); await page.mouse.up(); }
}

interface Item { name: string; loc: (p: Page) => Locator; states: State[] }

const KIT: Item[] = [
  { name: "Button primary", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Ask", exact: true }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Button secondary", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Export…" }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Button ghost", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Cancel", exact: true }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Button danger", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Delete", exact: true }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Button disabled", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Disabled" }), states: ["disabled"] },
  { name: "Icon button", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Close", exact: true }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Toggle icon button", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Add to Favorites" }), states: ["rest", "hover", "focus"] },
  { name: "Field", loc: (p) => p.getByTestId("astryx-kit").getByLabel("Page name").first(), states: ["rest", "hover", "focus"] },
  { name: "Field error", loc: (p) => p.getByTestId("astryx-kit").getByLabel("Server URL"), states: ["rest", "hover", "focus"] },
  { name: "Field disabled", loc: (p) => p.getByTestId("astryx-kit").getByLabel("Token"), states: ["disabled"] },
  { name: "Tab", loc: (p) => p.getByTestId("astryx-kit").getByRole("tab", { name: "Summary" }), states: ["rest", "hover", "focus"] },
  { name: "Tab selected", loc: (p) => p.getByTestId("astryx-kit").getByRole("tab", { name: "Notes" }), states: ["rest", "hover"] },
  { name: "Token", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: /Ada/ }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Token disabled", loc: (p) => p.getByTestId("astryx-kit").getByText("0:00", { exact: true }), states: ["disabled"] },
  { name: "Chip", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "In this page" }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Chip pressed", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Title only" }), states: ["rest", "hover"] },
  { name: "Chip disabled", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Shared only" }), states: ["disabled"] },
  { name: "Menu trigger", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Page menu" }), states: ["rest", "hover", "focus"] },
];

// Zwei Hälften je Theme (Knöpfe | Felder, Tabs, Token, Pillen, Menü): jede bleibt auch unter Last weit unter 30 s.
const KIT_PARTS = [
  { part: "Knöpfe", items: KIT.filter((it) => /button/i.test(it.name)) },
  { part: "Felder, Tabs, Pillen", items: KIT.filter((it) => !/button/i.test(it.name)) },
];

for (const theme of ["light", "dark"] as const) for (const { part, items } of KIT_PARTS) {
  test(`Zustands-Galerie: Farben der Zustände sind Tokens – ${part} (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#prefs-kit");
    await expect(page.getByTestId("astryx-kit")).toBeVisible();
    const allowed = await tokenColors(page);
    const found: string[] = [];
    for (const it of items) {
      const loc = it.loc(page);
      await expect(loc, it.name).toBeVisible();
      for (const st of it.states) {
        await setState(page, loc, st);
        const colors = await colorsOf(loc);
        await release(page, st);
        for (const [k, c] of Object.entries(colors)) if (!transparent(c) && !isToken(c, allowed)) found.push(`${it.name} ${st} ${k}: ${c}`);
      }
    }
    expect(found).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  // Häufigste Bedienelemente der Shell und des Editors: Seitenleiste, Home-Kopf, Slash-Menü, Quick Find.
  test(`Zustands-Galerie: Shell und Editor nutzen nur Token-Farben (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    const allowed = await tokenColors(page);
    const found: string[] = [];
    const look = async (name: string, loc: Locator, states: State[]) => {
      await expect(loc, name).toBeVisible();
      for (const st of states) {
        await setState(page, loc, st);
        const colors = await colorsOf(loc);
        await release(page, st);
        for (const [k, c] of Object.entries(colors)) if (!transparent(c) && !isToken(c, allowed)) found.push(`${name} ${st} ${k}: ${c}`);
      }
    };
    const nav = page.getByRole("navigation", { name: "Workspace" });
    await look("Seitenleiste: Nav-Eintrag", nav.getByRole("button", { name: "Search" }).first(), ["rest", "hover", "pressed", "focus"]);
    await look("Seitenleiste: Nav-Eintrag aktiv", nav.getByRole("button", { name: "Home" }).first(), ["rest", "hover"]);
    await look("Seitenleiste: Baumzeile", nav.locator(".tree-row[role=treeitem]").first(), ["rest", "hover", "focus"]);
    await look("Home: Segmentwahl", page.getByRole("radio", { name: "Week" }).or(page.getByRole("tab", { name: "Week" })).or(page.getByRole("button", { name: "Week" })).first(), ["rest", "hover", "focus"]);
    await look("Home: Knopf", page.getByRole("button", { name: "New page" }).first(), ["rest", "hover", "pressed", "focus"]);

    // Slash-Menü: ausgewählte Zeile und überfahrene Zeile (11.11.: Überfahren war Bibliotheks-Blau)
    await page.getByRole("button", { name: "New page" }).first().click();
    await expectEditable(page);
    await focusEditorEnd(page);
    await page.keyboard.type("/");
    const slash = page.getByRole("option");
    await expect(slash.first()).toBeVisible();
    await look("Slash-Menü: Zeile ausgewählt", slash.first(), ["rest"]);
    const second = slash.nth(1);
    await second.hover();
    await settle(second);
    for (const [k, c] of Object.entries(await colorsOf(second))) if (!transparent(c) && !isToken(c, allowed)) found.push(`Slash-Menü: Zeile überfahren ${k}: ${c}`);
    await page.keyboard.press("Escape");

    // Quick Find: ausgewählte Zeile
    await page.keyboard.press("ControlOrMeta+k");
    const qf = page.getByRole("dialog", { name: "Quick Find" });
    await expect(qf).toBeVisible();
    const sel = qf.locator('[role="option"][aria-selected="true"]').first();
    await expect(sel).toBeVisible();
    for (const [k, c] of Object.entries(await colorsOf(sel))) if (!transparent(c) && !isToken(c, allowed)) found.push(`Quick Find: Zeile ausgewählt ${k}: ${c}`);
    await page.keyboard.press("Escape");
    expect(found).toEqual([]);
  });
}

// BSD-302 Teil 2 (Beta-Umfang): die neuen Bausteine der Beta – Media-Player (BSD-447) im Kit und die Karten des
// Willkommensbildschirms mit den Startvorlagen (BSD-436) – in allen Zuständen nur mit Token-Farben. Eigener Test,
// damit die große Kit-Galerie unter Last nicht an ihre Zeitgrenze kommt.
for (const theme of ["light", "dark"] as const) {
  test(`Zustands-Galerie: Media-Player und Willkommens-Karten nutzen nur Token-Farben (${theme})`, async ({ playwright, browserName, baseURL }) => {
    const dir = mkdtempSync(join(tmpdir(), "based-kit-"));
    const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL!, viewport: { width: 1280, height: 900 } });
    try {
      await ctx.addInitScript((t) => {
        (globalThis as { __basedWelcome?: boolean }).__basedWelcome = true;
        localStorage.setItem("based.appearance", JSON.stringify({ theme: t }));
      }, theme);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto("/");
      await expect(page.getByTestId("welcome")).toBeVisible();
      const allowed = await tokenColors(page);
      const found: string[] = [];
      const look = async (name: string, loc: Locator, states: State[]) => {
        await expect(loc, name).toBeVisible();
        for (const st of states) {
          await setState(page, loc, st);
          const colors = await colorsOf(loc);
          await release(page, st);
          for (const [k, c] of Object.entries(colors)) if (!transparent(c) && !isToken(c, allowed)) found.push(`${name} ${st} ${k}: ${c}`);
        }
      };
      const welcome = page.getByTestId("welcome");
      await look("Willkommen: Karte", welcome.getByRole("button", { name: /Start empty/ }), ["rest", "hover", "pressed", "focus"]);
      await look("Willkommen: Vorlage", welcome.getByRole("button", { name: "Journal", exact: true }), ["rest", "hover", "pressed", "focus"]);

      await page.goto("/#prefs-kit");
      const media = page.getByTestId("kit-media");
      await look("Media-Player", media, ["rest", "focus"]);
      await look("Media: Abspielen", media.getByRole("button", { name: "Play" }), ["rest", "hover", "pressed", "focus"]);
      await look("Media: Ton", media.getByRole("button", { name: "Mute" }), ["rest", "hover", "focus"]);
      await look("Media: Position", media.getByRole("slider", { name: "Position" }), ["rest", "hover", "focus"]);
      await media.getByRole("button", { name: "Mute" }).click();
      await look("Media: Ton aus (gedrückt)", media.getByRole("button", { name: "Unmute" }), ["rest", "hover"]);
      if (browserName === "chromium") await media.screenshot({ path: `../../docs/design/screens/web-kit-media-${theme}.png` });
      expect(found).toEqual([]);
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// BSD-302 Teil 3: erzwungene Zustände und Bildvergleich. Astryx kennt Zustände nur als Pseudoklassen (:hover, :active,
// :focus-visible) – ein Attribut müsste jede Regel doppeln. Deshalb baut der Test eine Zustands-Matrix aus Kopien der
// Kit-Bausteine; jede Zelle trägt ihren Zustand als Attribut (data-force), und Chromium erzwingt die Pseudoklassen per
// DevTools-Protokoll (CSS.forcePseudoState). So stehen alle Zustände gleichzeitig still auf einem Bild – ohne Maus,
// ohne Übergänge, also stabil. Hell und dunkel, Default und Bold; jede Farbe in jeder Zelle muss ein Token sein.
// Bildvergleich nur Chromium unter Linux (Grundbilder für ubuntu-24.04 wie in der CI). Die Systemschrift ist je Rechner
// verschieden; die Matrix nutzt deshalb die gebündelte Schibsted Grotesk (aus dist/assets) – verglichen werden Farben, Formen, Abstände.
// Gewollte Änderung: `playwright test e2e/kit-states.spec.ts --project=chromium --update-snapshots`, Bild im selben
// Commit ablegen und im Ergebnisfeld begründen.
const FORCE: Record<State, string[]> = { rest: [], hover: ["hover"], pressed: ["hover", "active"], focus: ["focus", "focus-visible"], disabled: [] };
const MATRIX_STATES: State[] = ["rest", "hover", "pressed", "focus", "disabled"];

/**
 * BSD-302 Teil 4: offene Flächen (Menü, Popover, Dialog). Jede wird im Kit wirklich geöffnet, als Kopie in eine
 * zweite, vorerst versteckte Galerie gelegt und wieder geschlossen. Das Menü dreimal: in Ruhe, mit überfahrener und
 * mit per Tastatur fokussierter Zeile (erzwungen in buildMatrix).
 */
const OVERLAYS = ["Menu", "Menu item hover", "Menu item focus", "Popover", "Dialog"] as const;

async function captureOverlays(page: Page) {
  const kit = page.getByTestId("astryx-kit");
  await page.evaluate(() => {
    const grid = document.createElement("section");
    grid.className = "kit-overlays";
    grid.setAttribute("data-testid", "kit-overlays");
    grid.hidden = true;
    document.body.append(grid);
  });
  const keep = async (surface: Locator, names: readonly string[]) => {
    await expect(surface).toBeVisible();
    await settle(surface);
    await surface.evaluate((el, list) => {
      const grid = document.querySelector(".kit-overlays")!;
      for (const name of list) {
        const figure = document.createElement("span");
        figure.className = "kit-overlay-cell";
        const caption = document.createElement("span");
        caption.className = "kit-matrix-head";
        caption.textContent = name;
        const copy = el.cloneNode(true) as Element;
        copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        copy.setAttribute("data-overlay", name);
        // Breite kam vom Positionierer um die Fläche – mitnehmen
        (copy as HTMLElement).style.width = `${Math.round(el.getBoundingClientRect().width)}px`;
        figure.append(caption, copy);
        grid.append(figure);
      }
    }, names);
    await page.keyboard.press("Escape");
    await expect(surface).toBeHidden();
  };
  await kit.getByRole("button", { name: "Page menu" }).click();
  await keep(page.locator(".astryx-popover:not([data-overlay])").filter({ has: page.getByRole("menu") }), OVERLAYS.slice(0, 3));
  await kit.getByRole("button", { name: "Popover", exact: true }).click();
  await keep(page.locator(".astryx-popover[role=dialog]:not([data-overlay])").filter({ hasText: "The marker means one thing" }), ["Popover"]);
  await kit.getByRole("button", { name: "Open dialog" }).click();
  await keep(page.locator("dialog.astryx-dialog[open]:not([data-overlay])"), ["Dialog"]);
}

async function buildMatrix(page: Page) {
  // Quelle je Zeile: der Baustein selbst, bei Feld und Token die sichtbare Hülle drumherum
  const sources: { name: string; states: State[]; index: number }[] = [];
  for (const [index, it] of KIT.entries()) {
    const loc = it.loc(page);
    await expect(loc, it.name).toBeVisible();
    await loc.evaluate((el, i) => {
      const host = el.closest(".astryx-field") ?? el.closest(".astryx-token") ?? el;
      host.setAttribute("data-matrix-src", String(i));
    }, index);
    sources.push({ name: it.name, states: it.states, index });
  }
  // Schrift: die gebündelte Schibsted Grotesk direkt aus dem Build (Default lädt sie sonst nicht)
  const faces = readdirSync("dist/assets").flatMap((f) => {
    const m = /^schibsted-grotesk-latin-(\d00)-normal-.*\.woff2$/.exec(f);
    return m ? [`@font-face { font-family: KitMatrix; font-weight: ${m[1]}; src: url(/assets/${f}) format("woff2"); }`] : [];
  });
  expect(faces.length, "Schibsted Grotesk im Build").toBeGreaterThan(0);
  await page.addStyleTag({ content: `${faces.join("\n")}
    .kit-matrix { position: absolute; inset: 0 auto auto 0; z-index: 2147483647; width: max-content; display: grid;
      grid-template-columns: max-content repeat(5, max-content); gap: 12px 20px; align-items: center;
      padding: 20px; background: var(--bg); color: var(--ink); }
    .kit-matrix, .kit-matrix * { font-family: KitMatrix, sans-serif !important; }
    .kit-matrix .kit-matrix-head { color: var(--muted); }
    .kit-matrix .astryx-field { width: 180px; }
    .kit-overlays { position: absolute; inset: 0 auto auto 0; z-index: 2147483647; width: 1240px; display: flex; flex-wrap: wrap;
      align-items: flex-start; gap: 24px; padding: 20px; background: var(--bg); color: var(--ink); }
    .kit-overlays[hidden] { display: none; }
    .kit-overlays, .kit-overlays * { font-family: KitMatrix, sans-serif !important; }
    .kit-overlays .kit-matrix-head { color: var(--muted); }
    .kit-overlay-cell { display: flex; flex-direction: column; gap: 8px; }
    .kit-overlays [data-overlay] { position: static !important; inset: auto !important; margin: 0 !important; transform: none !important;
      translate: none !important; scale: none !important; opacity: 1 !important; animation: none !important; }
  ` });
  await page.evaluate(async () => { await Promise.all(["400", "500", "600", "700"].map((w) => document.fonts.load(`${w} 14px KitMatrix`))); await document.fonts.ready; });
  await page.getByTestId("astryx-kit").evaluate((kit, { rows, states }) => {
    const grid = document.createElement("section");
    grid.className = "kit-matrix";
    grid.setAttribute("data-testid", "kit-matrix");
    const cell = (text = "") => { const c = document.createElement("span"); c.className = "kit-matrix-head"; c.textContent = text; grid.append(c); return c; };
    cell();
    for (const st of states) cell(st);
    for (const row of rows) {
      cell(row.name);
      const src = kit.querySelector(`[data-matrix-src="${row.index}"]`)!;
      for (const st of states) {
        const own = row.states.includes(st);
        const holder = document.createElement("span");
        if (own) {
          const copy = src.cloneNode(true) as Element;
          copy.removeAttribute("data-matrix-src");
          copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
          copy.setAttribute("data-force", st);
          copy.setAttribute("data-row", row.name);
          holder.append(copy);
        }
        grid.append(holder);
      }
    }
    document.body.append(grid);
    // ganze Pixel, sonst schaut am Rand eine Pixelzeile der Seite darunter ins Bild
    grid.style.height = `${Math.ceil(grid.getBoundingClientRect().height)}px`;
  }, { rows: sources, states: MATRIX_STATES });

  // Zustände erzwingen: Überfahren/gedrückt auf der Kopie und allem darin (wie ein Zeiger über dem innersten Teil),
  // Fokus auf dem fokussierbaren Element, :focus-within auf seinen Hüllen.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const ids = async (sel: string) => (await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: sel })).nodeIds;
  const force = async (nodeIds: number[], classes: string[]) => { for (const nodeId of nodeIds) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: classes }); };
  for (const st of ["hover", "pressed"] as const) {
    await force(await ids(`[data-force=${st}], [data-force=${st}] *`), FORCE[st]);
  }
  const focusable = "button, input, textarea, [tabindex]";
  await force(await ids(`[data-force=focus]:is(${focusable}), [data-force=focus] :is(${focusable})`), FORCE.focus);
  await force(await ids(`[data-force=focus]:not(${focusable}), [data-force=focus] :not(${focusable}):has(:is(${focusable}))`), ["focus-within"]);
  const items = async (overlay: string) => ids(`[data-overlay="${overlay}"] [role=menuitem]`);
  // Astryx-Menüs führen den Fokus mit dem Zeiger (Roving Focus): überfahren = :hover + :focus
  await force([(await items("Menu item hover"))[1]!], ["hover", "focus"]);
  await force([(await items("Menu item focus"))[1]!], FORCE.focus);
  await page.mouse.move(1, 1);
  return { matrix: page.getByTestId("kit-matrix"), overlays: page.getByTestId("kit-overlays"), cdp };
}

for (const theme of ["light", "dark"] as const) for (const style of ["default", "bold"] as const) {
  test(`Zustands-Galerie: erzwungene Zustände im Bildvergleich (${style}, ${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium" || process.platform !== "linux", "Bildvergleich nur Chromium unter Linux (Grundbilder wie in der CI)");
    await page.addInitScript(({ t, s }) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t, style: s })), { t: theme, s: style });
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/#prefs-kit");
    await expect(page.getByTestId("astryx-kit")).toBeVisible();
    if (style === "bold") await expect(page.locator("html")).toHaveAttribute("data-style", "bold");
    else await expect(page.locator("html")).not.toHaveAttribute("data-style", "bold");
    const allowed = await tokenColors(page);
    await captureOverlays(page);
    const { matrix, overlays } = await buildMatrix(page);
    await expect(matrix).toBeVisible();

    // Jede Farbe jeder erzwungenen Zelle ist ein Token – auch in Bold
    const found: string[] = [];
    for (const copy of await matrix.locator("[data-force]").all()) {
      const label = `${await copy.getAttribute("data-row")} ${await copy.getAttribute("data-force")}`;
      for (const [k, c] of Object.entries(await colorsOf(copy))) if (!transparent(c) && !isToken(c, allowed)) found.push(`${label} ${k}: ${c}`);
    }
    expect(found).toEqual([]);

    // Das Erzwingen wirkt: Überfahren und Fokus sehen anders aus als Ruhe
    const shot = (st: State) => matrix.locator(`[data-row="Button ghost"][data-force=${st}]`).screenshot({ animations: "disabled" });
    const rest = await shot("rest");
    expect(rest.equals(await shot("hover")), "Überfahren erzwungen").toBe(false);
    expect(rest.equals(await shot("focus")), "Fokus erzwungen").toBe(false);

    await expect(matrix).toHaveScreenshot(`kit-states-${style}-${theme}.png`, { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.01 });
    if (style === "default") await matrix.screenshot({ path: `../../docs/design/screens/web-kit-states-${theme}.png`, animations: "disabled" });

    // Teil 4: offene Flächen – Menü (Ruhe, Zeile überfahren, Zeile fokussiert), Popover, Dialog
    await page.evaluate(() => {
      document.querySelector(".kit-matrix")?.remove();
      const grid = document.querySelector<HTMLElement>(".kit-overlays")!;
      grid.hidden = false;
      grid.style.height = `${Math.ceil(grid.getBoundingClientRect().height)}px`;
    });
    await expect(overlays).toBeVisible();
    for (const name of OVERLAYS) {
      const copy = overlays.locator(`[data-overlay="${name}"]`);
      await expect(copy, name).toBeVisible();
      for (const [k, c] of Object.entries(await colorsOf(copy))) if (!transparent(c) && !isToken(c, allowed)) found.push(`${name} ${k}: ${c}`);
    }
    expect(found).toEqual([]);
    const menuShot = (name: string) => overlays.locator(`[data-overlay="${name}"]`).screenshot({ animations: "disabled" });
    expect((await menuShot("Menu")).equals(await menuShot("Menu item hover")), "Menüzeile überfahren erzwungen").toBe(false);
    await expect(overlays).toHaveScreenshot(`kit-overlays-${style}-${theme}.png`, { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.01 });
    if (style === "default") await overlays.screenshot({ path: `../../docs/design/screens/web-kit-overlays-${theme}.png`, animations: "disabled" });
  });
}

// Die Prüfung selbst: ein fremdes Blau beim Überfahren fällt auf.
test("Zustands-Galerie erkennt eine fremde Überfahren-Farbe", async ({ page }) => {
  await page.goto("/#prefs-kit");
  await expect(page.getByTestId("astryx-kit")).toBeVisible();
  const allowed = await tokenColors(page);
  await page.addStyleTag({ content: "[data-testid=astryx-kit] .astryx-button:hover { background-image: linear-gradient(rgb(35, 131, 226), rgb(35, 131, 226)) !important; }" });
  const b = page.getByTestId("astryx-kit").getByRole("button", { name: "Cancel", exact: true });
  await setState(page, b, "hover");
  const bad = Object.values(await colorsOf(b)).filter((c) => !transparent(c) && !isToken(c, allowed));
  expect(bad).toContain("rgb(35, 131, 226)");
});
