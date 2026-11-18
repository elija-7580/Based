import { expect, test } from "@playwright/test";

// Elija 18.11.: Billing zeigt die Spenden von basednotes.app (GitHub Sponsors) und wann bezahlte Pläne kommen.

test("Billing: Spenden-Knöpfe öffnen GitHub Sponsors, Plan sagt gratis während der Beta", async ({ page, context }) => {
  await page.goto("/#prefs-billing");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("settings-page")).toHaveAttribute("data-page", "billing");
  await expect(page.getByText("Free · beta")).toBeVisible();
  await expect(page.getByText(/1,000 users/)).toBeVisible();

  // Abfangen statt echtes GitHub laden
  await context.route("https://github.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>sponsors</title>" }));
  const [monthly] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Sponsor on GitHub" }).click()]);
  expect(monthly.url()).toBe("https://github.com/sponsors/elija-7580");
  const [once] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Give once" }).click()]);
  expect(once.url()).toBe("https://github.com/sponsors/elija-7580?frequency=one-time");
  await expect(page.getByTestId("sponsor-failed")).toHaveCount(0);
});

test("Billing: Suche in den Einstellungen findet „Donate“", async ({ page }) => {
  await page.goto("/#prefs-appearance");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("Donate");
  await expect(page.getByTestId("settings-results").getByRole("button").first()).toContainText(/Support Based|Billing/);
});

for (const [w, h] of [[1280, 820], [900, 600], [1728, 1000]] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Foto: Billing ${w} × ${h} (${theme})`, async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "nur für Fotos");
      await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/#prefs-billing");
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await expect(page.getByRole("button", { name: "Sponsor on GitHub" })).toBeVisible();
      // Knöpfe bleiben neben dem Hinweis (nicht darunter nach links umgebrochen) – außer bei 900 × 600
      if (w !== 900) {
        const hint = await page.getByText(/Donations pay for the servers/).boundingBox();
        const btn = await page.getByRole("button", { name: "Sponsor on GitHub" }).boundingBox();
        expect(btn!.x).toBeGreaterThan(hint!.x + hint!.width / 2);
      }
      const suffix = w === 1280 ? "" : `-${w}`;
      await page.screenshot({ path: `../../docs/design/screens/web-settings-billing${suffix}-${theme}.png` });
    });
  }
}
