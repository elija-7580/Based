// BSD-319: „Problem melden“ (⇧⌘B, ⌘K, Settings → Diagnostics): Bündel mit Foto, Aufzeichnung, Blockbaum und Layout,
// standardmäßig ohne Nutzertext; Liste der Berichte, Log-Filter, Entwickler-Ansicht; Aufzeichnung kostet beim Tippen nichts.
import { expect, type Page } from "@playwright/test";
import { editor, legacyTest, openNewPage, ready, test } from "./replay/fixture.js";

const SECRET = "Quarterly salary Ada Lovelace 4711";

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
// BSD-407 Teil 3: Aufzeichnung (ProseMirror „tr“, Seiten-Y.Doc „yjs“, BlockNote-Blockbaum) gibt es nur im alten Editor:
// diese Tests laufen mit `legacyTest` (gepinnt, docs/editor-parity.md „noch BlockNote“); Diagnostics-Einstellungen nicht.

legacyTest("⇧⌘B: Bündel mit Foto, Aufzeichnung, Blockbaum und Layout – ohne Nutzertext", async ({ page }) => {
  await ready(page);
  await openNewPage(page, "Report");
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
  for (const k of ["checkpoint", "key", "input", "tr", "yjs"]) expect(kinds.has(k), k).toBe(true);
  expect(JSON.stringify(b.state.blocks)).toContain("bulletListItem");
  expect(b.layout.items.some((i) => i.kind === "block")).toBe(true);
  expect(b.screenshot).toBe("screenshot.png");
  expect(r!.shotSize).toBeGreaterThan(1000);
  const json = JSON.stringify(b);
  for (const word of ["Quarterly", "salary", "Lovelace", "4711", "second line"]) expect(json).not.toContain(word);

  // Danach in Settings → Diagnostics → Reports
  await saved.getByRole("button", { name: "Open Diagnostics" }).click();
  const reports = page.getByTestId("settings-section-diagnostics-reports");
  await expect(reports.getByText("Typed two lines, the list jumped")).toBeVisible();
  await reports.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete report" }).click();
  await expect(reports.getByText("No reports yet")).toBeVisible();
  expect(await savedReports(page)).toHaveLength(0);
});

legacyTest("Echter Text nur per Häkchen, Foto abwählbar; ⌘K → Report a problem", async ({ page }) => {
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

test("Settings → Diagnostics: Gruppen, Log mit Stufe und Suche, Entwickler-Ansicht", async ({ page }) => {
  await ready(page, "prefs-diagnostics");
  for (const id of ["status", "problems", "reports", "log", "dev"]) await expect(page.getByTestId(`settings-section-diagnostics-${id}`)).toBeVisible();
  await expect(page.getByTestId("diagnostics-version")).toContainText("commit");
  await expect(page.getByTestId("settings-section-diagnostics-problems")).toContainText("Nothing to report");
  await expect(page.getByTestId("settings-missing")).toHaveCount(0);

  await page.evaluate(() => setTimeout(() => { throw new Error("boom for the filter"); }));
  const problems = page.getByTestId("settings-section-diagnostics-problems");
  await expect(problems.getByTestId("diagnostics-errors")).toHaveText("1");
  const log = page.getByTestId("settings-section-diagnostics-log");
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

legacyTest("Entwickler-Ansicht zeigt die letzten Ereignisse live", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => localStorage.setItem("based.devView", "true"));
  await ready(page);
  await openNewPage(page, "Dev");
  await page.keyboard.type("ab");
  await expect(page.getByTestId("dev-events")).toContainText("key x");
  await expect(page.getByTestId("dev-events")).toContainText("tr change");
  // fängt keine Klicks ab
  expect(await page.getByTestId("dev-overlay").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await editor(page).locator(".bn-block-content").first().click();
});

legacyTest("Aufzeichnung kostet beim Tippen messbar nichts", async ({ page }) => {
  await ready(page);
  await openNewPage(page, "Perf");
  // Dieselben Ereignisse mit und ohne Aufzeichnung an den Editor schicken; Unterschied je Taste (Median aus 5 Runden).
  const extra = await page.evaluate(() => {
    const hooks = (globalThis as unknown as { __basedReport: { recording(on: boolean): void } }).__basedReport;
    const target = document.querySelector(".ProseMirror")!;
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
