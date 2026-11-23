// BSD-418: Hänger-Analyse – Busy-Loops von 300 ms, 1 s und 3 s erscheinen in Settings → Diagnostics → Hangs mit Dauer,
// Aktivität und Schritten; ein 3-s-Hänger mit Neuladen mitten drin zeigt nach dem Start „Ended in a hang“; verborgener
// Tab: kein Fehlalarm; Bündel und Bericht tragen die Hänger; Leerlauf kostet kaum Zeit. Beide Browser.
import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ready, test } from "./replay/fixture.js";

// Feedback 20. 11.: Diagnostics hat oben die Übersicht, darunter „Details“ mit Umschalter (Hangs · Log · Crash reports · Reports).
const diagTab = (page: import("@playwright/test").Page, name: string) =>
  page.getByTestId("settings-section-diagnostics-details").getByRole("radio", { name, exact: true }).click();

const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));

interface Hang { at: number; ms: number; source: string; activity: string; breadcrumbs: string[]; culprit?: string; ongoing?: boolean }
type Hooks = { __basedTest: { hangs: { hang(ms: number, delay?: number): void; hangs(): Hang[]; overhead(): { ticks: number; busyMs: number; elapsedMs: number } } } };

const hang = (page: Page, ms: number) => page.evaluate((n) => (globalThis as unknown as Hooks).__basedTest.hangs.hang(n), ms);
const hangs = (page: Page) => page.evaluate(() => (globalThis as unknown as Hooks).__basedTest.hangs.hangs());
/** Der Hänger aus unserem Busy-Loop (letzter Schritt „test hang <ms>“). */
async function testHang(page: Page, ms: number): Promise<Hang> {
  let found: Hang | undefined;
  await expect.poll(async () => {
    found = (await hangs(page)).find((h) => h.breadcrumbs.at(-1) === `test hang ${ms}`);
    return !!found;
  }, { timeout: ms + 5000 }).toBe(true);
  // Ursache/genaue Dauer aus dem langen Frame kommen kurz danach
  await page.waitForTimeout(400);
  return (await hangs(page)).find((h) => h.breadcrumbs.at(-1) === `test hang ${ms}`)!;
}

test("Busy-Loops von 300 ms und 1 s erscheinen mit Dauer, Aktivität, Ursache und Schritten", async ({ page, browserName }) => {
  await ready(page, "prefs-diagnostics");
  const section = page.getByTestId("diagnostics-tab-hangs");
  await expect(section).toBeVisible();
  // ein Klick als Schritt davor (Ziel als Test-ID, nie Text)
  await page.getByTestId("settings-section-diagnostics-status").click();
  await hang(page, 300);
  const short = await testHang(page, 300);
  expect(short.source).toBe("main");
  expect(short.ms).toBeGreaterThanOrEqual(250);
  expect(short.ms).toBeLessThan(1000);
  expect(short.activity).toBe("route settings");
  expect(short.breadcrumbs).toContain("click settings-section-diagnostics-status (group)");
  // Chromium: Skript und Auslöser aus dem Long Animation Frame (im gebauten Bündel ohne Funktionsnamen)
  if (browserName === "chromium") expect(short.culprit).toMatch(/\.js:\d+\) · user-callback:TimerHandler:setTimeout/);
  else expect(short.culprit).toBe("no attribution (WebKit)");

  await hang(page, 1000);
  const long = await testHang(page, 1000);
  expect(long.ms).toBeGreaterThanOrEqual(950);
  expect(long.ms).toBeLessThan(2000);

  // Anzeige: Kennzahlen, Liste (neueste zuerst), Schritte aufklappbar
  await expect(section.getByTestId("hangs-summary")).toContainText(/\d+ hangs? · .* blocked/);
  await expect(section.getByTestId("hangs-percentiles")).toContainText("max");
  // WebKit ohne lange Frames: der 50-ms-Takt misst bis zu einem Takt zu kurz
  const first = section.getByTestId("hang-item").filter({ hasText: /(9\d\d ms|1\.\d s) · Main thread/ }).first();
  await expect(first).toBeVisible();
  await expect(first).toContainText("during route settings");
  await first.getByRole("button", { name: "Show the steps before this hang" }).click();
  await expect(first.getByTestId("hang-steps")).toContainText(/Steps before: .*click settings-section-diagnostics-status \(group\) › test hang 300 › test hang 1000/);
  // im Bündel „Problem melden“, ohne Inhalte
  const bundle = await page.evaluate(() => (globalThis as unknown as { __basedReport: { bundle(n: string): { hangs?: { stats: { count: number }; hangs: Hang[] } } } }).__basedReport.bundle("x"));
  expect(bundle.hangs?.stats.count).toBeGreaterThanOrEqual(2);
  expect(bundle.hangs?.hangs.some((h) => h.breadcrumbs.at(-1) === "test hang 1000")).toBe(true);
  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    // Feedback 20. 11.: ein Knopf oben nimmt alles mit
    await page.getByRole("button", { name: "Copy report" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/hangs this session: \d+ hangs?/);
    expect(text).toContain("click settings-section-diagnostics-status (group) › test hang 300 › test hang 1000");
    // 14. 11.: alle Hänger auf einmal kopieren
    await section.getByRole("button", { name: "Copy hangs" }).click();
    await expect(section.getByRole("button", { name: "Copied" })).toBeVisible();
    const hangText = await page.evaluate(() => navigator.clipboard.readText());
    expect(hangText).toMatch(/^hangs this session: \d+ hangs?/);
    expect(hangText).toContain("test hang 300");
    expect(hangText).toContain("test hang 1000");
  }
  // Hänger-Zeilen lassen sich markieren (Daten, keine Bedienung)
  expect(await first.evaluate((el) => getComputedStyle(el.querySelector("[data-testid='hang-steps']") ?? el).userSelect)).toBe("text");
  // im Log (Warnung ab 1 s)
  await diagTab(page, "Log");
  await expect(page.getByTestId("diagnostics-log")).toContainText("main thread blocked for");
  if (browserName === "chromium") {
    // … und das ganze Log (gezeigte Zeilen) auf einmal
    await page.getByRole("button", { name: /^Copy log \(\d+\)$/ }).click();
    const logText = await page.evaluate(() => navigator.clipboard.readText());
    expect(logText).toContain("main thread blocked for");
    expect(logText.split("\n").length).toBeGreaterThan(1);
  }
  // ⌘A im Log markiert nur das Log
  await page.getByTestId("diagnostics-log").focus();
  await page.keyboard.press("ControlOrMeta+a");
  const sel = await page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
  expect(sel).toContain("main thread blocked for");
  expect(sel).not.toContain("Copy report");
});

test("3-s-Hänger mit Neuladen mitten drin: nach dem Start „Ended in a hang“ mit Aktivität und Schritten", async ({ page }) => {
  await ready(page, "prefs-diagnostics");
  await page.getByTestId("settings-section-diagnostics-status").click();
  await hang(page, 3000);
  // nach 2 s schreibt der Watchdog-Worker den Marker; dann neu laden, solange der Hauptthread noch blockiert
  // (das Neuladen wartet, bis er frei ist – der Marker bleibt danach noch kurz stehen und überlebt so das Neuladen)
  await page.waitForTimeout(2700);
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "", { timeout: 20_000 });
  const problems = page.getByTestId("settings-section-diagnostics-status");
  await expect(problems.getByTestId("diagnostics-last-session")).toHaveText("Ended in a hang", { timeout: 10_000 });
  // Chromium: der Worker hält die Dauer fest; WebKit: der Hauptthread beim Verlassen (Worker-Speicher hängt dort mit)
  // WebKit: je nach Zeitpunkt des Neuladens kommt der Marker „lief noch“ (Worker) oder „gleich danach neu geladen“ (pagehide) an
  await expect(problems).toContainText(/Based hung for (\d\.\d s|more than \d+ s) during route settings and was (reloaded or closed right after|then closed or reloaded)/);
  const section = page.getByTestId("diagnostics-tab-hangs");
  await expect(section.getByTestId("hangs-ended-in-hang")).toBeVisible();
  await expect(section).toContainText(/Steps before: .*click settings-section-diagnostics-status \(group\) › test hang 3000/);
  // frühere Sitzung mit dem Hänger (einmal, nicht doppelt)
  const prev = section.getByTestId("hang-session").first();
  await prev.getByRole("button", { name: "Show hangs" }).click();
  await expect(prev.getByTestId("hang-item").filter({ hasText: /[23]\.\d s · Main thread/ })).toHaveCount(1);
  await diagTab(page, "Log");
  await expect(page.getByTestId("diagnostics-log")).toContainText("previous session ended in a hang");
  // Absturzbericht von Hand: Art „hang“
  await diagTab(page, "Crash reports");
  await page.getByTestId("diagnostics-tab-crash").getByRole("button", { name: "Prepare report…" }).click();
  const dialog = page.getByRole("dialog", { name: "Based hung and was closed" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("crash-report-summary")).toContainText("during route settings");
  await dialog.getByRole("button", { name: "Show report" }).click();
  await expect(dialog.getByTestId("crash-report-preview")).toContainText('"kind": "hang"');
  // einmal übernommen: nach erneutem Laden kein Hinweis mehr auf denselben Hänger
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("hangs-ended-in-hang")).toHaveCount(0);
});

test("Fenster mitten im Hänger geschlossen (wie Beenden): der nächste Start zeigt, wo es hing", async ({ page, browserName }) => {
  await ready(page, "prefs-diagnostics");
  await page.getByTestId("settings-section-diagnostics-status").click();
  await hang(page, 6000);
  await page.waitForTimeout(2800);
  const next = await page.context().newPage();
  await page.close({ runBeforeUnload: false });
  await next.goto("/#prefs-diagnostics");
  await expect(next.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  // ein anderer Tab: erst übernommen, wenn der Marker nicht mehr frisch ist (er könnte einem Tab gehören, der noch hängt)
  const problems = next.getByTestId("settings-section-diagnostics-status");
  if (browserName === "webkit") {
    // Bekannte Grenze: WebKit leitet Speicherzugriffe aus Workern über den Hauptthread – beim harten Beenden mitten im
    // Hänger bleibt nur „nicht sauber beendet“ mit der letzten Aktivität aus dem Herzschlag.
    await expect(problems.getByTestId("diagnostics-last-session")).toHaveText("Ended unexpectedly");
    await expect(problems).toContainText("last activity: route settings");
    return;
  }
  await expect(problems.getByTestId("diagnostics-last-session")).toHaveText("Ended in a hang", { timeout: 15_000 });
  await expect(problems).toContainText("Based hung for more than 2 s during route settings and was then closed or reloaded.");
  const prev = next.getByTestId("diagnostics-tab-hangs").getByTestId("hang-session").first();
  await prev.getByRole("button", { name: "Show hangs" }).click();
  await expect(prev.getByTestId("hang-item").first()).toContainText("still blocked when the session ended");
});

test("Verborgener Tab: kein Hänger-Fehlalarm; wieder sichtbar: erkannt", async ({ page }) => {
  await ready(page, "prefs-diagnostics");
  const setHidden = (hidden: boolean) => page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: h, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await setHidden(true);
  await hang(page, 600);
  await page.waitForTimeout(1500);
  expect((await hangs(page)).filter((h) => h.breadcrumbs.at(-1) === "test hang 600")).toHaveLength(0);
  await setHidden(false);
  await hang(page, 400);
  expect((await testHang(page, 400)).ms).toBeGreaterThanOrEqual(250);
});

// BSD-596: Im Leerlauf (sichtbar, vorn, keine Eingabe) läuft kein Zeitgeber mehr: die Hänger-Kette hält 2 s nach dem
// letzten Anlass an, die Sitzungs-Marke schreibt nur nach einem Anlass. Gezählt wird jeder setTimeout/setInterval-Aufruf
// des Fensters; danach weckt eine Eingabe die Messung wieder auf (ein Hänger beim Tippen wird weiter erkannt).
// BSD-655: auch der Watchdog-Worker schweigt im Leerlauf (0 Nachrichten in 5 s).
test("Leerlauf: kein Zeitgeber, kein Takt – nach einer Eingabe misst die Kette wieder", async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as { __timers: { timeouts: number; intervals: number; watchdog: number } } & typeof globalThis;
    w.__timers = { timeouts: 0, intervals: 0, watchdog: 0 };
    const st = w.setTimeout, si = w.setInterval;
    // BSD-655: Nachrichten des Watchdog-Workers (ping) wecken den Hauptthread wie ein Zeitgeber – mitzählen
    const W = w.Worker;
    if (W) w.Worker = class extends W {
      constructor(url: string | URL, o?: WorkerOptions) {
        super(url, o);
        if (o?.name === "based-hang-watchdog") this.addEventListener("message", () => { w.__timers.watchdog++; });
      }
    };
    w.setTimeout = ((...a: Parameters<typeof setTimeout>) => { w.__timers.timeouts++; return st(...a); }) as typeof setTimeout;
    w.setInterval = ((...a: Parameters<typeof setInterval>) => { w.__timers.intervals++; return si(...a); }) as typeof setInterval;
  });
  await ready(page, "prefs-diagnostics");
  // Start und erstes Zeichnen abklingen lassen (Kette läuft nach dem letzten Anlass noch 2 s)
  await page.waitForTimeout(4000);
  const count = () => page.evaluate(() => ({ ...(globalThis as unknown as { __timers: { timeouts: number; intervals: number; watchdog: number } }).__timers, ticks: (globalThis as unknown as Hooks).__basedTest.hangs.overhead().ticks }));
  const before = await count();
  await page.waitForTimeout(5000);
  const after = await count();
  console.log(`idle 5 s: ${after.timeouts - before.timeouts} setTimeout, ${after.intervals - before.intervals} setInterval, ${after.ticks - before.ticks} ticks, ${after.watchdog - before.watchdog} watchdog messages`);
  expect(after.ticks - before.ticks).toBe(0);
  expect(after.watchdog - before.watchdog).toBe(0);
  expect(after.timeouts - before.timeouts).toBe(0);
  expect(after.intervals - before.intervals).toBe(0);
  // Eingabe weckt die Messung: ein Hänger direkt danach wird erkannt (WebKit ohne lange Frames: nur über die Kette)
  await page.keyboard.press("Shift");
  await page.evaluate(() => {
    setTimeout(() => {
      const end = performance.now() + 400;
      while (performance.now() < end) { /* absichtlich blockieren */ }
    }, 20);
  });
  await expect.poll(async () => (await hangs(page)).some((h) => h.source === "main" && h.ms >= 250), { timeout: 5000 }).toBe(true);
});

test("Checkliste: Abschnitt Hangs in drei Größen, hell und dunkel – im Fenster, ohne waagrechtes Rollen", async ({ page, browserName }) => {
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.goto("about:blank");
    await ready(page, "prefs-diagnostics");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    const section = page.getByTestId("diagnostics-tab-hangs");
    await page.getByTestId("settings-section-diagnostics-status").click();
    await hang(page, 300);
    await testHang(page, 300);
    await section.getByTestId("hang-item").first().getByRole("button", { name: "Show the steps before this hang" }).click();
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await section.scrollIntoViewIfNeeded();
      const box = (await section.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      // Beschriftungen nicht markierbar
      expect(await section.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
      if (browserName === "chromium") await section.screenshot({ path: join(screens, `web-settings-hangs-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 820 });
  }
});

// BSD-407 Teil 6.7: Block-Editor hinterlässt feste Schritte für Slash-Befehle und Blockmenü-Aktionen (nie Inhalte).
test("Block-Editor: Slash-Befehl und Blockmenü-Aktion stehen als Schritte vor einem Hänger", async ({ page }) => {
  await ready(page);
  const id = await page.evaluate(() => (globalThis as unknown as { __based: { client: { command: (c: unknown) => Promise<string> } } }).__based.client.command({ op: "createPage", title: "Crumbs" }));
  await page.goto(`/#page-${id}`);
  const editor = page.getByTestId("block-editor");
  await editor.getByTestId("block-editor-tail").click();
  await page.keyboard.type("Secret words");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/heading 2");
  await page.keyboard.press("Enter");
  const first = editor.locator(".bx2-block").first();
  await first.locator(".bx2-row").hover();
  await first.locator(":scope > .bx2-gutter [data-handle]").click();
  await page.getByTestId("block-menu").getByRole("menuitem", { name: "Duplicate" }).click();
  await hang(page, 300);
  const h = await testHang(page, 300);
  expect(h.breadcrumbs).toContain("slash Heading 2");
  expect(h.breadcrumbs).toContain("block menu Duplicate");
  expect(h.breadcrumbs.join(" ")).not.toContain("Secret");
});
