import { expect, test } from "@playwright/test";

test("leere Web-App lädt", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Based" })).toBeVisible();
});
