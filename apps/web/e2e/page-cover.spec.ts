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

  // Wie Notion: Klick auf „Reposition“ → Bild ziehen → Cancel verwirft, Save position speichert.
  const dragCover = async () => {
    const c = (await cover.boundingBox())!;
    await page.mouse.move(c.x + c.width / 3, c.y + c.height / 3);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 3, c.y + c.height / 3 + 60, { steps: 5 });
    await page.mouse.up();
  };
  await cover.hover();
  await cover.getByRole("button", { name: "Reposition" }).click();
  await expect(cover.getByText(/Drag image to reposition/)).toBeVisible();
  await dragCover();
  await expect(img).not.toHaveAttribute("style", /center 50/);
  await cover.getByRole("button", { name: "Cancel" }).click();
  await expect(img).toHaveAttribute("style", /center 50/);

  await cover.hover();
  await cover.getByRole("button", { name: "Reposition" }).click();
  await dragCover();
  await cover.getByRole("button", { name: "Save position" }).click();
  await expect(cover.getByText(/Drag image to reposition/)).toHaveCount(0);
  await expect(img).not.toHaveAttribute("style", /center 50/);
  const saved = await img.getAttribute("style");
  await page.keyboard.press("Escape");
  await expect(img).toHaveAttribute("style", saved!);

  // Höhe (Elija 11.11.): Griff an der Unterkante nur im Bearbeiten-Modus; Save speichert, Cancel verwirft.
  const before = (await cover.boundingBox())!.height;
  await expect(page.getByTestId("cover-resize")).toHaveCount(0);
  const dragHandle = async () => {
    const h = (await page.getByTestId("cover-resize").boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 120, { steps: 6 });
    await page.mouse.up();
  };
  await cover.hover();
  await cover.getByRole("button", { name: "Reposition" }).click();
  await dragHandle();
  await expect.poll(async () => (await cover.boundingBox())!.height).toBeGreaterThan(before + 60);
  await cover.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(async () => Math.round((await cover.boundingBox())!.height)).toBe(Math.round(before));
  await cover.hover();
  await cover.getByRole("button", { name: "Reposition" }).click();
  await dragHandle();
  await cover.getByRole("button", { name: "Save position" }).click();
  await expect(page.getByTestId("cover-resize")).toHaveCount(0);
  await expect.poll(async () => (await cover.boundingBox())!.height).toBeGreaterThan(before + 60);
  await cover.hover();
  await cover.getByRole("button", { name: "Reposition" }).click();
  const handle = page.getByTestId("cover-resize");
  await handle.dblclick();
  await cover.getByRole("button", { name: "Save position" }).click();
  await expect.poll(async () => Math.round((await cover.boundingBox())!.height)).toBe(Math.round(before));

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
