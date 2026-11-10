import { expect, test, type Page, type Route } from "@playwright/test";

// BSD-222: MCP-Connections – eigenen Server in den Einstellungen einrichten (Token verschlüsselt), Zustand
// „Connected · 2 tools“, dann ruft der Chat ein Werkzeug des Servers auf: schreibend → Freigabe-Karte → Allow.
// Der Server ist ein Fake über page.route (Streamable HTTP mit JSON-Antworten, verlangt `Bearer good`).

const URL = "https://mcp.test/mcp";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

async function fakeServer(page: Page) {
  const created: string[] = [];
  await page.route("https://mcp.test/**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (req.headers()["authorization"] !== "Bearer good") return route.fulfill({ status: 401, headers: CORS, body: "unauthorized" });
    if (req.method() !== "POST") return route.fulfill({ status: 405, headers: CORS });
    const msg = req.postDataJSON() as { id?: number; method: string; params?: { name?: string; arguments?: { title?: string } } };
    if (msg.id === undefined) return route.fulfill({ status: 202, headers: CORS });
    const reply = (result: unknown) => route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) });
    switch (msg.method) {
      case "initialize": return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "tracker", version: "1" } });
      case "tools/list": return reply({ tools: [
        { name: "list_issues", description: "List issues", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
      ] });
      case "tools/call":
        created.push(msg.params?.arguments?.title ?? "");
        return reply({ content: [{ type: "text", text: `Created issue #${created.length}: ${msg.params?.arguments?.title ?? ""}` }] });
      default: return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } }) });
    }
  });
  return created;
}

const mod = process.platform === "darwin" ? "Meta" : "Control";

test("eigener MCP-Server: einrichten, verbinden, Werkzeug im Chat mit Freigabe", async ({ page }) => {
  const created = await fakeServer(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/#prefs-connections");
  await expect(page.getByTestId("based-root")).toHaveAttribute("data-ready", "");
  const section = page.getByTestId("settings-section-mcp-connections");
  await expect(section.getByText("No connections yet")).toBeVisible();

  await section.getByLabel("Name").fill("Tracker");
  await section.getByLabel("URL").fill(URL);
  await section.getByLabel("Token").fill("good");
  await section.getByRole("button", { name: "Add server" }).click();
  const row = section.getByTestId("mcp-connection");
  await expect(row).toHaveAttribute("data-name", "Tracker");
  await expect(row.getByTestId("mcp-status")).toHaveText("Connected · 2 tools");

  // Chat: das Skript ruft das schreibende Werkzeug; „Ask before edits“ fragt.
  await page.waitForFunction(() => "__basedChat" in globalThis);
  await page.evaluate(() => (globalThis as unknown as { __basedChat: { useScript(s: unknown): void } }).__basedChat.useScript([
    { text: "I'll file it." },
    { tool: "mcp__tracker__create_issue", input: { title: "From chat" } },
    { text: "Filed." },
  ]));
  await page.keyboard.press(`${mod}+j`);
  const panel = page.getByTestId("chat-panel");
  await panel.getByLabel("Ask Based").fill("File an issue");
  await panel.getByLabel("Ask Based").press("Enter");
  const card = panel.getByTestId("tool-card");
  await expect(card).toHaveAttribute("data-status", "waiting");
  expect(created).toEqual([]);
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveAttribute("data-status", "done");
  expect(created).toEqual(["From chat"]);
  await expect(panel.getByTestId("assistant-message").last()).toHaveAttribute("data-done", "");

  // Ausschalten trennt; Entfernen löscht die Zeile.
  await row.getByRole("switch", { name: "On" }).click();
  await expect(row.getByTestId("mcp-status")).toHaveText("Off");
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(section.getByText("No connections yet")).toBeVisible();
});
