// Der TS-based-server als Ganzes: Routen (Sync v2, v1-Kompatibilität, MCP, Health) über einem SyncService.
import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type SqlDatabase } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { Collab, YStateStore } from "./collab.js";
import { createLogger, type Logger } from "./log.js";
import { createMcpServer } from "./mcp.js";
import { Pages } from "./pages.js";
import { error, json, LARGE_BODY_LIMIT, Router } from "./router.js";
import { BadRequest, DEFAULT_PAGE, SyncService, type SyncServiceOptions } from "./sync.js";

export interface AppOptions extends SyncServiceOptions {
  token: string;
  /** SQLite-Datei (Standard: im Speicher, nur für Tests). */
  db?: string | SqlDatabase;
  allowedOrigin?: string | undefined;
  log?: Logger;
  /** Tombstone-GC beim Start und dann stündlich (Standard an). */
  compactEvery?: number | false;
  /** Y-Zustände für /collab (Standard: `<db>` mit Endung `.collab.sqlite`, bei In-Memory im Speicher). */
  collabDb?: string | SqlDatabase;
  /** Hocuspocus speichert nach so vielen ms Ruhe. */
  collabDebounce?: number;
}

export interface App {
  sync: SyncService;
  pages: Pages;
  collab: Collab;
  router: Router;
  server: Server;
  log: Logger;
  /** Lauscht auf `port` (0 = frei wählen); gibt die Adresse zurück. */
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

/** Ganzzahl ≥ 0 aus der Query, sonst BadRequest. */
function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new BadRequest(`${name} must be a non-negative integer`);
  return Number(raw);
}

function parseJSON(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

export function createApp(opts: AppOptions): App {
  if (!opts.token) throw new Error("A token is required (BASED_TOKEN or --token)");
  const log = opts.log ?? createLogger();
  const db = typeof opts.db === "string" || opts.db === undefined ? openNodeDatabase(opts.db ?? ":memory:") : opts.db;
  const sync = new SyncService(db, opts);
  const pages = new Pages(sync.store);
  const router = new Router({ token: opts.token, allowedOrigin: opts.allowedOrigin, log });
  const collabPath = opts.collabDb ?? (typeof opts.db === "string" && opts.db !== ":memory:" ? opts.db.replace(/(\.sqlite)?$/, ".collab.sqlite") : ":memory:");
  const collabDb = typeof collabPath === "string" ? openNodeDatabase(collabPath) : collabPath;
  const collab = new Collab({ store: sync.store, states: new YStateStore(collabDb), token: opts.token, log, ...(opts.collabDebounce !== undefined ? { debounce: opts.collabDebounce } : {}) });

  // 400 statt 500 für kaputte Anfragen; Meldungen ohne Inhalte.
  const handle = <T>(f: () => T) => {
    try {
      return f();
    } catch (e) {
      if (e instanceof BadRequest) return error(e.message, 400);
      throw e;
    }
  };

  // MARK: öffentlich
  const health = () => json({ ok: true, name: "based-server", impl: "ts", protocol: 2, time: new Date().toISOString() });
  router.add("GET", "/health", health, { access: "public" });
  router.add("GET", "/", health, { access: "public" });

  // MARK: Sync v2 (docs/sync-protocol.md)
  router.add("GET", "/sync/v2/info", () => json(sync.info()));
  router.add("GET", "/sync/v2/pull", ({ url }) => handle(() => json(sync.pull(intParam(url, "after", 0), intParam(url, "limit", DEFAULT_PAGE)))));
  router.add("POST", "/sync/v2/push", ({ body }) => handle(() => json(sync.push(parseJSON(body)))), { bodyLimit: LARGE_BODY_LIMIT });
  router.add("GET", "/sync/v2/wait", async ({ url, signal }) => {
    let after: number, timeout: number;
    try {
      after = intParam(url, "after", 0);
      const t = url.searchParams.get("timeout");
      timeout = t === null || t === "" ? 25 : Number(t);
      if (!Number.isFinite(timeout)) throw new BadRequest("timeout must be a number");
    } catch (e) {
      if (e instanceof BadRequest) return error(e.message, 400);
      throw e;
    }
    return json({ seq: await sync.wait(after, timeout, signal) });
  });

  // MARK: Sync v1 (nur für sehr alte Apps)
  router.add("GET", "/sync/pull", ({ url }) =>
    handle(() => {
      const raw = url.searchParams.get("since");
      let since;
      if (raw) {
        const v = (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            throw new BadRequest("since must be a JSON stamp");
          }
        })() as { millis?: unknown; counter?: unknown; node?: unknown };
        if (typeof v?.millis !== "number" || typeof v.counter !== "number" || typeof v.node !== "string") throw new BadRequest("since must be a JSON stamp");
        since = { millis: v.millis, counter: v.counter, node: v.node };
      }
      return json(sync.pullV1(since));
    }),
  );
  router.add("POST", "/sync/push", ({ body }) => handle(() => json(sync.pushV1(parseJSON(body)))), { bodyLimit: LARGE_BODY_LIMIT });

  // MARK: MCP (Streamable HTTP, zustandslos: pro Anfrage ein Server + Transport, JSON-Antworten)
  router.add(
    "POST",
    "/mcp",
    async ({ req, res, body }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
      }
      const server = createMcpServer(pages);
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }) // ohne sessionIdGenerator: zustandslos;
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return undefined;
    },
    { bodyLimit: LARGE_BODY_LIMIT },
  );
  const noSSE = () => ({ status: 405, json: { error: "SSE streaming is not supported; use POST /mcp (Streamable HTTP, JSON responses)." }, headers: { Allow: "POST" } });
  router.add("GET", "/mcp", noSSE);
  router.add("DELETE", "/mcp", noSSE);

  const server = createServer({ requestTimeout: 120_000, headersTimeout: 30_000, keepAliveTimeout: 5_000 }, (req, res) => void router.handle(req, res));
  // Long-Polls dauern bis 55 s; alles andere bricht nach requestTimeout ab.
  server.timeout = 0;
  collab.attach(server);

  let gc: NodeJS.Timeout | undefined;
  const compact = () => {
    try {
      const n = sync.compactTombstones();
      if (n > 0) log.info("compacted tombstones", { count: n });
    } catch (e) {
      log.warning("tombstone compaction failed", { error: e instanceof Error ? e.name : "unknown" });
    }
  };
  if (opts.compactEvery !== false) {
    compact();
    gc = setInterval(compact, opts.compactEvery ?? 3_600_000);
    gc.unref();
  }

  return {
    sync,
    pages,
    collab,
    router,
    server,
    log,
    listen(port, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const p = typeof addr === "object" && addr ? addr.port : port;
          resolve({ port: p, url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${p}` });
        });
      });
    },
    async close() {
      if (gc) clearInterval(gc);
      sync.close(); // offene Long-Polls antworten sofort
      pages.dispose();
      await collab.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
      collabDb.close();
    },
  };
}
