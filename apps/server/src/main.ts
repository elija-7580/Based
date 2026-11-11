// based-server (TypeScript) – Einstieg. Sync v2 + MCP über HTTP, oder MCP über stdio.
//   pnpm --filter @based/server start -- --token <secret> [--db based.sqlite] [--port 8787] [--host 0.0.0.0]
//   pnpm --filter @based/server start -- --stdio --db based.sqlite        (MCP für Desktop-Clients)
// Konfiguration auch über BASED_TOKEN, BASED_DB, BASED_PORT, BASED_HOST, BASED_NODE, BASED_PUBLIC_URL,
// BASED_LOG_LEVEL, BASED_CODING_ROOTS (Ordner mit „:“ getrennt), BASED_CODING_ENV. Ohne Token startet der HTTP-Server nicht (Exit-Code 2).
import { readFileSync } from "node:fs";
import { CodingSessions, DEFAULT_AGENTS, type AcpMcpServer, type AgentDefinition } from "@based/brain";
import { spawnAgent } from "@based/brain/acp-node";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openNodeDatabase } from "@based/sync/node";
import { createApp } from "./app.js";
import { anthropicAgentEngine } from "./agent-engine.js";
import type { WorkspaceStore } from "@based/core";
import { DockerSandboxProvider, LocalSandboxProvider, SandboxManager } from "./sandbox.js";
import { createLogger, parseLogLevel, type Logger } from "./log.js";
import { createMcpServer } from "./mcp.js";
import { Pages } from "./pages.js";
import { SyncService } from "./sync.js";

export interface Options {
  db: string;
  port: number;
  host: string;
  token: string;
  node: string;
  stdio: boolean;
  publicURL: string | undefined;
  /** BSD-235: Web-Client für den Gast-Modus („Open in Based“ auf Access-Links). */
  webURL: string | undefined;
  /** Ordner für Dateien (Standard: neben der Datenbank). */
  assetsDir: string | undefined;
  /** Größte Datei in MiB. */
  maxAssetMB: number | undefined;
  /** Sandbox pro Lauf: docker, local oder aus (Standard). */
  sandbox: "docker" | "local" | undefined;
  /** Ordner für Snapshot-Archive (Standard: `<db>.sandbox`). */
  sandboxDir: string | undefined;
  /** BSD-223: Ordner, in denen Coding-Agenten laufen dürfen (leer = Coding-Agenten aus). */
  codingRoots: string[];
  /** BSD-223: pro Agent freigegebene Umgebungsvariablen (`claude=ANTHROPIC_API_KEY,gemini=GEMINI_API_KEY`). */
  codingEnv: Record<string, string[]>;
  /** BSD-223: JSON-Datei mit eigenen bzw. geänderten Agenten (Liste von AgentDefinition-Teilen, nach `id` gemischt). */
  codingAgents: string | undefined;
}

export const USAGE = "usage: based-server --token <secret> [--db based.sqlite] [--port 8787] [--host 0.0.0.0] [--node server] [--public-url https://…] [--web-url https://…] [--assets <dir>] [--max-asset-mb 100] [--sandbox docker|local] [--sandbox-dir <dir>] [--coding-root <dir>]… [--coding-agents agents.json] | --stdio [--db …]";

/** Optionen aus Argumenten und Umgebung; wirft bei unbekannten Optionen. */
export function parseOptions(argv: string[], env: Record<string, string | undefined>): Options {
  const o: Options = {
    db: env.BASED_DB ?? "based.sqlite",
    port: Number(env.BASED_PORT ?? 8787),
    host: env.BASED_HOST ?? "0.0.0.0",
    token: env.BASED_TOKEN ?? "",
    node: env.BASED_NODE ?? "server",
    stdio: false,
    publicURL: env.BASED_PUBLIC_URL,
    webURL: env.BASED_WEB_URL,
    assetsDir: env.BASED_ASSETS_DIR,
    maxAssetMB: env.BASED_MAX_ASSET_MB ? Number(env.BASED_MAX_ASSET_MB) : undefined,
    sandbox: undefined,
    sandboxDir: env.BASED_SANDBOX_DIR,
    codingRoots: (env.BASED_CODING_ROOTS ?? "").split(":").filter((r) => r !== ""),
    codingEnv: parseCodingEnv(env.BASED_CODING_ENV),
    codingAgents: env.BASED_CODING_AGENTS,
  };
  let sandbox = env.BASED_SANDBOX;
  const args = [...argv];
  const value = (name: string) => {
    const v = args.shift();
    if (v === undefined) throw new Error(`${name} needs a value`);
    return v;
  };
  while (args.length > 0) {
    const a = args.shift()!;
    switch (a) {
      case "--": break;
      case "--db": o.db = value(a); break;
      case "--port": o.port = Number(value(a)); break;
      case "--host": o.host = value(a); break;
      case "--token": o.token = value(a); break;
      case "--node": o.node = value(a); break;
      case "--public-url": o.publicURL = value(a); break;
      case "--web-url": o.webURL = value(a); break;
      case "--assets": o.assetsDir = value(a); break;
      case "--max-asset-mb": o.maxAssetMB = Number(value(a)); break;
      case "--sandbox": sandbox = value(a); break;
      case "--sandbox-dir": o.sandboxDir = value(a); break;
      case "--coding-root": o.codingRoots.push(value(a)); break;
      case "--coding-agents": o.codingAgents = value(a); break;
      case "--stdio": o.stdio = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (sandbox !== undefined && sandbox !== "" && sandbox !== "off") {
    if (sandbox !== "docker" && sandbox !== "local") throw new Error("--sandbox must be docker, local or off");
    o.sandbox = sandbox;
  }
  if (o.codingRoots.some((r) => !r.startsWith("/"))) throw new Error("--coding-root must be an absolute path");
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("--port must be 0…65535");
  if (o.maxAssetMB !== undefined && !(o.maxAssetMB > 0)) throw new Error("--max-asset-mb must be a positive number");
  return o;
}

/** `claude=ANTHROPIC_API_KEY,gemini=GEMINI_API_KEY` → { claude: [...], gemini: [...] } (nur Namen, nie Werte). */
export function parseCodingEnv(raw: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of (raw ?? "").split(/[,;\s]+/)) {
    const m = /^([A-Za-z0-9_-]+)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(part);
    if (m) (out[m[1]!] ??= []).push(m[2]!);
  }
  return out;
}

/** Standard-Agenten, mit einer Liste aus der Datei gemischt (gleiche `id` ändert, neue kommen dazu). */
export function mergeAgents(defaults: readonly AgentDefinition[], extra: unknown): AgentDefinition[] {
  const out = defaults.map((a) => ({ ...a }));
  if (!Array.isArray(extra)) throw new Error("--coding-agents: expected a JSON array of agents");
  for (const raw of extra as Record<string, unknown>[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("--coding-agents: every agent needs an id (letters, digits, - and _)");
    const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
    const env = raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string> : undefined;
    const prev = out.find((a) => a.id === id);
    const next: AgentDefinition = {
      id,
      name: typeof raw.name === "string" ? raw.name : prev?.name ?? id,
      command: typeof raw.command === "string" ? raw.command : prev?.command ?? "",
      args: strings(raw.args) ?? prev?.args ?? [],
      env: env ?? prev?.env ?? {},
      icon: typeof raw.icon === "string" ? raw.icon : prev?.icon ?? "terminal",
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : prev?.enabled ?? true,
      note: typeof raw.note === "string" ? raw.note : prev?.note ?? "",
    };
    if (!next.command) throw new Error(`--coding-agents: agent ${id} needs a command`);
    if (prev) Object.assign(prev, next); else out.push(next);
  }
  return out;
}

/** Coding-Agenten (Standard plus `--coding-agents`); Prozesse über `@based/brain/acp-node`. */
function codingSessions(opts: Options, log: Logger, self: () => AcpMcpServer[] = () => []): CodingSessions {
  const agents = opts.codingAgents ? mergeAgents(DEFAULT_AGENTS, JSON.parse(readFileSync(opts.codingAgents, "utf8")) as unknown) : [...DEFAULT_AGENTS];
  return new CodingSessions({
    agents: () => agents,
    roots: opts.codingRoots,
    // BSD-257: Chat-Sitzungen (ChatGPT über Codex) bekommen die Werkzeuge des Workspaces über das eigene /mcp.
    chatMcpServers: self,
    connect: (agent, cwd, roots, permissions) =>
      spawnAgent(agent, { cwd, allowedRoots: roots, permissions, approvedEnv: opts.codingEnv[agent.id] ?? [], onLog: (l) => log.debug("coding agent stderr", { agent: agent.id, bytes: l.length }) }),
  });
}

/** Adresse, unter der der Server sich selbst erreicht (Wildcard → Loopback). */
export function selfHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** Origin (scheme://host[:port]) von BASED_PUBLIC_URL, der einzige mit CORS-Zugriff. */
export function allowedOrigin(publicURL: string | undefined): string | undefined {
  if (!publicURL) return undefined;
  try {
    const u = new URL(publicURL);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function sandboxManager(opts: Options): SandboxManager {
  const snapshotDirectory = opts.sandboxDir ?? opts.db.replace(/(\.sqlite)?$/, ".sandbox");
  return new SandboxManager(opts.sandbox === "docker" ? new DockerSandboxProvider({ snapshotDirectory }) : new LocalSandboxProvider({ snapshotDirectory }));
}

async function main() {
  const log = createLogger({ minimum: parseLogLevel(process.env.BASED_LOG_LEVEL) ?? "info" });
  let opts: Options;
  try {
    if (process.argv.includes("-h") || process.argv.includes("--help")) {
      process.stdout.write(USAGE + "\n");
      return;
    }
    opts = parseOptions(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    process.exit(2);
  }

  if (opts.stdio) {
    // stdio ist lokal (der Client startet den Prozess): kein Token nötig. stdout gehört dem Protokoll.
    const sync = new SyncService(openNodeDatabase(opts.db), { node: opts.node });
    const server = createMcpServer(new Pages(sync.store));
    await server.connect(new StdioServerTransport());
    log.info("mcp on stdio", { db: opts.db });
    return;
  }

  if (!opts.token) {
    process.stderr.write("based-server: no token. Set BASED_TOKEN or pass --token <secret>; the server does not start without one.\n");
    process.exit(2);
  }
  if (opts.token.length < 16) log.warning("token is shorter than 16 characters");

  const bound: { port?: number } = {};
  const token = opts.token;
  const selfMcp = (): AcpMcpServer[] => (bound.port ? [{ name: "based", url: `http://${selfHost(opts.host)}:${bound.port}/mcp`, headers: { Authorization: `Bearer ${token}` } }] : []);
  const app = createApp({ token: opts.token, db: opts.db, node: opts.node, allowedOrigin: allowedOrigin(opts.publicURL),
    log,
    ...(opts.webURL ? { webURL: opts.webURL } : {}),
    // BSD-243 Teil 2: mit Modellzugang führt der Server Zeitplan-Läufe selbst aus (sonst wartet die App).
    ...(process.env.BASED_ANTHROPIC_API_KEY ? { agentEngine: (store: WorkspaceStore) => anthropicAgentEngine(store, { apiKey: process.env.BASED_ANTHROPIC_API_KEY ?? "", model: process.env.BASED_AGENT_MODEL }) } : {}),
    ...(opts.assetsDir ? { assetsDir: opts.assetsDir } : {}),
    ...(opts.maxAssetMB !== undefined ? { maxAssetBytes: Math.floor(opts.maxAssetMB * (1 << 20)) } : {}),
    ...(opts.sandbox ? { sandbox: sandboxManager(opts) } : {}),
    ...(opts.codingRoots.length > 0 ? { coding: codingSessions(opts, log, selfMcp), codingHost: { home: homedir(), env: process.env, approvedEnv: opts.codingEnv } } : {}),
  });
  const { port } = await app.listen(opts.port, opts.host);
  bound.port = port;
  log.info("based-server listening", { host: opts.host, port, db: opts.db, routes: app.router.routes.length, impl: "ts" });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

const isEntry = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) void main();
