// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-581: „Connect AI apps“ – was ein MCP-Client (Claude Code, Claude Desktop, Cursor) zum Verbinden braucht.
// Zwei Ziele, derselbe MCP (`POST /mcp`, gleiche Werkzeuge):
// - „This Mac“: der Client startet `based mcp` (stdio). Kein Token in fremden Dateien; `based` findet den lokalen
//   Server der App selbst (Discovery-Datei, Token 0600).
// - „Server“ (Based Cloud oder eigener based-server): je Client ein eigenes, widerrufbares Token (`bdo_…`, wie beim
//   Koppeln eines Geräts, BSD-315), einmal gezeigt im kopierten Befehl.
// Reine Funktionen (getestet); die Ansicht steht in AIAppsSection.tsx.

export type AIAppTarget = "mac" | "server";
export type AIAppClient = "claude-code" | "claude-desktop" | "cursor";

export const AI_APP_CLIENTS: readonly { id: AIAppClient; name: string; kind: "command" | "json" }[] = [
  { id: "claude-code", name: "Claude Code", kind: "command" },
  { id: "claude-desktop", name: "Claude Desktop", kind: "json" },
  { id: "cursor", name: "Cursor", kind: "json" },
];

/** Name des Eintrags im Client (Claude Code: `claude mcp add <name>`, JSON: Schlüssel unter `mcpServers`). */
export const MCP_ENTRY = "based";

/** Wo der Client den Eintrag einfügt (ein Satz unter dem Schnipsel). */
export function whereToPaste(client: AIAppClient): string {
  switch (client) {
    case "claude-code": return "Run it in Terminal. Claude Code then lists Based under /mcp.";
    case "claude-desktop": return "In Claude Desktop: Settings → Developer → Edit Config. Add it to claude_desktop_config.json and restart Claude.";
    case "cursor": return "In Cursor: Settings → MCP → Add new global MCP server. Add it to mcp.json.";
  }
}

const shellQuote = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** JSON mit zwei Leerzeichen, kurze Listen in einer Zeile (`"args": ["mcp"]`) – passt ohne Rollen in den Dialog. */
const json = (v: unknown) => JSON.stringify(v, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`);

/**
 * „This Mac“: der Client startet den Befehl `based mcp`. `command` ist der installierte Starter (absoluter Pfad, weil
 * Claude Desktop und Cursor den PATH der Shell nicht kennen) oder sonst der Befehlsname.
 */
export function macSetup(client: AIAppClient, command: string): string {
  if (client === "claude-code") return `claude mcp add --scope user ${MCP_ENTRY} -- ${shellQuote(command)} mcp`;
  return json({ mcpServers: { [MCP_ENTRY]: { command, args: ["mcp"] } } });
}

/**
 * „Server“: eigenes Token je Client. Claude Code und Cursor sprechen Streamable HTTP direkt; Claude Desktop startet
 * `based mcp` mit Adresse und Token in der Umgebung (seine Konfigurationsdatei kennt keine HTTP-Header).
 */
export function serverSetup(client: AIAppClient, url: string, token: string, command: string): string {
  const endpoint = `${url.replace(/\/+$/, "")}/mcp`;
  if (client === "claude-code") return `claude mcp add --scope user --transport http ${MCP_ENTRY} ${endpoint} --header ${shellQuote(`Authorization: Bearer ${token}`)}`;
  if (client === "cursor") return json({ mcpServers: { [MCP_ENTRY]: { url: endpoint, headers: { Authorization: `Bearer ${token}` } } } });
  return json({ mcpServers: { [MCP_ENTRY]: { command, args: ["mcp"], env: { BASED_URL: url.replace(/\/+$/, ""), BASED_TOKEN: token } } } });
}

/** Name des Tokens auf dem Server (Liste „Apps and devices“): „Claude Code“, bei Wiederholung „Claude Code 2“. */
export function tokenName(client: AIAppClient, existing: readonly string[]): string {
  const base = AI_APP_CLIENTS.find((c) => c.id === client)!.name;
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Ein eigener Server taugt als Ziel, wenn die App mit einem Server synchronisiert, der nicht der lokale ist. */
export function serverTarget(sync: { url: string; token: string } | undefined, localURL: string | undefined): { url: string; token: string } | undefined {
  if (!sync || !sync.url || !sync.token) return undefined;
  if (localURL && sync.url.replace(/\/+$/, "") === localURL.replace(/\/+$/, "")) return undefined;
  return { url: sync.url.replace(/\/+$/, ""), token: sync.token };
}
