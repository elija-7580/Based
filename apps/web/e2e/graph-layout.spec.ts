import { expect, test, type Page } from "@playwright/test";

// BSD-262 Teil 1: der Graph merkt sich sein Layout – erneutes Öffnen (und Neuladen) zeigt sofort dasselbe Bild ohne
// Neuaufbau; „Re-layout“ fängt neu an.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
const command = <T,>(page: Page, c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c) as Promise<T>;
const openGraph = async (page: Page) => {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
};
const pos = (page: Page, id: string) => page.getByTestId("graph-canvas").evaluate((el, i) => (el as unknown as { __basedGraph: { layoutPosition(id: string): { x: number; y: number } | undefined } }).__basedGraph.layoutPosition(i), id);

test("Layout bleibt beim erneuten Öffnen und nach dem Neuladen gleich; Re-layout baut neu auf", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const a = await command<string>(page, { op: "createPage", title: "Hub" });
  for (const t of ["Leaf one", "Leaf two", "Leaf three"]) await command(page, { op: "createPage", parent: a, title: t });
  await openGraph(page);
  const canvas = page.getByTestId("graph-canvas");
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 20_000 });
  const first = await pos(page, a);
  expect(first).toBeTruthy();

  // weg und wieder hin: sofort ruhend, gleiche Lage
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home" }).click();
  await openGraph(page);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 2000 });
  const again = await pos(page, a);
  expect(Math.abs(again!.x - first!.x)).toBeLessThan(0.5);
  expect(Math.abs(again!.y - first!.y)).toBeLessThan(0.5);

  if (browserName === "chromium") {
    await page.reload();
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 5000 });
    const reloaded = await pos(page, a);
    expect(Math.abs(reloaded!.x - first!.x)).toBeLessThan(0.5);
  }

  // Re-layout: neu aufbauen (läuft wieder, kommt zur Ruhe)
  await page.getByRole("button", { name: "Re-layout" }).click();
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 20_000 });
});
