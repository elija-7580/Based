import { expect, test, type BrowserContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mehrere Browser-Tabs auf einem Workspace (worker/leader.ts), Sync-Token verschlüsselt (shell/secrets.ts) und Tabs
// in der Shell (shell/router.ts, components/TabBar.tsx).

// dauerhafte Profile und mehrere Seiten brauchen in WebKit länger als die üblichen 30 s
test.describe.configure({ timeout: 90_000 });

const ready = (page: Page) => expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
const role = (page: Page) => page.evaluate(() => (globalThis as unknown as { __based: { link: { role: string } } }).__based.link.role);

async function newTopLevelPage(page: Page, title: string) {
  const header = page.locator(".tree-header", { hasText: "Private" });
  await header.hover();
  await page.getByRole("button", { name: "New page in Private" }).click();
  const field = page.getByLabel("Page title");
  await expect(field).toHaveValue("");
  await field.fill(title);
  await expect(page.getByRole("treeitem", { name: title })).toBeVisible();
}

async function persistent(playwright: PlaywrightWorkerArgs["playwright"], browserName: string, baseURL: string) {
  // WebKit hat OPFS nur in einem dauerhaften Profil (wie im Shell-Test)
  const dir = mkdtempSync(join(tmpdir(), "based-tabs-"));
  const ctx: BrowserContext = await playwright[browserName as "chromium" | "webkit"].launchPersistentContext(dir, { baseURL });
  return { ctx, dispose: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("zwei Browser-Tabs: Änderungen sofort im anderen, Store-Tab schließen, der andere speichert weiter", async ({ playwright, browserName, baseURL }) => {
  const { ctx, dispose } = await persistent(playwright, browserName, baseURL!);
  try {
    const a = ctx.pages()[0] ?? (await ctx.newPage());
    await a.goto("/");
    await ready(a);
    await expect(a.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    const b = await ctx.newPage();
    await b.goto("/");
    await ready(b);
    expect(await role(a)).toBe("leader");
    expect(await role(b)).toBe("follower");
    // B speichert über A – nicht „nur im Speicher“
    await expect(b.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    await expect(b.getByRole("treeitem", { name: "Welcome to Based" })).toBeVisible();

    // Änderung in A erscheint in B und umgekehrt
    await newTopLevelPage(a, "Made in tab A");
    await expect(b.getByRole("treeitem", { name: "Made in tab A" })).toBeVisible();
    await newTopLevelPage(b, "Made in tab B");
    await expect(a.getByRole("treeitem", { name: "Made in tab B" })).toBeVisible();

    // dieselbe Seite in beiden offen: Titel tippen in B, A sieht ihn
    await a.getByRole("treeitem", { name: "Made in tab B" }).click();
    await b.getByLabel("Page title").fill("Renamed in tab B");
    await expect(a.getByLabel("Page title")).toHaveValue("Renamed in tab B");

    // A (Store-Tab) schließen: B übernimmt und speichert weiter
    await a.close();
    await expect.poll(() => role(b), { timeout: 15_000 }).toBe("leader");
    await expect(b.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    await newTopLevelPage(b, "After takeover");
    await b.getByLabel("Page title").fill("After takeover, edited");
    await expect(b.getByRole("treeitem", { name: "After takeover, edited" })).toBeVisible();

    // neu laden: alles da
    await b.reload();
    await ready(b);
    await expect(b.getByTestId("sync-status")).toHaveAttribute("data-state", "local");
    for (const name of ["Made in tab A", "Renamed in tab B", "After takeover, edited"]) await expect(b.getByRole("treeitem", { name })).toBeVisible();
  } finally {
    await dispose();
  }
});

test("Tabs in der Shell: öffnen, wechseln, eigener Verlauf, umsortieren, schließen, nach dem Neuladen noch da", async ({ playwright, browserName, baseURL }) => {
  // dauerhaftes Profil, damit die Seiten das Neuladen auch in WebKit überleben
  const { ctx, dispose } = await persistent(playwright, browserName, baseURL!);
  try {
    await shellTabs(ctx.pages()[0] ?? (await ctx.newPage()));
  } finally {
    await dispose();
  }
});

async function shellTabs(page: Page) {
  await page.goto("/");
  await ready(page);
  const tabs = page.getByRole("tablist", { name: "Tabs" });
  const tabNames = () => tabs.getByRole("tab").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await expect(tabs).toHaveCount(0); // ein Tab: keine Leiste

  await newTopLevelPage(page, "Alpha");
  await newTopLevelPage(page, "Beta");

  // ⌘/Strg-Klick: Alpha im neuen Tab im Hintergrund, Beta bleibt
  await page.getByRole("treeitem", { name: "Alpha" }).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(tabNames).toEqual(["Beta", "Alpha"]);
  await expect(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("Beta");
  await expect(page.getByLabel("Page title")).toHaveValue("Beta");

  // Mittelklick auf „Welcome“: noch ein Tab
  await page.getByRole("treeitem", { name: "Welcome to Based" }).click({ button: "middle" });
  await expect.poll(tabNames).toEqual(["Beta", "Welcome to Based", "Alpha"]);

  // wechseln; jeder Tab hat seinen eigenen Verlauf
  await tabs.getByRole("tab", { name: "Alpha" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
  await page.getByRole("treeitem", { name: "Beta" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Beta");
  await expect.poll(tabNames).toEqual(["Beta", "Welcome to Based", "Beta"]);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
  await tabs.getByRole("tab").first().click();
  await expect(page.getByLabel("Page title")).toHaveValue("Beta");
  await page.getByRole("button", { name: "Back" }).click(); // erster Tab: Beta ← Alpha
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
  await expect.poll(tabNames).toEqual(["Alpha", "Welcome to Based", "Alpha"]);

  // ⌘T: neuer leerer Tab (Home); ⌘W schließt ihn
  await page.keyboard.press("ControlOrMeta+t");
  await expect.poll(tabNames).toEqual(["Alpha", "Home", "Welcome to Based", "Alpha"]);
  await expect(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("Home");
  await page.keyboard.press("ControlOrMeta+w");
  await expect.poll(tabNames).toEqual(["Alpha", "Welcome to Based", "Alpha"]);
  await expect(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("Welcome to Based");

  // Ziehen sortiert um: „Welcome“ ans Ende
  const welcome = tabs.getByRole("tab", { name: "Welcome to Based" });
  const last = tabs.getByRole("tab").last();
  const box = (await last.boundingBox())!;
  await welcome.dragTo(last, { targetPosition: { x: box.width - 4, y: box.height / 2 } });
  await expect.poll(tabNames).toEqual(["Alpha", "Alpha", "Welcome to Based"]);

  // Neuladen: Tabs, aktiver Tab und Verläufe bleiben
  await page.reload();
  await ready(page);
  await expect.poll(tabNames).toEqual(["Alpha", "Alpha", "Welcome to Based"]);
  await expect(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("Welcome to Based");
  await tabs.getByRole("tab").nth(1).click(); // der per ⌘-Klick geöffnete Tab: Alpha, vorwärts Beta
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
  await page.getByRole("button", { name: "Forward" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Beta");
  await page.getByRole("button", { name: "Back" }).click();
  await tabs.getByRole("tab").first().click();
  await expect(page.getByRole("button", { name: "Back" })).toBeEnabled();
  await tabs.getByRole("tab").nth(1).click();

  // × schließt; der letzte Tab nimmt die Leiste mit
  await tabs.getByRole("tab").nth(2).getByRole("button", { name: "Close tab" }).click();
  await tabs.getByRole("tab").nth(1).click({ button: "middle" });
  await expect(tabs).toHaveCount(0);
  await expect(page.getByLabel("Page title")).toHaveValue("Alpha");
}

test("Sync-Token nicht im Klartext: alter localStorage-Eintrag wird verschlüsselt übernommen", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.evaluate(() => localStorage.setItem("based.sync", JSON.stringify({ url: "http://127.0.0.1:9", token: "legacy-secret-token" })));
  await page.reload();
  await ready(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Server URL")).toHaveValue("http://127.0.0.1:9");
  await expect(page.getByLabel("Token")).toHaveValue("legacy-secret-token");
  const stored = await page.evaluate(async () => {
    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) all.push(localStorage.getItem(localStorage.key(i)!) ?? "");
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("based-secrets");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const values = await new Promise<unknown[]>((res, rej) => {
      const r = db.transaction("kv").objectStore("kv").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const sealed = values.find((v) => (v as { url?: string }).url) as { data: ArrayBuffer };
    const key = values.find((v) => v instanceof CryptoKey) as CryptoKey;
    return {
      local: all.join("\n"),
      legacy: localStorage.getItem("based.sync"),
      bytes: new TextDecoder("latin1").decode(new Uint8Array(sealed.data)),
      extractable: key.extractable,
    };
  });
  expect(stored.legacy).toBeNull();
  expect(stored.local).not.toContain("legacy-secret-token");
  expect(stored.bytes).not.toContain("legacy-secret-token");
  expect(stored.extractable).toBe(false);
});
