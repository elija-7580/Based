// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test } from "@playwright/test";
import { writeZip } from "@based/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectFaster } from "./perf.js";

// BSD-665: Großer Import ohne Hänger am Ende. Die fertige Nutzlast ging früher als Objektbaum vom Import-Worker über
// den Hauptthread zum Store-Worker (zweimal geklont im Hauptthread: 3 000 Seiten 296 ms, 10 000 Seiten 1 140 ms am
// Stück). Jetzt sind die Records ein übertragener Puffer. Gemessen wird wie im Tester-Weg (Einstellungen → Import),
// die längste Aufgabe im Hauptthread (Long Tasks) vom Wählen der Datei bis zur Zusammenfassung.

const PAGES = 3_000;
const PARAGRAPHS = 20;

function notionExport(): Buffer {
  const hex = (i: number) => i.toString(16).padStart(32, "0");
  const uuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const enc = new TextEncoder();
  const files = [];
  for (let i = 1; i <= PAGES; i++) {
    const h = hex(0xb5d665_000000 + i);
    const body = Array.from({ length: PARAGRAPHS }, (_, j) => `<p>Absatz ${j + 1} auf Seite ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`).join("");
    const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>Page ${i}</title></head><body><article id="${uuid(h)}" class="page sans"><header><h1 class="page-title">Page ${i}</h1></header><div class="page-body">${body}</div></article></body></html>`;
    files.push({ path: `Export/Page ${i} ${h}.html`, data: enc.encode(html) });
  }
  return Buffer.from(writeZip(files));
}

test(`BSD-665 ${PAGES.toLocaleString("de")} Notion-Seiten importieren: keine lange Aufgabe im Hauptthread`, { tag: "@perf" }, async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Long Tasks nur in Chromium");
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), "based-import-perf-"));
  const file = join(dir, "Export-big.zip");
  writeFileSync(file, notionExport());
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Import" }).click();
  await page.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import" });
  await page.evaluate(() => {
    const w = globalThis as unknown as { __longest: number };
    w.__longest = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__longest = Math.max(w.__longest, e.duration); }).observe({ type: "longtask" });
  });
  const t0 = Date.now();
  // Als Pfad, nicht als Puffer: sonst dekodiert Playwright die Bytes selbst im Hauptthread (atob, ~150 ms Long Task).
  await dialog.getByLabel("Choose files to import").setInputFiles(file);
  const summary = dialog.getByTestId("import-summary");
  try {
    await expect(summary).toBeVisible({ timeout: 150_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const total = Date.now() - t0;
  await expect(summary).toContainText(`Imported ${PAGES} pages`);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  const longest = await page.evaluate(() => (globalThis as unknown as { __longest: number }).__longest);

  info.annotations.push({ type: "BSD-665", description: `${PAGES} Seiten: Import ${total} ms, längste Aufgabe ${Math.round(longest)} ms` });
  console.info(`BSD-665 ${PAGES} Seiten: Import ${total} ms, längste Aufgabe im Hauptthread ${Math.round(longest)} ms`);
  expectFaster(info, "Import 3 000 Seiten (längste Aufgabe)", longest, 200);
});
