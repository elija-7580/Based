import { expect, test } from "@playwright/test";

// BSD-374: Eine laufende Scroll-Geste bleibt am Bereich, in dem sie begann. Kommt der Zeiger beim Rollen über ein
// Feld mit eigenem Scrollbereich, rollt die Einstellungsseite weiter; erst eine neue Geste rollt das innere Feld.

test("Einstellungen: inneres Feld fängt laufendes Scrollen nicht ab, neue Geste rollt es", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  // Unter Last (CI, zwei Browser) liegen zwischen zwei Rad-Ereignissen des Tests mehr als 150 ms – Pause verlängern.
  await page.addInitScript(() => { (globalThis as { __basedWheelLatchMs?: number }).__basedWheelLatchMs = 800; });
  await page.goto("/#prefs-diagnostics");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  // Ein Feld mit eigenem Scrollbereich mitten auf der Seite (wie das Log) und genug Höhe darunter.
  const outer = await page.evaluate(() => {
    const sec = document.querySelector("[data-testid=settings-section-diagnostics-status]")!;
    const box = document.createElement("div");
    box.id = "inner-scroll";
    box.style.cssText = "height: 160px; overflow: auto";
    box.innerHTML = Array.from({ length: 80 }, (_, i) => `<p>Line ${i + 1}</p>`).join("");
    sec.after(box);
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    box.after(spacer);
    let el: Element | null = box.parentElement;
    while (el && !(["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
    el?.setAttribute("data-outer-scroll", "");
    return !!el;
  });
  expect(outer).toBe(true);
  const inner = page.locator("#inner-scroll");
  const scroller = page.locator("[data-outer-scroll]");
  const innerBox = (await inner.boundingBox())!;
  // Geste beginnt oberhalb des Feldes …
  await page.mouse.move(innerBox.x + 40, Math.max(120, innerBox.y - 60));
  await page.mouse.wheel(0, 40);
  // … und läuft weiter, während das Feld unter den Zeiger kommt
  await page.mouse.move(innerBox.x + 40, innerBox.y + 40);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 40); await page.waitForTimeout(30); }
  // Weiches Nachrollen (WebKit) abwarten: erst messen, wenn die Seite steht
  let last = -1;
  await expect.poll(async () => { const now = await scroller.evaluate((el) => el.scrollTop); const still = now === last; last = now; return still; }, { intervals: [150] }).toBe(true);
  expect(await inner.evaluate((el) => el.scrollTop)).toBe(0);
  const outerTop = await scroller.evaluate((el) => el.scrollTop);
  expect(outerTop).toBeGreaterThan(200);
  // Pause → neue Geste über dem Feld rollt das Feld
  await page.waitForTimeout(1200);
  const now = (await inner.boundingBox())!;
  await page.mouse.move(now.x + 40, now.y + 40);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => inner.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(outerTop);
});
