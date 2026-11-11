// BSD-250: stdio-MCP-Server als Kindprozess – Werkzeuge laden und aufrufen; Token nur als Umgebungsvariable,
// fremde Geheimnisse der Eltern-Umgebung kommen nicht an, Geheimnisse in Argumenten werden abgelehnt.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpConnection, McpToolHost } from "../src/mcp/index.js";
import { stdioTransport, StdioConfigError } from "../src/mcp/stdio-node.js";

const script = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

describe("MCP über stdio (BSD-250)", () => {
  it("startet den Server, lädt Werkzeuge, ruft eins auf; Umgebung gefiltert, Token als secretEnv", async () => {
    const baseEnv = { ...process.env, AWS_SECRET_ACCESS_KEY: "do-not-leak" };
    const conn = new McpConnection("Local files", () => stdioTransport({ command: process.execPath, args: [script, "--root", "/tmp"], secretEnv: "FIXTURE_TOKEN" }, { token: "tok-123", baseEnv }), { timeoutMs: 20_000 });
    await conn.connect();
    expect(conn.status).toBe("ready");
    expect(conn.tools.map((t) => t.name)).toEqual(["whoami"]);
    const host = new McpToolHost([conn]);
    const r = await host.call("mcp__local_files__whoami", {});
    const seen = JSON.parse(r.text) as { token: string | null; secret: string | null; args: string[] };
    expect(seen.token).toBe("tok-123");
    expect(seen.secret).toBeNull();
    expect(seen.args).toEqual(["--root", "/tmp"]);
    await conn.close();
  }, 30_000);

  it("ohne Befehl oder mit Geheimnis in den Argumenten: Fehler vor dem Start", () => {
    expect(() => stdioTransport({ command: " " })).toThrow(StdioConfigError);
    expect(() => stdioTransport({ command: "npx", args: ["--token=abcdefgh12345"] })).toThrow(/Don't put secrets/);
  });
});
