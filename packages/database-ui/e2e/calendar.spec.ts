import { expect, test, type Locator, type Page } from "@playwright/test";

// BSD-8: Kalender und Timeline auf der Testseite – 10.000 Zeilen flüssig (begrenzte DOM-Elemente, keine langen
// Frames beim Scrollen), Eintrag ziehen ändert das Datum (Beginn und Ende), Klick auf einen leeren Tag legt eine
// Zeile an, Balkenenden ziehen, Zeile ohne Datum auf die Achse legen.

interface ScrollStats { frames: number[]; maxFrame: number; long: number; p95: number; maxRows: number }

/** Scrollt `selector` in `steps` Frames (vertikal oder horizontal) und misst die Frame-Abstände. */
async function scrollAndMeasure(page: Page, selector: string, steps: number, pxPerFrame: number | undefined, axis: "y" | "x" = "y"): Promise<ScrollStats> {
  return page.evaluate(async ({ selector, steps, pxPerFrame, axis }) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
    const max = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    const start = axis === "y" ? el.scrollTop : el.scrollLeft;
    const frames: number[] = [];
    let maxRows = 0;
    let last = await raf();
    for (let i = 1; i <= steps; i++) {
      const pos = pxPerFrame ? Math.min(max, start + i * pxPerFrame) : (max * i) / steps;
      if (axis === "y") el.scrollTop = pos; else el.scrollLeft = pos;
      const now = await raf();
      frames.push(now - last);
      last = now;
      maxRows = Math.max(maxRows, document.querySelectorAll("[data-row-id]").length);
    }
    const sorted = [...frames].sort((a, b) => a - b);
    return { frames, maxFrame: sorted[sorted.length - 1]!, long: frames.filter((f) => f > 50).length, p95: sorted[Math.floor(sorted.length * 0.95)]!, maxRows };
  }, { selector, steps, pxPerFrame, axis });
}

/** Wie in database.spec.ts: Chromium streng, Headless-WebKit (Software-Rendering) mit mehr Spielraum. */
function expectSmooth(s: ScrollStats, browser: string, jumps = false) {
  if (browser === "webkit") {
    expect(s.long).toBeLessThanOrEqual(Math.ceil(s.frames.length * (jumps ? 0.3 : 0.15)));
    expect(s.p95).toBeLessThan(jumps ? 120 : 80);
  } else {
    expect(s.long).toBeLessThanOrEqual(jumps ? 6 : 3);
    if (!jumps) expect(s.maxFrame).toBeLessThan(150);
  }
}
const fmt = (s: ScrollStats) => `max ${s.maxFrame.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, >50 ms: ${s.long}/${s.frames.length}, DOM-Einträge ≤ ${s.maxRows}`;

/** Gespeichertes Datum einer Zeile (Swift-Sekunden) als lokales „YYYY-MM-DD“. */
const storedDay = (page: Page, row: string, prop = "due") => page.evaluate(([r, p]) => {
  const v = window.__store.blocks.get(r!)?.values?.[p!] as { date?: { _0: { start: number; end?: number } } } | undefined;
  const d = v?.date?._0;
  if (!d) return null;
  const f = (s: number) => { const j = new Date(978_307_200_000 + s * 1000); return `${j.getFullYear()}-${String(j.getMonth() + 1).padStart(2, "0")}-${String(j.getDate()).padStart(2, "0")}`; };
  return d.end === undefined ? f(d.start) : `${f(d.start)}..${f(d.end)}`;
}, [row, prop]);

/** Lokales „YYYY-MM-DD“ für heute + n Tage. */
const dayStr = (page: Page, n: number) => page.evaluate((n) => {
  const t = new Date(); const j = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
  return `${j.getFullYear()}-${String(j.getMonth() + 1).padStart(2, "0")}-${String(j.getDate()).padStart(2, "0")}`;
}, n);

/** Datum einer Zeile direkt im Store setzen (heute + from … heute + to). */
const setDue = (page: Page, row: string, from: number | null, to?: number) => page.evaluate(([r, a, b]) => {
  const t = new Date();
  const sw = (n: number) => (new Date(t.getFullYear(), t.getMonth(), t.getDate() + n).getTime() - 978_307_200_000) / 1000;
  window.__store.transact("Test", (tx) => tx.update(r as string, (blk) => {
    const values = { ...(blk.values ?? {}) } as Record<string, unknown>;
    if (a === null) delete values.due;
    else values.due = { date: { _0: b === undefined || b === null ? { start: sw(a as number), includeTime: false } : { start: sw(a as number), end: sw(b as number), includeTime: false } } };
    blk.values = values as never;
  }));
}, [row, from, to ?? null] as const);

/** Mit der Maus von `from` (Mitte bzw. Versatz) nach (x, y) ziehen – Zeiger-Ereignisse wie bei echter Bedienung. */
async function dragTo(page: Page, from: Locator, x: number, y: number, offset?: { x: number; y: number }) {
  const b = (await from.boundingBox())!;
  const sx = b.x + (offset?.x ?? b.width / 2), sy = b.y + (offset?.y ?? b.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 6, sy + 2, { steps: 2 });
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}
const center = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; };

test.describe("10.000 Zeilen: Kalender und Timeline", () => {
  test("Kalender (Monat): Wochen virtualisiert, „+N more“, flüssiges Scrollen über Jahre", async ({ page }, info) => {
    await page.goto("/?view=v-cal&weekStart=1");
    const cal = page.getByTestId("calendar");
    await expect(cal).toBeVisible();
    await expect(page.getByLabel("Pages in view")).toHaveText("10,000");
    await expect(cal.locator(".dbui-cal-entry").first()).toBeVisible();
    const initial = await page.locator("[data-row-id]").count();
    expect(initial).toBeGreaterThan(10);
    expect(initial).toBeLessThan(200);
    expect(await page.locator(".dbui-cal-week").count()).toBeLessThan(14);
    // Wochenbeginn Montag (Einstellung), heute markiert
    await expect(page.locator(".dbui-cal-weekdays > span").first()).toHaveText("Mon");
    await expect(page.locator(".dbui-cal-day.today")).toHaveCount(1);

    // „+N more“ öffnet die (virtualisierte) Liste des Tages
    const more = cal.locator(".dbui-cal-more").first();
    const n = Number((await more.textContent())!.match(/\d+/)![0]);
    await more.click();
    const dlg = page.getByRole("dialog").filter({ has: page.getByRole("list", { name: "Pages on this day" }) });
    await expect(dlg).toBeVisible();
    const items = dlg.locator("[data-list-row-id]");
    expect(await items.count()).toBeLessThan(40);
    const total = Number((await dlg.locator(".dbui-menu-heading").textContent())!.match(/(\d+)\s*$/)![1]);
    expect(total).toBeGreaterThan(n); // sichtbare Spuren + n weitere
    await page.keyboard.press("Escape");

    const sel = "[data-testid=calendar-scroll]";
    const smooth = await scrollAndMeasure(page, sel, 180, 40);
    const jumps = await scrollAndMeasure(page, sel, 60, undefined);
    info.annotations.push({ type: "Kalender sanft", description: fmt(smooth) }, { type: "Kalender Sprünge", description: fmt(jumps) });
    console.log(`[${info.project.name}] Kalender sanft: ${fmt(smooth)} | Sprünge: ${fmt(jumps)}`);
    expect(smooth.maxRows).toBeLessThan(250);
    expect(jumps.maxRows).toBeLessThan(250);
    expectSmooth(smooth, info.project.name);
    expectSmooth(jumps, info.project.name, true);

    // Today springt zurück, Woche zeigt eine Woche mit virtualisierten Spuren
    await page.getByRole("button", { name: "Today" }).click();
    await expect(page.locator(".dbui-cal-day.today")).toBeVisible();
    await page.getByRole("radio", { name: "Week" }).click();
    await expect(cal).toHaveAttribute("data-mode", "week");
    await expect(page.locator(".dbui-cal-day.today")).toBeVisible();
    expect(await page.locator("[data-row-id]").count()).toBeLessThan(400);
    const week = await scrollAndMeasure(page, sel, 120, 40);
    console.log(`[${info.project.name}] Kalender Woche: ${fmt(week)}`);
    expect(week.maxRows).toBeLessThan(400);
    expectSmooth(week, info.project.name);
  });

  test("Timeline: Zeilen und Balken virtualisiert, flüssig in beide Richtungen", async ({ page }, info) => {
    await page.goto("/?view=v-timeline&weekStart=1");
    const tl = page.getByTestId("timeline");
    await expect(tl).toBeVisible();
    await expect(page.locator(".dbui-tl-row").first()).toBeVisible();
    expect(await page.locator(".dbui-tl-row").count()).toBeLessThan(60);
    // 1.000 Zeilen ohne Datum in der Seitenleiste, ebenfalls virtualisiert
    await expect(page.getByRole("complementary", { name: "No date" }).locator(".dbui-count")).toHaveText("1,000");
    expect(await page.locator("[data-undated-id]").count()).toBeLessThan(40);

    const sel = "[data-testid=timeline-scroll]";
    const down = await scrollAndMeasure(page, sel, 180, 60);
    const downJumps = await scrollAndMeasure(page, sel, 60, undefined);
    await page.locator(sel).evaluate((el) => { el.scrollTop = el.scrollHeight / 2; el.scrollLeft = 0; });
    const side = await scrollAndMeasure(page, sel, 120, 40, "x");
    info.annotations.push({ type: "Timeline vertikal", description: fmt(down) }, { type: "Timeline horizontal", description: fmt(side) });
    console.log(`[${info.project.name}] Timeline vertikal: ${fmt(down)} | Sprünge: ${fmt(downJumps)} | horizontal: ${fmt(side)}`);
    for (const s of [down, downJumps, side]) expect(s.maxRows).toBeLessThan(80);
    expectSmooth(down, info.project.name);
    expectSmooth(downJumps, info.project.name, true);
    expectSmooth(side, info.project.name);
    expect(await page.locator(".dbui-tl-minor").count()).toBeLessThan(120);

    // Zoom-Stufen und Tabelle links
    for (const z of ["Day", "Month", "Quarter", "Week"]) {
      await page.getByRole("radio", { name: z, exact: true }).click();
      await expect(tl).toHaveAttribute("data-scale", z.toLowerCase());
      expect(await page.locator(".dbui-tl-minor").count()).toBeLessThan(120);
    }
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.locator(".dbui-tl-colhead", { hasText: "Name" })).toBeVisible();
    expect(await page.evaluate(() => window.__store.views.get("v-timeline")?.timelineShowTable)).toBe(true);
  });
});

test.describe("Kalender bearbeiten (kleine Datenbank)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?rows=40&view=v-cal&weekStart=1");
    await expect(page.getByTestId("calendar")).toBeVisible();
  });

  test("Eintrag ziehen verschiebt das Datum; mehrtägig behält die Dauer; Undo", async ({ page }) => {
    await setDue(page, "row-1", 0);
    await setDue(page, "row-2", 1, 3);
    await page.locator(".dbui-cal-day.today").evaluate((el) => el.scrollIntoView({ block: "start" }));
    const entry = page.locator(".dbui-cal-entry[data-row-id='row-1']");
    await expect(entry).toBeVisible();
    const today = Number(await page.locator(".dbui-cal-day.today").getAttribute("data-day"));
    // auf den übernächsten Tag ziehen
    const target = await center(page.locator(`.dbui-cal-day[data-day='${today + 2}']`));
    await dragTo(page, entry, target.x, target.b.y + target.b.height - 10);
    expect(await storedDay(page, "row-1")).toBe(await dayStr(page, 2));
    await expect(page.getByTestId("opened")).toHaveText(""); // Ziehen öffnet die Seite nicht

    // Zeitraum (3 Tage): am zweiten Tag greifen, eine Woche später ablegen → Beginn und Ende +7
    const multi = page.locator(".dbui-cal-entry[data-row-id='row-2']").first();
    const day2 = await center(page.locator(`.dbui-cal-day[data-day='${today + 2}']`));
    const mb = (await multi.boundingBox())!;
    const grabX = day2.x, grabY = mb.y + mb.height / 2;
    const to = await center(page.locator(`.dbui-cal-day[data-day='${today + 9}']`));
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX + 6, grabY + 2, { steps: 2 });
    await page.mouse.move(to.x, to.b.y + to.b.height - 10, { steps: 10 });
    await page.mouse.up();
    expect(await storedDay(page, "row-2")).toBe(`${await dayStr(page, 8)}..${await dayStr(page, 10)}`);
    await page.evaluate(() => window.__store.undo());
    expect(await storedDay(page, "row-2")).toBe(`${await dayStr(page, 1)}..${await dayStr(page, 3)}`);

    // Tastatur: Alt+→ verschiebt um einen Tag; Klick öffnet
    await page.locator(".dbui-cal-entry[data-row-id='row-1']").focus();
    await page.keyboard.press("Alt+ArrowRight");
    expect(await storedDay(page, "row-1")).toBe(await dayStr(page, 3));
    await page.locator(".dbui-cal-entry[data-row-id='row-1']").click();
    await expect(page.getByTestId("opened")).toHaveText("Opened row-1");
  });

  test("Klick auf einen leeren Tag legt eine Zeile mit diesem Datum an", async ({ page }) => {
    const today = Number(await page.locator(".dbui-cal-day.today").getAttribute("data-day"));
    const cell = page.locator(`.dbui-cal-day[data-day='${today + 1}']`);
    const c = await center(cell);
    await page.mouse.click(c.x, c.b.y + c.b.height - 8);
    await expect(page.getByLabel("Pages in view")).toHaveText("41");
    const id = await page.evaluate(() => window.__opened[window.__opened.length - 1]!);
    expect(id).toBeTruthy();
    expect(await storedDay(page, id)).toBe(await dayStr(page, 1));
    await expect(page.locator(`.dbui-cal-entry[data-row-id='${id}']`)).toBeVisible();
    // „+“ im Tageskopf ebenso
    await cell.hover();
    await cell.getByRole("button", { name: /New page on/ }).click();
    await expect(page.getByLabel("Pages in view")).toHaveText("42");
    // „New“ in der Werkzeugleiste: heute
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByLabel("Pages in view")).toHaveText("43");
    const last = await page.evaluate(() => window.__opened[window.__opened.length - 1]!);
    expect(await storedDay(page, last)).toBe(await dayStr(page, 0));
  });

  test("Wochenbeginn Sonntag, Blättern, Zeilen ohne Datum", async ({ page }) => {
    await page.goto("/?rows=40&view=v-cal&weekStart=0");
    await expect(page.locator(".dbui-cal-weekdays > span").first()).toHaveText("Sun");
    const title = page.getByTestId("calendar-title");
    const before = await title.textContent();
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(title).not.toHaveText(before!);
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(title).toHaveText(before!);
    await page.getByRole("button", { name: "No date (4)" }).click();
    await expect(page.getByRole("list", { name: "Pages without a date" }).locator("[data-list-row-id]")).toHaveCount(4);
  });
});

test.describe("Timeline bearbeiten (kleine Datenbank)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?rows=40&view=v-timeline&weekStart=1");
    await expect(page.getByTestId("timeline")).toBeVisible();
    await page.getByRole("radio", { name: "Day", exact: true }).click(); // 40 px je Tag
    await setDue(page, "row-0", 0, 2);
    await page.getByRole("button", { name: "Today" }).click();
  });

  /** x-Mitte des Tages heute + n auf der Achse. */
  const dayX = (page: Page, n: number) => page.evaluate((n) => {
    const el = document.querySelector<HTMLElement>("[data-testid=timeline-scroll]")!;
    const today = el.querySelector<HTMLElement>(".dbui-tl-today")!;
    const r = today.getBoundingClientRect();
    return r.left + r.width / 2 + n * 40;
  }, n);

  test("Balken verschieben, Ende und Beginn ziehen", async ({ page }) => {
    const bar = page.locator(".dbui-tl-bar[data-row-id='row-0']");
    await expect(bar).toBeVisible();
    const b = (await bar.boundingBox())!;
    expect(Math.round(b.width)).toBe(120); // 3 Tage à 40 px
    // Ende um 2 Tage nach rechts
    const end = bar.getByTestId("bar-end");
    await dragTo(page, end, await dayX(page, 4), b.y + b.height / 2);
    expect(await storedDay(page, "row-0")).toBe(`${await dayStr(page, 0)}..${await dayStr(page, 4)}`);
    // Beginn einen Tag nach links
    await dragTo(page, bar.getByTestId("bar-start"), await dayX(page, -1), b.y + b.height / 2);
    expect(await storedDay(page, "row-0")).toBe(`${await dayStr(page, -1)}..${await dayStr(page, 4)}`);
    // Ganzen Balken 3 Tage nach rechts (Dauer bleibt)
    const mid = await center(bar);
    await dragTo(page, bar, mid.x + 120, mid.y);
    expect(await storedDay(page, "row-0")).toBe(`${await dayStr(page, 2)}..${await dayStr(page, 7)}`);
    await page.evaluate(() => window.__store.undo());
    expect(await storedDay(page, "row-0")).toBe(`${await dayStr(page, -1)}..${await dayStr(page, 4)}`);
    await expect(page.getByTestId("opened")).toHaveText("");
    await bar.click();
    await expect(page.getByTestId("opened")).toHaveText("Opened row-0");
  });

  test("Zeile ohne Datum auf die Achse ziehen gibt ihr ein Datum", async ({ page }) => {
    const item = page.locator("[data-undated-id='row-9']");
    await expect(item).toBeVisible();
    const row = await center(page.locator(".dbui-tl-row").first());
    await dragTo(page, item, await dayX(page, 5), row.y);
    expect(await storedDay(page, "row-9")).toBe(await dayStr(page, 5)); // Tag-Zoom: ein Tag
    await expect(page.locator("[data-undated-id='row-9']")).toHaveCount(0);
    await expect(page.locator(".dbui-tl-bar[data-row-id='row-9']")).toBeVisible();
  });
});
