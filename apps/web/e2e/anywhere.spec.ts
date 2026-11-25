// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";

// „Write anywhere“ (Mac-App): das kleine Fenster, hier ohne Hülle – eine Brücke aus dem Test liefert, was die Hülle
// beim Tastendruck gelesen hätte, und nimmt Anfrage, Einfügen und Ausblenden entgegen.
const SHOTS = "../../docs/design/screens/";

interface Calls { asks: { instruction: string; context: { app: string } }[]; inserted: string[]; hidden: number; cancelled: number }

async function open(page: Page, theme: "light" | "dark", context: Record<string, unknown>) {
  await page.addInitScript(({ theme, context }) => {
    localStorage.setItem("based.appearance", JSON.stringify({ theme, style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false }));
    const calls = { asks: [] as unknown[], inserted: [] as string[], hidden: 0, cancelled: 0 };
    let answer: ((a: unknown) => void) | undefined;
    const g = globalThis as Record<string, unknown>;
    g.__anywhereCalls = calls;
    g.__anywhereAnswer = (a: unknown) => answer?.(a);
    g.__basedAnywhereBridge = {
      context: async () => context,
      ask: async (a: unknown) => { calls.asks.push(a); },
      cancel: async () => { calls.cancelled += 1; },
      insert: async (text: string) => { calls.inserted.push(text); return true; },
      copy: async () => undefined,
      hide: async () => { calls.hidden += 1; },
      onOpen: async () => () => undefined,
      onAnswer: async (fn: (a: unknown) => void) => { answer = fn; return () => undefined; },
    };
  }, { theme, context });
  await page.setViewportSize({ width: 600, height: 340 });
  await page.goto("/?window=anywhere");
  await expect(page.getByTestId("anywhere-panel")).toBeVisible();
}

const calls = (page: Page) => page.evaluate(() => (globalThis as unknown as { __anywhereCalls: Calls }).__anywhereCalls);
const answer = (page: Page, a: { text?: string; error?: string }) => page.evaluate((a) => {
  const g = globalThis as unknown as { __anywhereCalls: { asks: { id: string }[] }; __anywhereAnswer(a: unknown): void };
  g.__anywhereAnswer({ id: g.__anywhereCalls.asks.at(-1)!.id, ...a });
}, a);

for (const theme of ["light", "dark"] as const) {
  test(`write anywhere: ask, see the result, insert (${theme})`, async ({ page }) => {
    await open(page, theme, { app: "Mail", title: "Re: Friday", text: "Can we meet on Friday?", selection: "", secure: false });
    const panel = page.getByTestId("anywhere-panel");
    await expect(panel).toContainText("Mail · Re: Friday");
    const field = page.getByRole("textbox", { name: "What should Based write?" });
    await expect(field).toBeFocused();
    // Schnellwahl passt zu dem, was gelesen wurde: Feldtext ohne Markierung.
    await expect(panel.getByRole("button", { name: "Reply" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Improve" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}anywhere-ask-${theme}.png` });
    await field.fill("Say yes, 10 am works");
    await field.press("Enter");
    await expect(panel).toHaveAttribute("data-phase", "writing");
    await expect(panel.getByText("Writing…")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}anywhere-writing-${theme}.png` });
    expect((await calls(page)).asks[0]).toMatchObject({ instruction: "Say yes, 10 am works", context: { app: "Mail" } });
    await answer(page, { text: "Friday at 10 works for me. See you then!" });
    await expect(page.getByTestId("anywhere-result")).toHaveText("Friday at 10 works for me. See you then!");
    await page.screenshot({ path: `${SHOTS}anywhere-result-${theme}.png` });
    // Enter fügt ein.
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await calls(page)).inserted).toEqual(["Friday at 10 works for me. See you then!"]);
  });
}

test("write anywhere: errors are said, Stop cancels, Esc hides, a password field is never read", async ({ page }) => {
  await open(page, "light", { app: "Safari", title: "", text: "", selection: "", secure: true });
  const panel = page.getByTestId("anywhere-panel");
  await expect(panel).toContainText("Password field: Based read nothing.");
  await expect(panel.getByRole("button", { name: "Reply" })).toHaveCount(0);
  const field = page.getByRole("textbox", { name: "What should Based write?" });
  await field.fill("A short greeting");
  await field.press("Enter");
  await panel.getByRole("button", { name: "Stop" }).click();
  await expect(panel).toHaveAttribute("data-phase", "ask");
  expect((await calls(page)).cancelled).toBe(1);
  await field.press("Enter");
  await answer(page, { error: "No model is set up. Add a provider and a model in Settings → Agents & AI." });
  await expect(panel.getByRole("alert")).toContainText("No model is set up.");
  await page.screenshot({ path: `${SHOTS}anywhere-error-light.png` });
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await calls(page)).hidden).toBe(1);
});

test("write anywhere: a selection offers Improve and Shorter", async ({ page }) => {
  await open(page, "light", { app: "Notes", title: "Draft", text: "Whole text here", selection: "Whole text", secure: false });
  const panel = page.getByTestId("anywhere-panel");
  await expect(panel.getByRole("button", { name: "Improve" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Reply" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Shorter" }).click();
  expect((await calls(page)).asks[0]!.instruction).toContain("shorter");
});
