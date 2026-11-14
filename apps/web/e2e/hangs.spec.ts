// BSD-418: Hänger-Analyse – Busy-Loops von 300 ms, 1 s und 3 s erscheinen in Settings → Diagnostics → Hangs mit Dauer,
// Aktivität und Schritten; ein 3-s-Hänger mit Neuladen mitten drin zeigt nach dem Start „Ended in a hang“; verborgener
// Tab: kein Fehlalarm; Bündel und Bericht tragen die Hänger; Leerlauf kostet kaum Zeit. Beide Browser.
import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ready, test } from "./replay/fixture.js";

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
  const section = page.getByTestId("settings-section-diagnostics-hangs");
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
  // im Log (Warnung ab 1 s) und im Bündel „Problem melden“, ohne Inhalte
  await expect(page.getByTestId("diagnostics-log")).toContainText("main thread blocked for");
  const bundle = await page.evaluate(() => (globalThis as unknown as { __basedReport: { bundle(n: string): { hangs?: { stats: { count: number }; hangs: Hang[] } } } }).__basedReport.bundle("x"));
  expect(bundle.hangs?.stats.count).toBeGreaterThanOrEqual(2);
  expect(bundle.hangs?.hangs.some((h) => h.breadcrumbs.at(-1) === "test hang 1000")).toBe(true);
  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/hangs this session: \d+ hangs?/);
    expect(text).toContain("click settings-section-diagnostics-status (group) › test hang 300 › test hang 1000");
  }
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
  const problems = page.getByTestId("settings-section-diagnostics-problems");
  await expect(problems.getByTestId("diagnostics-last-session")).toHaveText("Ended in a hang", { timeout: 10_000 });
  // Chromium: der Worker hält die Dauer fest; WebKit: der Hauptthread beim Verlassen (Worker-Speicher hängt dort mit)
  await expect(problems).toContainText(/Based hung for \d\.\d s during route settings and was reloaded or closed right after/);
  const section = page.getByTestId("settings-section-diagnostics-hangs");
  await expect(section.getByTestId("hangs-ended-in-hang")).toBeVisible();
  await expect(section).toContainText(/Steps before: .*click settings-section-diagnostics-status \(group\) › test hang 3000/);
  // frühere Sitzung mit dem Hänger (einmal, nicht doppelt)
  const prev = section.getByTestId("hang-session").first();
  await prev.getByRole("button", { name: "Show hangs" }).click();
  await expect(prev.getByTestId("hang-item").filter({ hasText: /[23]\.\d s · Main thread/ })).toHaveCount(1);
  await expect(page.getByTestId("diagnostics-log")).toContainText("previous session ended in a hang");
  // Absturzbericht von Hand: Art „hang“
  await page.getByTestId("settings-section-diagnostics-crash").getByRole("button", { name: "Prepare report…" }).click();
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
  const problems = next.getByTestId("settings-section-diagnostics-problems");
  if (browserName === "webkit") {
    // Bekannte Grenze: WebKit leitet Speicherzugriffe aus Workern über den Hauptthread – beim harten Beenden mitten im
    // Hänger bleibt nur „nicht sauber beendet“ mit der letzten Aktivität aus dem Herzschlag.
    await expect(problems.getByTestId("diagnostics-last-session")).toHaveText("Ended unexpectedly");
    await expect(problems).toContainText("last activity: route settings");
    return;
  }
  await expect(problems.getByTestId("diagnostics-last-session")).toHaveText("Ended in a hang", { timeout: 15_000 });
  await expect(problems).toContainText("Based hung for more than 2 s during route settings and was then closed or reloaded.");
  const prev = next.getByTestId("settings-section-diagnostics-hangs").getByTestId("hang-session").first();
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

test("Leerlauf: der Takt kostet kaum Zeit (unter 1 % des Hauptthreads)", async ({ page }) => {
  await ready(page, "prefs-diagnostics");
  const before = await page.evaluate(() => (globalThis as unknown as Hooks).__basedTest.hangs.overhead());
  await page.waitForTimeout(5000);
  const after = await page.evaluate(() => (globalThis as unknown as Hooks).__basedTest.hangs.overhead());
  const ticks = after.ticks - before.ticks, busy = after.busyMs - before.busyMs, elapsed = after.elapsedMs - before.elapsedMs;
  console.log(`hang monitor idle: ${ticks} ticks in ${elapsed} ms, ${busy.toFixed(2)} ms busy (${((busy / elapsed) * 100).toFixed(3)} %)`);
  expect(ticks).toBeGreaterThan(40);
  expect(busy / elapsed).toBeLessThan(0.01);
});

test("Checkliste: Abschnitt Hangs in drei Größen, hell und dunkel – im Fenster, ohne waagrechtes Rollen", async ({ page, browserName }) => {
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.goto("about:blank");
    await ready(page, "prefs-diagnostics");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    const section = page.getByTestId("settings-section-diagnostics-hangs");
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
