import { expect, test, type Page } from "@playwright/test";

// BSD-398: Die Seitenleiste springt beim Auf- und Zuklappen nicht – vorher rollte sie zur aktiven Seite, sobald sich
// deren Zeilennummer verschob (Aufklappen oberhalb). Die angeklickte Zeile bleibt unter der Maus.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = (page: Page, c: Record<string, unknown>) =>
  page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c);

test("Aufklappen oberhalb der aktiven Seite: Liste bleibt stehen, Zeile bleibt unter der Maus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  // Eine Seite oben mit Unterseiten, darunter viele Seiten
  const parent = (await command(page, { op: "createPage", title: "AAA parent" })) as string;
  for (let i = 1; i <= 5; i++) await command(page, { op: "createPage", title: `Child ${i}`, parent });
  await command(page, { op: "seed", count: 300, prefix: "Seed" });
  const tree = page.getByRole("tree", { name: "Pages" });
  // Aktive Seite weit unten öffnen (die Liste rollt dorthin)
  const last = page.getByRole("treeitem").filter({ hasText: /^Seed/ }).last();
  await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await last.click();
  await expect(last).toHaveAttribute("aria-selected", "true").catch(() => undefined);
  // Nach oben rollen, die Elternseite aufklappen
  await tree.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  const row = page.getByRole("treeitem", { name: "AAA parent" });
  await expect(row).toBeVisible();
  const before = (await row.boundingBox())!;
  const top0 = await tree.evaluate((el) => el.scrollTop);
  await row.getByRole("button", { name: "Expand" }).click();
  await expect(page.getByRole("treeitem", { name: "Child 1" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await tree.evaluate((el) => el.scrollTop)).toBe(top0);
  expect(Math.abs((await row.boundingBox())!.y - before.y)).toBeLessThanOrEqual(1);
  // Zuklappen ebenso
  await row.getByRole("button", { name: "Collapse" }).click();
  await expect(page.getByRole("treeitem", { name: "Child 1" })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await tree.evaluate((el) => el.scrollTop)).toBe(top0);
});
