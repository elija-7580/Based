import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overflows, overlaps } from "./layout-checks.js";

// BSD-305 Teil 5 (Beta-Umfang): Durchgang im echten Beta-Build. Läuft nur, wenn der Build mit BASED_CHANNEL=beta
// entsteht – Playwright baut den Server mit der Umgebung des Aufrufs:
//   BASED_CHANNEL=beta BASED_E2E_PORT=4179 CI=1 pnpm --filter @based/web exec playwright test e2e/beta-build.spec.ts
// (eigener Port, damit kein Dev-Server wiederverwendet wird). Sonst übersprungen (run-ts, CI). Prüft, was Tester auf
// beta sehen: erster Start (Willkommen mit Vorlagen, ohne AI), Home = Willkommensseite (BSD-461), Seitenkopf ohne Share
// (BSD-460), Einstellungen ohne „Not yet“- und AI-Seiten, My settings ohne Agenten-Begriffe (BSD-459), Slash-Menü
// mit Meeting notes (Elija 17.11.), ohne Ask AI; Meeting-Block ohne Reiter „Summary“; jeweils ohne Überlauf und sich überdeckenden Text, Fotos 1280 × 820 hell/dunkel.

const BETA = process.env.BASED_CHANNEL === "beta";
const SHOTS = "../../docs/design/screens/";

test.skip(!BETA, "nur mit BASED_CHANNEL=beta (Beta-Build)");

async function fresh(playwright: Parameters<Parameters<typeof test>[2]>[0]["playwright"], browserName: "chromium" | "webkit" | "firefox", baseURL: string, theme: "light" | "dark") {
  const dir = mkdtempSync(join(tmpdir(), "based-beta-"));
  const ctx: BrowserContext = await playwright[browserName].launchPersistentContext(dir, { baseURL, viewport: { width: 1280, height: 820 } });
  await ctx.addInitScript((t) => {
    (globalThis as { __basedWelcome?: boolean }).__basedWelcome = true;
    localStorage.setItem("based.appearance", JSON.stringify({ theme: t }));
  }, theme);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { page, close: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function clean(page: Page, where: string) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  expect(await overflows(page), where).toEqual([]);
  expect(await overlaps(page), where).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`Beta-Build: erster Start, Seite, Einstellungen, Slash-Menü (${theme})`, async ({ playwright, browserName, baseURL }) => {
    test.setTimeout(120_000);
    const shoot = async (page: Page, name: string) => { if (browserName === "chromium") await page.screenshot({ path: `${SHOTS}beta-${name}-${theme}.png` }); };
    const { page, close } = await fresh(playwright, browserName, baseURL!, theme);
    try {
      await page.goto("/");
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      // BSD-551: erst der geführte Einstieg (ohne AI-Hinweise), jeder Schritt ohne Überlauf, dann die Wahl
      const tour = page.getByTestId("welcome-tour");
      await expect(tour).toBeVisible();
      await expect(tour.getByTestId("logo-intro")).toHaveAttribute("data-state", "done");
      for (;;) {
        const step = await tour.getAttribute("data-step");
        await expect(tour.getByText(/Turn on agents|AI stays off/)).toHaveCount(0);
        await clean(page, `Einstieg ${step}`);
        await shoot(page, `tour-${step}`);
        const next = tour.getByRole("button", { name: /^(Continue|Later|Get started)$/ });
        const label = await next.textContent();
        await next.click();
        if (label?.includes("Get started")) break;
      }
      const welcome = page.getByTestId("welcome");
      await expect(welcome).toBeVisible();
      await expect(welcome.getByRole("group", { name: "Or start from a template" }).getByRole("button")).toHaveText(["Tasks", "Notes", "Journal", "Wiki"]);
      await expect(welcome.getByText("AI stays off")).toHaveCount(0);
      await clean(page, "Willkommen");
      await shoot(page, "welcome");

      // Start empty → Home ist die Willkommensseite, keine Seite „Home“, kein Share, kein AI-Knopf
      await welcome.getByRole("button", { name: /Start empty/ }).click();
      await page.getByRole("button", { name: "Home" }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");
      await expect(page.getByRole("treeitem", { name: "Home", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
      await expect(page.getByTestId("topbar-ai")).toHaveCount(0);
      await clean(page, "Willkommensseite");
      await shoot(page, "home-page");
      // die Anleitung „Your data“ verspricht keinen AI-Schalter, den es auf beta nicht gibt
      await page.getByTestId("page-content").getByText("Your data", { exact: true }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Your data");
      await expect(page.getByTestId("block-editor")).not.toContainText(/\bAI\b|agent/i);
      await page.getByRole("button", { name: "Home" }).click();
      await expect(page.getByLabel("Page title")).toHaveValue("Welcome to Based");

      // Slash-Menü: Meeting notes ja (Elija 17.11.), Ask AI nein
      await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
      await page.keyboard.type("/");
      const menu = page.getByTestId("slash-menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByText("Ask AI")).toHaveCount(0);
      await shoot(page, "slash-menu");
      // Meeting-Block auf beta: Aufnahme, Notizen, Transkript – kein Reiter „Summary“, kein Hinweis auf AI-Einstellungen
      await page.keyboard.type("meet");
      await expect(menu.getByRole("option", { name: /Meeting notes/ })).toBeVisible();
      await page.keyboard.press("Enter");
      const meeting = page.getByTestId("meeting-block");
      await expect(meeting).toBeVisible();
      await expect(meeting.getByRole("tab")).toHaveText([/Notes/, /Transcript/]);
      await expect(meeting.getByRole("tab", { name: "Summary" })).toHaveCount(0);
      await meeting.getByRole("tab", { name: "Transcript" }).click();
      await expect(page.getByTestId("meeting-transcript-empty")).toContainText("Set it up in Settings → Meeting notes");
      await expect(meeting).not.toContainText(/\bAI\b|agent/i);
      await clean(page, "Meeting-Block");
      await shoot(page, "meeting");

      // Einstellungen: keine „Not yet“-Seiten, keine AI-Seiten; My settings ohne Agenten-Begriffe
      await page.goto("/#prefs-my-settings");
      const nav = page.getByRole("navigation", { name: "Settings pages" });
      await expect(nav).toBeVisible();
      await expect(nav.getByText("Not yet")).toHaveCount(0);
      for (const hidden of ["My connections", "People", "Teamspaces", "Security", "Agents & AI", "Connections", "My notifications"]) await expect(nav.getByRole("button", { name: hidden, exact: true })).toHaveCount(0);
      const settings = page.getByTestId("settings-page");
      await expect(settings).not.toContainText(/agent|marker|calm mode/i);
      // Meeting notes in den Einstellungen: im Browser ohne Server steht, was fehlt
      await expect(page.getByTestId("settings-section-meetings")).toContainText("Transcription");
      await expect(page.getByTestId("settings-section-start-page")).toContainText("Welcome to Based");
      await clean(page, "My settings");
      await shoot(page, "settings");
      // BSD-485/514: About heißt „Based Notes Beta“, ohne Agenten
      await nav.getByRole("button", { name: "About", exact: true }).click();
      await expect(settings).toContainText("Based Notes Beta — the notes app that keeps your data yours.");
      await expect(settings).not.toContainText(/Based Next|agent/i);
      await clean(page, "About");
      await shoot(page, "settings-about");
      // BSD-483: General verspricht kein Teilen; Diagnostics nennt den Weg für Berichte
      await nav.getByRole("button", { name: "General", exact: true }).click();
      await expect(settings).toContainText("Used for exports");
      await expect(settings).not.toContainText(/share with/i);
      await nav.getByRole("button", { name: "Diagnostics", exact: true }).click();
      await expect(settings.getByText(/email it to hello@basednotes\.app/)).toBeVisible();
      await expect(settings).not.toContainText("pass it on");
      await settings.getByText(/email it to hello@basednotes\.app/).scrollIntoViewIfNeeded();
      await clean(page, "Diagnostics");
      await shoot(page, "settings-diagnostics");

      // Library ohne Graph, mit Meetings; ⌘N mit Meeting notes und Board (seit be879bf0 auf beta), ohne AI-Chat, mit den Vorlagen
      await page.goto("/#library");
      await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText("Graph", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Meetings", { exact: true })).toHaveCount(1);
      await clean(page, "Library");
      await shoot(page, "library");
      await page.keyboard.press("ControlOrMeta+n");
      const palette = page.getByTestId("new-palette");
      await expect(palette.getByRole("option")).toHaveText([/New page/, /meeting notes/i, /New database/, /Import/, /New board/, /Tasks template/, /Notes template/, /Journal template/, /Wiki template/]);
      await page.keyboard.type("tasks");
      await page.keyboard.press("Enter");
      await expect(page.locator(".shell-database.full")).toBeVisible();
      await clean(page, "Vorlage Tasks");
      await shoot(page, "template-tasks");
    } finally {
      await close();
    }
  });
}

// BSD-467: ⇧⌘B → Speichern → der Dialog nennt hello@basednotes.app und der Knopf „Email report“ öffnet eine Mail mit
// „Based Notes Beta“ (BSD-514) und Kanal beta – ohne Seiteninhalt und ohne die Notiz.
test("Beta-Build: Problem melden führt zur Mail an hello@basednotes.app", async ({ playwright, browserName, baseURL }) => {
  test.setTimeout(90_000);
  const { page, close } = await fresh(playwright, browserName, baseURL!, "light");
  try {
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await page.getByTestId("welcome-tour").getByRole("button", { name: "Skip" }).click(); // BSD-551
    await page.getByTestId("welcome").getByRole("button", { name: /Start empty/ }).click();
    await page.getByTestId("block-editor").getByTestId("block-editor-tail").click();
    await page.keyboard.type("Secret beta page text");
    await page.keyboard.press("ControlOrMeta+Shift+b");
    const dialog = page.getByRole("dialog", { name: "Report a problem" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("textbox", { name: "What did you do, and what happened?" }).fill("My private note");
    await dialog.getByRole("button", { name: "Save report" }).click();
    const box = page.getByRole("dialog", { name: "Report saved" }).getByTestId("report-email");
    await expect(box).toContainText("Send it to hello@basednotes.app");
    await expect(box.getByRole("button", { name: "Email report" })).toBeVisible();
    const text = decodeURIComponent((await box.getAttribute("data-mailto"))!);
    expect(text.startsWith("mailto:hello@basednotes.app?subject=Based Notes Beta ")).toBe(true);
    expect(text).toContain("Channel: beta");
    for (const leak of ["Secret beta page text", "My private note"]) expect(text).not.toContain(leak);
    await clean(page, "Report saved");
  } finally {
    await close();
  }
});

// BSD-486: alte Links auf ausgeblendete Ansichten (#meetings, #graph, #coding) und auf AI (#chat, #agents, #ai) führen
// auf Home = Willkommensseite und die Adresse wird #home – nicht die Library, kein stehengebliebener Hash.
test("Beta-Build: alte Links auf ausgeblendete Ansichten landen auf #home", async ({ playwright, browserName, baseURL }) => {
  test.setTimeout(120_000);
  const { page, close } = await fresh(playwright, browserName, baseURL!, "light");
  try {
    await page.goto("/");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await page.getByTestId("welcome-tour").getByRole("button", { name: "Skip" }).click(); // BSD-551
    await page.getByTestId("welcome").getByRole("button", { name: /Start empty/ }).click();
    await expect(page.getByLabel("Page title")).toBeVisible();
    // BSD-507: Meetings sind seit BSD-231 in der Beta – #meetings bleibt und zeigt die Meetings-Liste
    await page.goto("/#meetings");
    await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
    await expect(page).toHaveURL(/#meetings$/);
    await expect(page.getByTestId("meetings")).toBeVisible();
    for (const hash of ["graph", "coding", "chat", "tasks", "agents", "ai"]) {
      await page.goto("/#" + hash);
      await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
      await expect(page, hash).toHaveURL(/#home$/);
      await expect(page.getByLabel("Page title"), hash).toHaveValue("Welcome to Based");
      await expect(page.getByTestId("library"), hash).toHaveCount(0);
    }
  } finally {
    await close();
  }
});
