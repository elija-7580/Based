import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectEditable, focusEditorEnd } from "./editor-helpers.js";

// BSD-302 Teil 1: Zustands-Galerie. Jeder Based-Baustein im Design-Kit (Settings → Diagnostics → Design kit) und die
// häufigsten Bedienelemente der Shell werden in Ruhe, Überfahren, gedrückt, Tastaturfokus und deaktiviert angesehen.
// Jede Farbe, die dabei sichtbar wird (Hintergrund, Schrift, Rand, Fokusring, Schatten), muss ein Token-Wert sein –
// kein fremdes Blau aus einer Bibliothek; ein Token darf mit eigener Deckkraft vorkommen (Überfahren = Tinte 6 %).
// Bildvergleich und Fotos der Zustände folgen in Teil 2.

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
  await page.waitForTimeout(220); // Übergänge (Bewegung 120/180 ms) abwarten
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
  { name: "Field disabled", loc: (p) => p.getByTestId("astryx-kit").getByLabel("Token"), states: ["disabled"] },
  { name: "Tab", loc: (p) => p.getByTestId("astryx-kit").getByRole("tab", { name: "Summary" }), states: ["rest", "hover", "focus"] },
  { name: "Tab selected", loc: (p) => p.getByTestId("astryx-kit").getByRole("tab", { name: "Notes" }), states: ["rest", "hover"] },
  { name: "Token", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: /Ada/ }), states: ["rest", "hover", "pressed", "focus"] },
  { name: "Menu trigger", loc: (p) => p.getByTestId("astryx-kit").getByRole("button", { name: "Page menu" }), states: ["rest", "hover", "focus"] },
];

for (const theme of ["light", "dark"] as const) {
  test(`Zustands-Galerie: Farben der Zustände sind Tokens (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#prefs-kit");
    await expect(page.getByTestId("astryx-kit")).toBeVisible();
    const allowed = await tokenColors(page);
    const found: string[] = [];
    for (const it of KIT) {
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
    await look("Seitenleiste: Baumzeile", nav.getByRole("treeitem").first(), ["rest", "hover", "focus"]);
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
    await page.waitForTimeout(220);
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
