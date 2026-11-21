// BSD-319: „Problem melden“ (⇧⌘B, ⌘K, Settings → Diagnostics): Bündel mit Foto, Aufzeichnung, Blockbaum und Layout,
// standardmäßig ohne Nutzertext; Liste der Berichte, Log-Filter, Entwickler-Ansicht; Aufzeichnung kostet beim Tippen nichts.
import { expect, type Page } from "@playwright/test";
import { editor, openNewPage, ready, test } from "./replay/fixture.js";
import { overflows, overlaps } from "./layout-checks.js";

// Feedback 20. 11.: Diagnostics hat oben die Übersicht, darunter „Details“ mit Umschalter (Hangs · Log · Crash reports · Reports).
const diagTab = (page: import("@playwright/test").Page, name: string) =>
  page.getByTestId("settings-section-diagnostics-details").getByRole("radio", { name, exact: true }).click();

// BSD-628: Die Zahl hat acht Stellen – „4711“ stand um hh:47:11 auch in der Bericht-ID und in Zeitstempeln (falscher Alarm).
const SECRET = "Quarterly salary Ada Lovelace 47110815";

type Row = { id: string; bundle: Record<string, unknown> & { recording: { events: { kind: string }[] }; state: { blocks?: unknown; doc?: unknown; root?: string }; layout: { items: { kind: string }[] }; screenshot?: string; note: string }; screenshot?: Blob };

/** Gespeicherte Berichte im Browser (IndexedDB „based-reports“) samt Größe des Fotos. */
const savedReports = (page: Page) => page.evaluate(() => new Promise<(Row & { shotSize: number })[]>((resolve, reject) => {
  const req = indexedDB.open("based-reports", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("reports", { keyPath: "id" });
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const get = req.result.transaction("reports").objectStore("reports").getAll();
    get.onsuccess = () => resolve((get.result as Row[]).map((r) => ({ ...r, shotSize: r.screenshot?.size ?? 0, screenshot: undefined })));
    get.onerror = () => reject(get.error);
  };
}));

test.describe.configure({ timeout: 90_000 });
// Aufzeichnung im Block-Editor (ADR 0016) mit Block-Transaktionen „change“ und Blockbaum (der alte BlockNote-Editor mit
// „tr“/„yjs“ ist mit BSD-407 Teil 4 entfernt).
const EDITORS = [
  { name: "Block-Editor", t: test, open: openNewPage, kinds: ["checkpoint", "key", "input", "change", "select"], list: "bulletedList" },
];

for (const { name, t, open, kinds: expectedKinds, list } of EDITORS) t(`⇧⌘B (${name}): Bündel mit Foto, Aufzeichnung, Blockbaum und Layout – ohne Nutzertext`, async ({ page }) => {
  await ready(page);
  await open(page, "Report");
  await page.keyboard.type(SECRET);
  await page.keyboard.press("Enter");
  await page.keyboard.type("- second line");
  await page.keyboard.press("ControlOrMeta+Shift+b");
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole("checkbox", { name: "Include real text" })).not.toBeChecked();
  const save = dialog.getByRole("button", { name: "Save report" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "What did you do, and what happened?" }).fill("Typed two lines, the list jumped");
  await save.click();
  const saved = page.getByRole("dialog", { name: "Report saved" });
  await expect(saved.getByTestId("report-saved")).toContainText("recorded events");
  await expect(saved.getByRole("button", { name: "Save as file…" })).toBeVisible();

  const [r] = await savedReports(page);
  expect(r).toBeDefined();
  const b = r!.bundle;
  expect(b.note).toBe("Typed two lines, the list jumped");
  const kinds = new Set(b.recording.events.map((e) => e.kind));
  for (const k of expectedKinds) expect(kinds.has(k), k).toBe(true);
  expect(JSON.stringify(b.state.blocks)).toContain(list);
  expect(b.layout.items.some((i) => i.kind === "block")).toBe(true);
  expect(b.screenshot).toBe("screenshot.png");
  expect(r!.shotSize).toBeGreaterThan(1000);
  const json = JSON.stringify(b);
  for (const word of ["Quarterly", "salary", "Lovelace", "47110815", "second line"]) expect(json).not.toContain(word);

  // Danach in Settings → Diagnostics → Reports
  await saved.getByRole("button", { name: "Open Diagnostics" }).click();
  await diagTab(page, "Reports");
  const reports = page.getByTestId("diagnostics-tab-reports");
  await expect(reports.getByText("Typed two lines, the list jumped")).toBeVisible();
  await reports.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete report" }).click();
  await expect(reports.getByText("No reports yet")).toBeVisible();
  expect(await savedReports(page)).toHaveLength(0);
});

test("Echter Text nur per Häkchen, Foto abwählbar; ⌘K → Report a problem", async ({ page }) => {
  await ready(page);
  await openNewPage(page, "Real text");
  await page.keyboard.type(SECRET);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Report a pro");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("checkbox", { name: "Include real text" }).check();
  await dialog.getByRole("checkbox", { name: "Include a screenshot" }).uncheck();
  await dialog.getByRole("textbox", { name: "What did you do, and what happened?" }).fill("token sk-ant-api03-SECRETSECRET in the note");
  await dialog.getByRole("button", { name: "Save report" }).click();
  await page.getByRole("dialog", { name: "Report saved" }).getByRole("button", { name: "Done" }).click();
  const [r] = await savedReports(page);
  const json = JSON.stringify(r!.bundle);
  expect(json).toContain("Quarterly salary");
  expect(json).not.toContain("SECRETSECRET");
  expect(r!.bundle.screenshot).toBeUndefined();
  expect(r!.shotSize).toBe(0);
});

// BSD-616: Das mehrzeilige Feld ist ein Feld nach elements.md – Fläche `surface-raised`, kein Rahmen; beim Tippen zeigt
// allein der Fokusrahmen der Fläche den Fokus (kein zweiter Rahmen am <textarea>).
test("Problem melden: mehrzeiliges Feld ist eine Fläche ohne Rahmen, ein Fokusrahmen", async ({ page }) => {
  await ready(page);
  await openNewPage(page, "Field");
  await page.keyboard.press("ControlOrMeta+Shift+b");
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const box = dialog.getByRole("textbox", { name: "What did you do, and what happened?" });
  const look = () => box.evaluate((el) => {
    const field = el.closest<HTMLElement>(".astryx-text-area")!;
    const probe = document.createElement("i");
    probe.style.background = "var(--surface-raised)";
    document.body.append(probe);
    const raised = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const f = getComputedStyle(field);
    return { border: f.borderTopColor, bg: f.backgroundColor, raised, shadow: f.boxShadow, outline: getComputedStyle(el).outlineStyle };
  });
  const rest = await look();
  expect(rest.border).toBe("rgba(0, 0, 0, 0)");
  expect(rest.bg).toBe(rest.raised);
  await box.focus();
  await page.keyboard.type("It broke");
  const focused = await look();
  expect(focused.shadow).toContain("inset");
  expect(focused.outline).toBe("none");
});

// BSD-467: Nach dem Speichern zeigt der Dialog den Weg zu uns – Adresse, Hinweis zum Anhang, Knopf „Email report“
// (mailto mit Version, Kanal, System; ohne Seiteninhalt und ohne Notiz). Fotos 1280 × 820 hell/dunkel.
for (const theme of ["light", "dark"] as const) test(`⇧⌘B → Report saved → Email report öffnet eine Mail an hello@basednotes.app (${theme})`, async ({ page, browserName }) => {
  await page.addInitScript((t) => {
    localStorage.setItem("based.appearance", JSON.stringify({ theme: t }));
    const w = globalThis as unknown as { __mailto: string[] };
    w.__mailto = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.href.startsWith("mailto:")) { w.__mailto.push(this.href); return; }
      click.call(this);
    };
  }, theme);
  await page.setViewportSize({ width: 1280, height: 820 });
  await ready(page);
  await openNewPage(page, "Mail");
  await page.keyboard.type(SECRET);
  await page.keyboard.press("ControlOrMeta+Shift+b");
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("textbox", { name: "What did you do, and what happened?" }).fill("Private note about Lovelace");
  await dialog.getByRole("button", { name: "Save report" }).click();
  const saved = page.getByRole("dialog", { name: "Report saved" });
  const box = saved.getByTestId("report-email");
  await expect(box).toContainText("Send it to hello@basednotes.app");
  await expect(box).toContainText("Save it as a file first, then attach the file to the email.");
  await page.mouse.move(0, 0);
  expect(await overflows(page)).toEqual([]);
  expect(await overlaps(page)).toEqual([]);
  if (browserName === "chromium") await saved.screenshot({ path: `../../docs/design/screens/report-saved-email-${theme}.png` });

  await box.getByRole("button", { name: "Email report" }).click();
  const hrefs = await page.evaluate(() => (globalThis as unknown as { __mailto: string[] }).__mailto);
  expect(hrefs).toHaveLength(1);
  const href = hrefs[0]!;
  expect(href).toBe(await box.getAttribute("data-mailto"));
  expect(href.startsWith("mailto:hello@basednotes.app?subject=")).toBe(true);
  const text = decodeURIComponent(href);
  expect(text).toMatch(/subject=Based \S+ – problem report/);
  expect(text).toContain("Channel: dev");
  expect(text).toMatch(/Report: \d{8}-\d{6}-\w+/);
  for (const leak of ["Quarterly", "Lovelace", "47110815", "Mozilla"]) expect(text).not.toContain(leak);
  await expect(saved).toBeVisible();

  // kleinstes Fenster: nichts läuft heraus, Knopf erreichbar
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(box.getByRole("button", { name: "Email report" })).toBeInViewport();
  expect(await overflows(page)).toEqual([]);
});

test("Settings → Diagnostics: Gruppen, Log mit Stufe und Suche, Entwickler-Ansicht", async ({ page }) => {
  await ready(page, "prefs-diagnostics");
  for (const id of ["status", "details", "dev"]) await expect(page.getByTestId(`settings-section-diagnostics-${id}`)).toBeVisible();
  await expect(page.getByTestId("diagnostics-version")).toContainText("commit");
  await expect(page.getByTestId("settings-section-diagnostics-status")).toContainText("Nothing to report");
  await expect(page.getByTestId("settings-missing")).toHaveCount(0);

  await page.evaluate(() => setTimeout(() => { throw new Error("boom for the filter"); }));
  const problems = page.getByTestId("settings-section-diagnostics-status");
  await expect(problems.getByTestId("diagnostics-errors")).toHaveText("1");
  await expect(problems).toContainText("1 thing to look at");
  await diagTab(page, "Log");
  const log = page.getByTestId("diagnostics-tab-log");
  await log.getByRole("radio", { name: "Errors" }).click();
  await expect(log.getByTestId("diagnostics-log")).toContainText("boom for the filter");
  await expect(log.getByTestId("diagnostics-log")).not.toContainText("boot:");
  await log.getByRole("radio", { name: "All" }).click();
  await log.getByRole("textbox", { name: "Search the log" }).fill("store ready");
  await expect(log.getByTestId("diagnostics-log")).toContainText("store ready");
  await expect(log.getByTestId("diagnostics-log")).not.toContainText("boom");
  // Beschriftungen sind Bedienung (nicht markierbar), das Log ist Daten
  expect(await page.getByTestId("settings-section-diagnostics-status").evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
  expect(await log.getByTestId("diagnostics-log").evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");

  // Entwickler-Ansicht: Schalter per Tastatur
  const sw = page.getByRole("switch", { name: "Developer view" });
  await sw.focus();
  await page.keyboard.press("Space");
  await expect(sw).toBeChecked();
  await expect(page.getByTestId("dev-overlay")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-dev-view", "");
  await page.reload();
  await expect(page.getByTestId("dev-overlay")).toBeAttached();
  await page.getByRole("switch", { name: "Developer view" }).click();
  await expect(page.getByTestId("dev-overlay")).toHaveCount(0);
});

test("Entwickler-Ansicht zeigt die letzten Ereignisse live", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => localStorage.setItem("based.devView", "true"));
  await ready(page);
  await openNewPage(page, "Dev");
  await page.keyboard.type("ab");
  await expect(page.getByTestId("dev-events")).toContainText("key x");
  await expect(page.getByTestId("dev-events")).toContainText("change Typing · 1 block");
  // fängt keine Klicks ab
  expect(await page.getByTestId("dev-overlay").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await editor(page).locator("[data-editable-id]").first().click();
  await expect(page.getByTestId("dev-events")).toContainText("(pointer)");
});

test("Wiedergabe-Haken im Block-Editor: Zwischenstand laden, Records anwenden, Schreibmarke setzen", async ({ page }) => {
  await ready(page);
  const id = await openNewPage(page, "Hooks");
  await page.keyboard.type("One");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Two");
  type H = { bundle(n: string, real?: boolean): { state: { doc: { blocks: { id: string; text?: unknown }[] }; sel: { block?: string; path?: number[] } } }; load(r: string, d: unknown, s: unknown, rr?: string): boolean; docJSON(r: string): unknown; setSelection(r: string, s: unknown): boolean };
  const b = await page.evaluate(() => (globalThis as unknown as { __basedReport: H }).__basedReport.bundle("hooks", true));
  expect(b.state.doc.blocks.map((x) => x.text)).toEqual(["One", "Two"]);
  expect(b.state.sel).toMatchObject({ block: b.state.doc.blocks[1]!.id, path: [1] });
  // auf eine andere Seite laden: neue IDs, gleicher Inhalt, Schreibmarke im zweiten Block
  const other = (await page.evaluate(() => (globalThis as unknown as { __based: { client: { command(c: unknown): Promise<string> } } }).__based.client.command({ op: "createPage", title: "Target" })));
  await page.goto(`/#page-${other}`);
  await expect(editor(page)).toBeVisible();
  expect(await page.evaluate(([r, d, s, rr]) => (globalThis as unknown as { __basedReport: H }).__basedReport.load(r as string, d, s, rr as string), [other, b.state.doc, { type: "text", anchor: 1, head: 1, block: b.state.doc.blocks[1]!.id }, id] as const)).toBe(true);
  await expect(editor(page).locator("[data-editable-id]")).toHaveText(["One", "Two"]);
  await expect(editor(page).locator("[data-editable-id]").nth(1)).toBeFocused();
  await page.keyboard.type("!");
  await expect(editor(page).locator("[data-editable-id]").nth(1)).toHaveText("T!wo");
});

test("Aufzeichnung kostet beim Tippen messbar nichts", async ({ page }) => {
  await ready(page);
  await openNewPage(page, "Perf");
  // Dieselben Ereignisse mit und ohne Aufzeichnung an den Editor schicken; Unterschied je Taste (Median aus 5 Runden).
  const extra = await page.evaluate(() => {
    const hooks = (globalThis as unknown as { __basedReport: { recording(on: boolean): void } }).__basedReport;
    const target = document.querySelector("[data-editable-id]")!;
    const run = () => {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true, cancelable: true }));
      }
      return (performance.now() - t0) / 1000;
    };
    const diffs: number[] = [];
    run();
    for (let k = 0; k < 5; k++) {
      hooks.recording(false);
      const off = run();
      hooks.recording(true);
      diffs.push(run() - off);
    }
    return diffs.sort((x, y) => x - y)[2]!;
  });
  // unter 0,05 ms je Taste (ein Bild hat 16 ms)
  expect(extra).toBeLessThan(0.05);
});
