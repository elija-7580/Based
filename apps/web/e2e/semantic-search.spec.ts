// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { expect, test, type Page } from "@playwright/test";

// BSD-580: Einstellungen → Connect AI apps → „Search by meaning“. Der Server ist ein Doppel (page.route) mit dem
// Verhalten von apps/server/src/brain-index.ts: aus → Download mit Fortschritt → Index wird aufgebaut → bereit → entfernt.
// Ohne Klick geht keine Anfrage an fremde Server und kein „download“ an den eigenen.

const SERVER = "http://127.0.0.1:58241";
const SHOTS = process.env.BASED_SCREENSHOTS === "1";
const SIZES = [{ w: 1280, h: 820 }, { w: 900, h: 600 }, { w: 1728, h: 1000 }] as const;

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

test("BSD-580: Search by meaning – ohne Server Hinweis, dann aus, Download, Index, bereit, entfernen", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  const MODEL = { id: "multilingual-e5-small", name: "Multilingual E5 small", license: "MIT", size: 135_000_000 };
  const s = { installed: false, downloading: false, loaded: 0, ready: false, pending: 0, pages: 0, sections: 0, bytes: 0, error: undefined as string | undefined };
  let phase: "hold" | "go" = "hold";
  const posts: unknown[] = [];
  const foreign: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (!["localhost", "127.0.0.1"].includes(u.hostname)) foreign.push(r.url()); });
  await page.route(`${SERVER}/local/brain**`, async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "POST") {
      const body = req.postDataJSON() as { action: string };
      posts.push(body);
      if (body.action === "download") { s.downloading = true; s.loaded = MODEL.size / 2; }
      if (body.action === "cancel") { s.downloading = false; s.loaded = 0; s.error = "cancelled"; }
      if (body.action === "remove") Object.assign(s, { installed: false, ready: false, pending: 0, pages: 0, sections: 0, bytes: 0 });
      return route.fulfill({ status: body.action === "download" ? 202 : 200, headers: cors, contentType: "application/json", body: "{}" });
    }
    if (phase === "go" && s.downloading) Object.assign(s, { downloading: false, installed: true, ready: true, pending: 40, error: undefined });
    else if (phase === "go" && s.pending > 0) Object.assign(s, { pending: 0, pages: 41, sections: 230, bytes: 1_400_000 });
    const { loaded, ...rest } = s;
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ model: MODEL, ...rest, ...(s.downloading ? { loaded } : {}) }) });
  });
  await page.setViewportSize({ width: 1280, height: 820 });

  // Ohne Server: Hinweis mit Weg zu Sync & server.
  await page.goto("/#prefs-ai-apps");
  const row = page.getByTestId("semantic-search");
  await expect(row).toContainText("Needs a Based server. Connect one in Sync & server.");
  await row.getByRole("button", { name: "Open Sync & server" }).click();
  await expect(page.getByLabel("Server URL")).toBeVisible();

  await page.getByLabel("Server URL").fill(`${SERVER}/`);
  await page.getByLabel("Token").fill("secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByLabel("Server URL")).toBeDisabled();
  await page.goto("/#prefs-ai-apps");
  await expect(row).toContainText("Off. Connected apps find pages by shared words.");
  await expect(row).toContainText("(135 MB) from huggingface.co");
  await page.waitForTimeout(1500);
  expect(posts).toEqual([]);

  const shot = async (name: string) => {
    if (!SHOTS || browserName !== "chromium") return;
    for (const z of SIZES) {
      await page.setViewportSize({ width: z.w, height: z.h });
      await row.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      for (const theme of ["light", "dark"] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `../../docs/design/screens/web-settings-search-by-meaning-${name}-${z.w}x${z.h}-${theme}.png` });
      }
    }
    await setTheme(page, "light");
    await page.setViewportSize({ width: 1280, height: 820 });
  };
  await shot("off");

  await row.getByRole("button", { name: "Turn on" }).click();
  await expect(row).toContainText("Downloading the model (135 MB)… 50 %");
  expect(posts).toEqual([{ action: "download" }]);
  await shot("downloading");
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toContainText("Off.");
  expect(posts).toEqual([{ action: "download" }, { action: "cancel" }]);

  await row.getByRole("button", { name: "Turn on" }).click();
  await expect(row).toContainText("Downloading the model");
  phase = "go";
  await expect(row).toContainText("Indexing your pages… 40 pages to go.");
  await expect(row).toContainText("Ready. 41 pages in 230 sections, 1 MB on the server.", { timeout: 10_000 });
  await shot("ready");
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toContainText("Off.");
  expect(posts.at(-1)).toEqual({ action: "remove" });
  expect(foreign).toEqual([]);
});
