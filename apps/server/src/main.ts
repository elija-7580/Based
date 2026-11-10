// based-server (TypeScript) – Einstieg. Sync v2 + MCP über HTTP, oder MCP über stdio.
//   pnpm --filter @based/server start -- --token <secret> [--db based.sqlite] [--port 8787] [--host 0.0.0.0]
//   pnpm --filter @based/server start -- --stdio --db based.sqlite        (MCP für Desktop-Clients)
// Konfiguration auch über BASED_TOKEN, BASED_DB, BASED_PORT, BASED_HOST, BASED_NODE, BASED_PUBLIC_URL,
// BASED_LOG_LEVEL. Ohne Token startet der HTTP-Server nicht (Exit-Code 2).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openNodeDatabase } from "@based/sync/node";
import { createApp } from "./app.js";
import { DockerSandboxProvider, LocalSandboxProvider, SandboxManager } from "./sandbox.js";
import { createLogger, parseLogLevel } from "./log.js";
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
  /** Ordner für Dateien (Standard: neben der Datenbank). */
  assetsDir: string | undefined;
  /** Größte Datei in MiB. */
  maxAssetMB: number | undefined;
  /** Sandbox pro Lauf: docker, local oder aus (Standard). */
  sandbox: "docker" | "local" | undefined;
  /** Ordner für Snapshot-Archive (Standard: `<db>.sandbox`). */
  sandboxDir: string | undefined;
}

export const USAGE = "usage: based-server --token <secret> [--db based.sqlite] [--port 8787] [--host 0.0.0.0] [--node server] [--public-url https://…] [--assets <dir>] [--max-asset-mb 100] [--sandbox docker|local] [--sandbox-dir <dir>] | --stdio [--db …]";

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
    assetsDir: env.BASED_ASSETS_DIR,
    maxAssetMB: env.BASED_MAX_ASSET_MB ? Number(env.BASED_MAX_ASSET_MB) : undefined,
    sandbox: undefined,
    sandboxDir: env.BASED_SANDBOX_DIR,
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
      case "--assets": o.assetsDir = value(a); break;
      case "--max-asset-mb": o.maxAssetMB = Number(value(a)); break;
      case "--sandbox": sandbox = value(a); break;
      case "--sandbox-dir": o.sandboxDir = value(a); break;
      case "--stdio": o.stdio = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (sandbox !== undefined && sandbox !== "" && sandbox !== "off") {
    if (sandbox !== "docker" && sandbox !== "local") throw new Error("--sandbox must be docker, local or off");
    o.sandbox = sandbox;
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("--port must be 0…65535");
  if (o.maxAssetMB !== undefined && !(o.maxAssetMB > 0)) throw new Error("--max-asset-mb must be a positive number");
  return o;
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

  const app = createApp({ token: opts.token, db: opts.db, node: opts.node, allowedOrigin: allowedOrigin(opts.publicURL),
    log,
    ...(opts.assetsDir ? { assetsDir: opts.assetsDir } : {}),
    ...(opts.maxAssetMB !== undefined ? { maxAssetBytes: Math.floor(opts.maxAssetMB * (1 << 20)) } : {}),
    ...(opts.sandbox ? { sandbox: sandboxManager(opts) } : {}),
  });
  const { port } = await app.listen(opts.port, opts.host);
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
