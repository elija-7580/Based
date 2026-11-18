// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-581: Schnipsel für „Connect AI apps“ – This Mac ohne Token (stdio über `based mcp`), Server mit eigenem Token.
import { describe, expect, it } from "vitest";
import { macSetup, serverSetup, serverTarget, tokenName, whereToPaste } from "./aiApps.js";

describe("Connect AI apps (BSD-581)", () => {
  it("This Mac: der Client startet `based mcp`, kein Token im Schnipsel", () => {
    expect(macSetup("claude-code", "/Users/e/.local/bin/based")).toBe("claude mcp add --scope user based -- /Users/e/.local/bin/based mcp");
    expect(macSetup("claude-code", "/Users/e/My Tools/based")).toBe("claude mcp add --scope user based -- '/Users/e/My Tools/based' mcp");
    const desktop = JSON.parse(macSetup("claude-desktop", "/Users/e/.local/bin/based-beta")) as unknown;
    expect(desktop).toEqual({ mcpServers: { based: { command: "/Users/e/.local/bin/based-beta", args: ["mcp"] } } });
    expect(JSON.parse(macSetup("cursor", "based"))).toEqual({ mcpServers: { based: { command: "based", args: ["mcp"] } } });
    expect(macSetup("cursor", "based")).toContain('"args": ["mcp"]');
    for (const c of ["claude-code", "claude-desktop", "cursor"] as const) expect(macSetup(c, "based")).not.toMatch(/token|bdo_/i);
  });

  it("Server: Streamable HTTP mit eigenem Token; Claude Desktop über `based mcp` mit Umgebung", () => {
    const url = "https://based.example.com/", token = "bdo_abc";
    expect(serverSetup("claude-code", url, token, "based")).toBe("claude mcp add --scope user --transport http based https://based.example.com/mcp --header 'Authorization: Bearer bdo_abc'");
    expect(JSON.parse(serverSetup("cursor", url, token, "based"))).toEqual({ mcpServers: { based: { url: "https://based.example.com/mcp", headers: { Authorization: "Bearer bdo_abc" } } } });
    expect(JSON.parse(serverSetup("claude-desktop", url, token, "/u/based"))).toEqual({ mcpServers: { based: { command: "/u/based", args: ["mcp"], env: { BASED_URL: "https://based.example.com", BASED_TOKEN: "bdo_abc" } } } });
  });

  it("Token-Namen eindeutig, Ziel Server nur mit eigenem (nicht dem lokalen) Server", () => {
    expect(tokenName("cursor", [])).toBe("Cursor");
    expect(tokenName("claude-code", ["Claude Code", "Claude Code 2", "iPhone"])).toBe("Claude Code 3");
    expect(serverTarget(undefined, undefined)).toBeUndefined();
    expect(serverTarget({ url: "http://127.0.0.1:5123", token: "t" }, "http://127.0.0.1:5123/")).toBeUndefined();
    expect(serverTarget({ url: "https://b.example/", token: "t" }, "http://127.0.0.1:5123")).toEqual({ url: "https://b.example", token: "t" });
    expect(serverTarget({ url: "https://b.example", token: "" }, undefined)).toBeUndefined();
  });

  it("jeder Client sagt, wo das Schnipsel hingehört", () => {
    expect(whereToPaste("claude-desktop")).toContain("claude_desktop_config.json");
    expect(whereToPaste("cursor")).toContain("mcp.json");
    expect(whereToPaste("claude-code")).toContain("Terminal");
  });
});
