import { expect, test } from "@playwright/test";

// BSD-374: Eine laufende Scroll-Geste bleibt am Bereich, in dem sie begann. Kommt der Zeiger beim Rollen über ein
// Feld mit eigenem Scrollbereich, rollt die Einstellungsseite weiter; erst eine neue Geste rollt das innere Feld.

test("Einstellungen: inneres Feld fängt laufendes Scrollen nicht ab, neue Geste rollt es", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  // Unter Last (CI, zwei Browser) liegen zwischen zwei Rad-Ereignissen des Tests mehr als 150 ms – Pause verlängern.
  // BSD-653: gemessen in WebKit unter Last: das erste Rad-Ereignis nach page.mouse.move kommt bis zu ~1 s später an
  // (Zeitstempel im Ereignis), die Geste galt dann als beendet. Darum 2 s, und die Pause für die neue Geste länger.
  await page.addInitScript(() => { (globalThis as { __basedWheelLatchMs?: number }).__basedWheelLatchMs = 2000; });
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
  // BSD-653: page.mouse.wheel wartet in WebKit nicht, bis die Seite das Ereignis verarbeitet hat. Unter Last kam das erste
  // Rad-Ereignis erst nach der Mausbewegung an (die Geste begann dann im Feld) oder das letzte erst nach dem Messen.
  // Darum auf die Wirkung jedes Abschnitts warten statt auf „die Seite steht“.
  const outerAt = () => scroller.evaluate((el) => el.scrollTop);
  await page.mouse.move(innerBox.x + 40, Math.max(120, innerBox.y - 60));
  await page.mouse.wheel(0, 40);
  // schnell nachsehen (nicht im Takt von expect.poll): die Pause bis zum nächsten Schritt muss kürzer als die Latch-Pause bleiben
  await expect.poll(outerAt, { intervals: [10] }).toBe(40);
  // … und läuft weiter, während das Feld unter den Zeiger kommt
  await page.mouse.move(innerBox.x + 40, innerBox.y + 40);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 40); await page.waitForTimeout(30); }
  // alle neun Schritte rollen die Seite (auch weiches Nachrollen in WebKit ist dann fertig), keiner das Feld
  await expect.poll(outerAt).toBe(9 * 40);
  expect(await inner.evaluate((el) => el.scrollTop)).toBe(0);
  const outerTop = await outerAt();
  // Pause → neue Geste über dem Feld rollt das Feld
  await page.waitForTimeout(2400);
  const now = (await inner.boundingBox())!;
  await page.mouse.move(now.x + 40, now.y + 40);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => inner.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(outerTop);
});
