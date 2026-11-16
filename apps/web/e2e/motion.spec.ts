import { expect, test, type Page } from "@playwright/test";

// BSD-417 Teil 1: Bewegung. Ohne Einstellung blenden Quick Find und Dialoge mit den Motion-Tokens ein (180 ms,
// ease-out); mit „Bewegung reduzieren“ des Systems läuft nirgends eine Animation oder ein Übergang – auch nicht beim
// Öffnen und Schließen von Quick Find, Dialogen und Menüs –, und alles öffnet und schließt trotzdem.

/** Laufende Animationen und Übergänge im Dokument (Web Animations API, auch CSS). */
const running = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => {
  const t = a.effect instanceof KeyframeEffect ? a.effect.target : null;
  return `${a.constructor.name}:${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? ""}@${t instanceof Element ? t.className.toString().slice(0, 40) : "?"}`;
}));

async function ready(page: Page) {
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
}

test("Einblenden nutzt die Motion-Tokens (Quick Find)", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.keyboard.press("ControlOrMeta+k");
  const timing = await page.locator(".qf").first().evaluate((el) => el.getAnimations().map((a) => {
    const e = a.effect as KeyframeEffect;
    // CSS-Animationen tragen die Kurve an den Keyframes, nicht am Timing
    return { duration: e.getTiming().duration, easing: String(e.getKeyframes()[0]?.easing ?? e.getTiming().easing) };
  }));
  expect(timing.length).toBeGreaterThan(0);
  expect(timing[0]!.duration).toBe(180);
  expect(timing[0]!.easing.replace(/\s/g, "")).toBe("cubic-bezier(0.2,0,0,1)");
});

test.describe("Bewegung reduzieren", () => {
  test.use({ reducedMotion: "reduce" });

  test("keine Animation und kein Übergang beim Öffnen und Schließen", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const found: string[] = [];
    const look = async (where: string) => { for (const a of await running(page)) found.push(`${where}: ${a}`); };
    await look("Home");
    // Quick Find auf und zu
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Quick Find" })).toBeVisible();
    await look("Quick Find offen");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Quick Find" })).toHaveCount(0);
    // Überfahren in der Seitenleiste
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Search" }).first().hover();
    await look("Seitenleiste überfahren");
    // Design-Kit: Dialog und Menü (Astryx) öffnen und schließen trotzdem
    await page.goto("/#prefs-kit");
    const kit = page.getByTestId("astryx-kit");
    await expect(kit).toBeVisible();
    await kit.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename page" });
    await expect(dialog).toBeVisible();
    await look("Dialog offen");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await kit.getByRole("button", { name: "Page menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
    await look("Menü offen");
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await expect(page.getByTestId("kit-picked")).toHaveText("Last menu choice: Duplicate");
    expect(found).toEqual([]);
  });
});
