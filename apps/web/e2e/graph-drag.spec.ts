// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";

// Ruhiges Ziehen im Graph: der gezogene Knoten bleibt unter dem Zeiger, nur seine Umgebung folgt, entfernte Seiten
// bleiben stehen, und nach dem Loslassen bleibt der Knoten liegen, wo er abgelegt wurde.

type Client = { command: (c: Record<string, unknown>) => Promise<unknown> };
type Probe = { __basedGraph: { position(id: string): { x: number; y: number } | undefined; layoutPosition(id: string): { x: number; y: number } | undefined } };
const command = <T,>(page: Page, c: Record<string, unknown>) => page.evaluate((cmd) => (globalThis as unknown as { __based: { client: Client } }).__based.client.command(cmd), c) as Promise<T>;
const screenPos = (page: Page, id: string) => page.getByTestId("graph-canvas").evaluate((el, i) => (el as unknown as Probe).__basedGraph.position(i), id);
const layoutPos = (page: Page, id: string) => page.getByTestId("graph-canvas").evaluate((el, i) => (el as unknown as Probe).__basedGraph.layoutPosition(i), id);

test("Knoten ziehen: Umgebung folgt, der Rest bleibt stehen, der Knoten bleibt liegen", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  // Kette aus sechs Seiten: Ende → … → Anfang; dazu eine Seite ganz ohne Verbindung zur Kette
  const chain: string[] = [];
  for (let i = 0; i < 6; i++) chain.push(await command<string>(page, { op: "createPage", title: "Link " + i, ...(i > 0 ? { parent: chain[i - 1] } : {}) }));
  const lonely = await command<string>(page, { op: "createPage", title: "Lonely" });
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
  const canvas = page.getByTestId("graph-canvas");
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes")), { timeout: 15_000 }).toBeGreaterThanOrEqual(7);
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 20_000 });

  const tip = chain[5]!, next = chain[4]!, far = chain[0]!;
  const box = (await canvas.boundingBox())!;
  const start = (await screenPos(page, tip))!;
  const before = { tip: (await layoutPos(page, tip))!, next: (await layoutPos(page, next))!, far: (await layoutPos(page, far))!, lonely: (await layoutPos(page, lonely))! };
  const from = { x: box.x + start.x, y: box.y + start.y };
  // vom anderen Ende der Kette weg ziehen (wer dem Knoten im Weg liegt, weicht aus – das soll hier nicht mitspielen),
  // in kleinen Schritten wie eine Hand
  const farScreen = (await screenPos(page, far))!;
  const away = Math.hypot(start.x - farScreen.x, start.y - farScreen.y) || 1;
  const ux = (start.x - farScreen.x) / away, uy = (start.y - farScreen.y) / away;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(from.x + ux * i * 5, from.y + uy * i * 5);
    await page.waitForTimeout(16);
  }
  const target = { x: start.x + ux * 120, y: start.y + uy * 120 };
  // der Knoten liegt unter dem Zeiger (kein Hinterherhinken, kein Zittern)
  const held = (await screenPos(page, tip))!;
  expect(Math.hypot(held.x - target.x, held.y - target.y)).toBeLessThan(1.5);
  await expect(canvas).not.toHaveAttribute("data-settled", "");
  await page.mouse.up();
  // kommt schnell zur Ruhe
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 4000 });
  const dropped = (await layoutPos(page, tip))!;
  const after = { tip: (await screenPos(page, tip))!, next: (await layoutPos(page, next))!, far: (await layoutPos(page, far))!, lonely: (await layoutPos(page, lonely))! };
  // der Knoten bleibt, wo er abgelegt wurde; der Nachbar ist gefolgt; weit Entferntes hat sich nicht bewegt
  expect(Math.hypot(after.tip.x - target.x, after.tip.y - target.y)).toBeLessThan(1.5);
  expect(Math.hypot(after.next.x - before.next.x, after.next.y - before.next.y)).toBeGreaterThan(5);
  expect(Math.hypot(after.far.x - before.far.x, after.far.y - before.far.y)).toBeLessThan(0.01);
  // die Seite ohne Verbindung ebenso – außer der Knoten wurde in ihre Nähe gelegt (dann darf sie ausweichen)
  const near = (p: { x: number; y: number }) => Math.hypot(before.lonely.x - p.x, before.lonely.y - p.y) < 130;
  if (!near(before.tip) && !near(dropped)) expect(Math.hypot(after.lonely.x - before.lonely.x, after.lonely.y - before.lonely.y)).toBeLessThan(0.01);
  // die Seite wurde beim Ziehen nicht geöffnet
  await expect(canvas).toBeVisible();

  // wieder öffnen: das abgelegte Bild ist gemerkt
  const kept = (await layoutPos(page, tip))!;
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Home" }).click();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Library" }).click();
  await page.getByRole("radiogroup", { name: "Library view" }).getByRole("radio", { name: "Graph" }).click();
  await expect(canvas).toHaveAttribute("data-settled", "", { timeout: 2000 });
  const again = (await layoutPos(page, tip))!;
  expect(Math.hypot(again.x - kept.x, again.y - kept.y)).toBeLessThan(0.5);
});
