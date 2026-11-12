// BSD-276: Absturzbericht nach dem Neustart – opt-in (Settings → Diagnostics → Crash reports), einmal je Sitzung,
// Vorschau ohne Inhalte, Abbrechen, Kopieren/Sichern; ohne Einwilligung kein Hinweis.
import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ready, test } from "./replay/fixture.js";

const screens = fileURLToPath(new URL("../../../docs/design/screens", import.meta.url));
const STARTED = Date.UTC(2026, 10, 12, 17, 0, 0);
const TITLE = "Geheimes Tagebuch Ada";

/** Vor jedem Laden: die vorige Sitzung endete nicht sauber (letzte Log-Zeile nennt einen Seitentitel in Anführungszeichen). */
async function plantCrash(page: Page, consent: boolean) {
  await page.addInitScript(([started, title, on]) => {
    localStorage.setItem("based.diagnostics.session", JSON.stringify({
      startedAt: started, lastBeat: started + 90_000, clean: false, stalls: 1,
      log: [{ at: started + 10, level: "info", message: "boot: store ready +80 ms" }, { at: started + 20, level: "error", message: `TypeError in “${title}”` }],
    }));
    if (on) localStorage.setItem("based.feedback.crashReports", "on");
  }, [STARTED, TITLE, consent] as const);
}

test("Ohne Einwilligung kein Hinweis; Settings bietet den Bericht trotzdem von Hand an", async ({ page }) => {
  await plantCrash(page, false);
  await ready(page, "prefs-diagnostics");
  const section = page.getByTestId("settings-section-diagnostics-crash");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("crash-report-prompt")).toHaveCount(0);
  const sw = section.getByRole("switch", { name: "Offer a report after a crash or freeze" });
  await expect(sw).not.toBeChecked();
  await expect(section).toContainText("Didn’t close normally");
  await expect(section).toContainText("Not available in this beta yet");
  await section.getByRole("button", { name: "Prepare report…" }).click();
  const dialog = page.getByRole("dialog", { name: "Based didn’t close normally" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toHaveCount(0);
  // Einwilligung per Tastatur, bleibt nach dem Neuladen
  await sw.focus();
  await page.keyboard.press("Space");
  await expect(sw).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("based.feedback.crashReports"))).toBe("on");
});

test("Mit Einwilligung: Hinweis beim Start, Vorschau ohne Inhalte, Abbrechen, danach nicht noch einmal", async ({ page, browserName }) => {
  await plantCrash(page, true);
  await ready(page);
  const dialog = page.getByRole("dialog", { name: "Based didn’t close normally" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("crash-report-summary")).toHaveText("Session 2026-11-12 17:00–17:01 UTC · 1 freeze");
  await dialog.getByRole("button", { name: "Show report" }).click();
  const preview = dialog.getByTestId("crash-report-preview");
  await expect(preview).toContainText('"format": "based-crash-report"');
  await expect(preview).toContainText("boot: store ready");
  const text = await preview.textContent();
  expect(text).not.toContain("Geheimes");
  expect(text).not.toContain("Tagebuch");
  expect(text).not.toContain("userAgent");
  const json = JSON.parse(text!) as { kind: string; session: { freezes: number; endedNormally: boolean } };
  expect(json.kind).toBe("crash");
  expect(json.session).toMatchObject({ freezes: 1, endedNormally: false });

  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await dialog.getByRole("button", { name: "Copy report" }).click();
    await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"kind": "crash"');
  }
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Save as file…" }).click();
  expect((await download).suggestedFilename()).toMatch(/^based-crash-20261112T170000\.json$/);
  await expect(dialog.getByTestId("crash-report-saved")).toBeVisible();

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await ready(page);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("crash-report-prompt")).toHaveCount(0);
});

test("Checkliste: Hinweis und Settings-Abschnitt in drei Größen, hell und dunkel – im Fenster, ohne waagrechtes Rollen", async ({ page, browserName }) => {
  await plantCrash(page, true);
  // Escape in Settings beantwortet den Hinweis – für die Fotos in jedem Durchgang wieder anbieten.
  await page.addInitScript(() => localStorage.removeItem("based.feedback.handledSession"));
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await ready(page);
    const dialog = page.getByRole("dialog", { name: "Based didn’t close normally" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Show report" }).click();
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      expect(box.y + box.height).toBeLessThanOrEqual(h);
      // Aktionen bleiben bei offener Vorschau im Fenster sichtbar
      await expect(dialog.getByRole("button", { name: "Save as file…" })).toBeInViewport({ ratio: 1 });
      // Vorschau scrollt in sich, läuft nicht waagrecht heraus
      const pre = dialog.getByTestId("crash-report-preview");
      expect(await pre.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (browserName === "chromium") await page.screenshot({ path: join(screens, `web-crash-report-prompt-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 820 });
    await ready(page, "prefs-diagnostics");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const section = page.getByTestId("settings-section-diagnostics-crash");
    for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await section.scrollIntoViewIfNeeded();
      const box = (await section.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (browserName === "chromium") await page.screenshot({ path: join(screens, `web-settings-crash-reports-${theme}${w === 1280 ? "" : `-${w}`}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 820 });
  }
});
