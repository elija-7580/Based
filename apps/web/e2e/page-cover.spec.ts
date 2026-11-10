import { expect, test, type Page } from "@playwright/test";

// BSD-201 Teil 2: Cover (Farbe, Bild hochladen, verschieben, entfernen) und Bild als Seiten-Icon.

// 2×2-PNG (rot), damit kein Netz nötig ist.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

async function newPage(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page.getByLabel("Page title")).toBeVisible();
}

test("Cover: Farbe, Bild hochladen, verschieben, entfernen", async ({ page }) => {
  await newPage(page);
  await page.locator(".page-head").hover();
  await page.getByRole("button", { name: "Add cover" }).click();
  await page.getByTestId("cover-picker").getByRole("button", { name: "Blue" }).click();
  const cover = page.getByTestId("page-cover");
  await expect(cover).toBeVisible();
  await expect(cover).toHaveAttribute("style", /status-ready/);

  await cover.hover();
  await cover.getByRole("button", { name: "Change cover" }).click();
  await page.getByTestId("cover-file").setInputFiles({ name: "red.png", mimeType: "image/png", buffer: PNG });
  const img = cover.locator("img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("style", /center 50/);

  await cover.hover();
  const btn = cover.getByRole("button", { name: "Reposition" });
  const b = (await btn.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  await expect(img).not.toHaveAttribute("style", /center 50/);

  await cover.hover();
  await cover.getByRole("button", { name: "Change cover" }).click();
  await page.getByTestId("cover-picker").getByRole("button", { name: "Remove cover" }).click();
  await expect(cover).toHaveCount(0);
});

test("Bild als Seiten-Icon hochladen", async ({ page }) => {
  await newPage(page);
  await page.locator(".page-head").hover();
  await page.getByRole("button", { name: "Add icon" }).click();
  await page.getByTestId("icon-file").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByTestId("page-icon-image")).toBeVisible();
});
