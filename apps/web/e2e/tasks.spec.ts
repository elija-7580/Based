import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BSD-195/196/160: Auftragsliste (#tasks) mit dem Scripted-Planer (Regeln, ohne Netz): Eingabe → Karte „Received“
// (ohne Modell gespeichert) → Planer an → Plan → ausgeführt (Seite im Workspace) → Undo; Rückfrage-Knopf; nach
// Neuladen ist alles noch da; Budget in den Einstellungen; Screenshots hell/dunkel.


async function hook(page: Page): Promise<void> {
  await page.waitForFunction(() => "__basedTasks" in globalThis);
}
const call = (page: Page, fn: "useRules" | "setOnline" | "useAgentScript", ...args: unknown[]) =>
  page.evaluate(([f, a]) => ((globalThis as unknown as { __basedTasks: Record<string, (...x: unknown[]) => void> }).__basedTasks[f as string]!)(...(a as unknown[])), [fn, args] as const);

async function open(page: Page) {
  await page.goto("/#tasks");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  await expect(page.getByTestId("tasks-screen")).toBeVisible();
  await hook(page);
}

const input = (page: Page) => page.getByLabel("Tell the main agent");
const card = (page: Page, text: string) => page.getByTestId("task-card").filter({ hasText: text });

async function send(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

test("Eingabe → Received → Plan → ausgeführt → Undo; Rückfrage; Neuladen", async ({ playwright, browserName, baseURL }) => {
  // eigenes Profil: WebKit hat OPFS nur in einem dauerhaften Kontext (sonst nach Neuladen leer)
  const dir = mkdtempSync(join(tmpdir(), "based-tasks-"));
  const ctx = await playwright[browserName].launchPersistentContext(dir, { baseURL: baseURL! });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await open(page);
    await expect(page.getByRole("heading", { name: "No tasks yet" })).toBeVisible();
    await expect(page.getByText(/No model set up: tasks are saved and wait/)).toBeVisible();

    // ohne Modell: sofort gespeichert, wartet
    await send(page, "Write a page about green tea");
    const tea = card(page, "Write a page about green tea");
    await expect(tea.getByTestId("task-state")).toHaveText("Received");
    await expect(tea).toContainText("waiting: no model set up");
    await expect(input(page)).toHaveValue("");

    // Planer an (Scripted, mit Pause, damit „Understanding“ sichtbar ist) → läuft weiter
    await call(page, "useRules", 700);
    await expect(tea.getByTestId("task-state")).toHaveText("Understanding");
    await expect(tea.getByTestId("task-state")).toHaveText("Done", { timeout: 10_000 });
    await expect(tea.getByTestId("task-result")).toHaveText("Page “Write a page about green tea”");
    await expect(page.getByRole("navigation").getByText("Write a page about green tea")).toBeVisible();

    // Undo an der Karte: die Seite ist wieder weg
    await tea.getByRole("button", { name: "Undo" }).click();
    await expect(tea.getByTestId("task-state")).toHaveText("Undone");
    await expect(page.getByRole("navigation").getByText("Write a page about green tea")).toHaveCount(0);

    // Rückfrage-Knopf: kein Projekt genannt → „Which project?“ → New project → eingeordnet
    await send(page, "Add this to the project: swipe view for tasks");
    const ask = card(page, "swipe view for tasks");
    await expect(ask.getByTestId("task-state")).toHaveText("Needs you", { timeout: 10_000 });
    await expect(ask).toContainText("Which project?");
    await ask.getByRole("button", { name: "New project" }).click();
    // Ask before edits: ins (neue) Projekt schreiben ist ein Vorschlag → bestätigen
    await expect(ask.getByTestId("task-state")).toHaveText(/Proposal|Done/, { timeout: 10_000 });
    if ((await ask.getByTestId("task-state").textContent()) === "Proposal") await ask.getByRole("button", { name: "Go ahead" }).click();
    await expect(ask.getByTestId("task-state")).toHaveText("Done", { timeout: 10_000 });
    await expect(ask.getByTestId("task-result")).toContainText("Filed into");

    // Aufgabe mit Termin + Frage beantwortet (Antwort auf der Karte)
    await send(page, "Buy milk tomorrow");
    await expect(card(page, "Buy milk tomorrow").getByTestId("task-state")).toHaveText("Done", { timeout: 10_000 });
    await send(page, "What is the capital of Portugal?");
    await expect(card(page, "capital of Portugal").getByTestId("task-answer")).toContainText("You asked");

    // ungültige Modellausgabe → Retry → als Notiz abgelegt, Try again bleibt möglich
    await send(page, "Some thought #invalid");
    const bad = card(page, "Some thought");
    await expect(bad.getByTestId("task-state")).toHaveText("Filed as note", { timeout: 10_000 });
    await expect(bad.getByRole("button", { name: "Try again" })).toBeVisible();

    // Neuladen: Karten und Zustände sind noch da
    await page.reload();
    await expect(page.getByTestId("tasks-screen")).toBeVisible();
    await expect(card(page, "Write a page about green tea").getByTestId("task-state")).toHaveText("Undone");
    await expect(card(page, "swipe view for tasks").getByTestId("task-state")).toHaveText("Done");
    await expect(card(page, "Buy milk tomorrow").getByTestId("task-state")).toHaveText("Done");
    await expect(page.getByTestId("task-card")).toHaveCount(5);

    // offline: gespeichert, wartet; online → läuft weiter
    await hook(page);
    await call(page, "useRules", 0);
    await call(page, "setOnline", false);
    await send(page, "Pay the electricity bill by friday");
    const bill = card(page, "electricity bill");
    await expect(bill).toContainText("waiting: offline");
    await call(page, "setOnline", true);
    await expect(bill.getByTestId("task-state")).toHaveText("Done", { timeout: 10_000 });
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Budget und Regeln in den Einstellungen; Unteragent über Budget → Vorschlag", async ({ page }) => {
  await open(page);
  await page.goto("/#prefs-agents");
  const s = page.getByTestId("agent-settings");
  await expect(s).toBeVisible();
  await s.getByRole("spinbutton", { name: "Monthly budget" }).fill("5");
  await s.getByRole("spinbutton", { name: "Monthly budget" }).press("Tab");
  await s.getByRole("spinbutton", { name: "Without asking, per task" }).fill("0.2");
  await s.getByRole("spinbutton", { name: "Without asking, per task" }).press("Tab");
  await s.getByRole("textbox", { name: "Rules" }).fill("deny based.schedule");
  await s.getByRole("button", { name: "Save" }).click();
  await expect(s.getByTestId("agent-settings-status")).toHaveText("Saved");
  await page.goto("/#tasks");
  await hook(page);
  await call(page, "useRules", 0);
  await call(page, "useAgentScript", [{ text: "Found three sync engines." }]);
  await expect(page.getByTestId("tasks-budget")).toContainText("of 5.00 €");
  // Recherche ≈ 0.40 € > 0.20 € pro Auftrag → Vorschlag; bestätigen → Unteragent läuft
  await send(page, "Research open-source sync engines");
  const research = card(page, "sync engines");
  await expect(research.getByTestId("task-state")).toHaveText("Proposal", { timeout: 10_000 });
  await expect(research).toContainText("above the 0.20 € limit per task");
  await research.getByRole("button", { name: "Go ahead" }).click();
  await expect(research.getByTestId("task-run")).toContainText("done", { timeout: 10_000 });
  // Regel blockiert Zeitpläne
  await send(page, "Remind me every day at 7:30 to drink water");
  const remind = card(page, "drink water");
  await expect(remind.getByTestId("task-state")).toHaveText("Proposal", { timeout: 10_000 });
  await expect(remind).toContainText("blocked by rule “deny based.schedule”");
  await expect(remind.getByRole("button", { name: "Go ahead" })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`Screenshot Auftragsliste (${theme})`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Screenshots nur einmal");
    await page.addInitScript((t) => localStorage.setItem("based.appearance", JSON.stringify({ theme: t })), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await call(page, "useRules", 0);
    await send(page, "Write a page with ideas for the birthday party");
    await expect(card(page, "birthday").getByTestId("task-state")).toHaveText("Done", { timeout: 10_000 });
    await send(page, "Add this to the project");
    await expect(card(page, "Add this to the project").getByTestId("task-state")).toHaveText("Needs you", { timeout: 10_000 });
    await send(page, "What is the capital of Portugal?");
    await expect(card(page, "Portugal").getByTestId("task-answer")).toBeVisible();
    await call(page, "useRules", 60_000);
    await send(page, "Research flights to Lisbon in December");
    await expect(card(page, "flights to Lisbon").getByTestId("task-state")).toHaveText("Understanding");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `../../docs/design/screens/web-tasks-${theme}.png` });
  });
}
