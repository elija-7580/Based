// Kleiner MCP-Server über stdio für Tests (BSD-250): ein Werkzeug „whoami“ gibt die Umgebung zurück, die er sieht.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fixture-stdio", version: "1.0.0" });
server.registerTool("whoami", { description: "Shows the token and a leaked variable", annotations: { readOnlyHint: true } }, async () => ({
  content: [{ type: "text", text: JSON.stringify({ token: process.env.FIXTURE_TOKEN ?? null, secret: process.env.AWS_SECRET_ACCESS_KEY ?? null, args: process.argv.slice(2) }) }],
}));
await server.connect(new StdioServerTransport());
