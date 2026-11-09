import { test } from "@playwright/test";
test("shot", async ({ page }) => {
  page.on("console", (m) => console.log("console:", m.type(), m.text()));
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto("/?reset=1");
  await page.waitForTimeout(800);
  await page.locator(".bn-block-content", { hasText: "Dritter" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/shot1.png", fullPage: true });
});
