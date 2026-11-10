// BSD-222: Katalog bekannter MCP-Server (öffentliche Endpunkte laut Anbieter-Doku). `auth: "token"` = ein Token
// (z. B. Personal Access Token) im Header genügt; `"oauth"` = Anmeldung per Browser-Flow, den Based noch nicht hat
// (die Einträge stehen im Katalog, lassen sich aber erst mit eigenem Token/Server nutzen); `"none"` = offen.
// `stdio` braucht die Desktop-Hülle oder den Server (ein Prozess auf dem Gerät).

export type CatalogAuth = "token" | "oauth" | "none";

export interface CatalogEntry {
  id: string;
  name: string;
  /** Kurz, was man damit macht (Einstellungen). */
  purpose: string;
  transport: "http" | "stdio";
  /** HTTP: Endpunkt. */
  url?: string;
  /** stdio: Befehl und Argumente; `secretEnv` bekommt das Token. */
  command?: string;
  args?: string[];
  secretEnv?: string;
  auth: CatalogAuth;
  /** Wo man das Token bekommt bzw. die Doku des Servers. */
  docs: string;
}

export const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    id: "github", name: "GitHub", purpose: "Issues, pull requests, code search and repositories.",
    transport: "http", url: "https://api.githubcopilot.com/mcp/", auth: "token",
    docs: "https://github.com/github/github-mcp-server",
  },
  {
    id: "linear", name: "Linear", purpose: "Issues, projects and cycles.",
    transport: "http", url: "https://mcp.linear.app/mcp", auth: "token",
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "notion", name: "Notion", purpose: "Search and read Notion pages and databases.",
    transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth",
    docs: "https://developers.notion.com/docs/mcp",
  },
  {
    id: "sentry", name: "Sentry", purpose: "Errors, issues and releases.",
    transport: "http", url: "https://mcp.sentry.dev/mcp", auth: "oauth",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "slack", name: "Slack", purpose: "Channels, messages and search.",
    transport: "http", auth: "oauth",
    docs: "https://api.slack.com/",
  },
  {
    id: "google-drive", name: "Google Drive", purpose: "Find and read files in Drive.",
    transport: "http", auth: "oauth",
    docs: "https://developers.google.com/drive",
  },
  {
    id: "filesystem", name: "Files on this computer", purpose: "Read and write files in a folder you choose (desktop app).",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], auth: "none",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
];

export function catalogEntry(id: string | undefined): CatalogEntry | undefined {
  return id ? MCP_CATALOG.find((e) => e.id === id) : undefined;
}

/** Lässt sich der Eintrag heute verbinden (Web: nur HTTP mit Token oder offen)? */
export function catalogUsable(e: CatalogEntry, opts: { stdio: boolean }): boolean {
  if (e.auth === "oauth" || (e.transport === "http" && !e.url)) return false;
  return e.transport === "http" || opts.stdio;
}
