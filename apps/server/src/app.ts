// Der TS-based-server als Ganzes: Routen (Sync v2, v1-Kompatibilität, MCP, Health) über einem SyncService.
import { createReadStream, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type SqlDatabase } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { ASSET_CHUNK_LIMIT, ASSET_HASH, AssetError, AssetStore, parseRange, referencedAssets } from "./assets.js";
import { Collab, YStateStore } from "./collab.js";
import { createLogger, type Logger } from "./log.js";
import { createMcpServer } from "./mcp.js";
import { Pages } from "./pages.js";
import { error, json, LARGE_BODY_LIMIT, Router } from "./router.js";
import type { CodingSessions } from "@based/brain";
import { registerCodingRoutes } from "./coding-routes.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";
import type { SandboxManager } from "./sandbox.js";
import { ShareService } from "./share.js";
import { principalOf, registerShareRoutes } from "./share-routes.js";
import { BadRequest, decodePush, DEFAULT_PAGE, SyncService, TOMBSTONE_RETENTION_DAYS, type SyncServiceOptions } from "./sync.js";

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
  /** Ordner für Dateien (Standard: `<db>.assets` neben der Datenbank, bei In-Memory ein temporärer Ordner). */
  assetsDir?: string;
  /** Größte Datei in Bytes (Standard 100 MiB). */
  maxAssetBytes?: number;
  /** Sandboxen pro Lauf (BSD-161); ohne: keine /sandbox-Routen. */
  sandbox?: SandboxManager | undefined;
  /** Coding-Agent-Sitzungen (BSD-223); ohne: keine /coding-Routen. */
  coding?: CodingSessions | undefined;
  /** Long-Poll-Grenze für /coding in ms (Tests kürzer). */
  codingLongPollMs?: number;
}

export interface App {
  sync: SyncService;
  assets: AssetStore;
  /** Nicht mehr referenzierte Dateien aufräumen (läuft mit der Tombstone-GC; für Tests einzeln aufrufbar). */
  collectAssets(nowMillis?: number): { removed: number; marked: number; partials: number };
  pages: Pages;
  /** Freigaben, Links, Veröffentlichen (docs/sharing.md). */
  share: ShareService;
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
  const share = new ShareService(sync.store, sync.persistence, opts.nowMillis);
  const router = new Router({ token: opts.token, allowedOrigin: opts.allowedOrigin, log, sharedPrincipal: (t) => share.principal(t) });
  const collabPath = opts.collabDb ?? (typeof opts.db === "string" && opts.db !== ":memory:" ? opts.db.replace(/(\.sqlite)?$/, ".collab.sqlite") : ":memory:");
  const collabDb = typeof collabPath === "string" ? openNodeDatabase(collabPath) : collabPath;
  const collab = new Collab({ store: sync.store, states: new YStateStore(collabDb), token: opts.token, log, ...(opts.collabDebounce !== undefined ? { debounce: opts.collabDebounce } : {}) });

  const persistentDb = typeof opts.db === "string" && opts.db !== ":memory:";
  const temporaryAssets = !opts.assetsDir && !persistentDb;
  const assets = new AssetStore(
    opts.assetsDir ?? (persistentDb ? (opts.db as string).replace(/(\.sqlite)?$/, ".assets") : mkdtempSync(join(tmpdir(), "based-assets-"))),
    { ...(opts.maxAssetBytes !== undefined ? { maxBytes: opts.maxAssetBytes } : {}), ...(opts.nowMillis ? { nowMillis: opts.nowMillis } : {}) },
  );
  const collectAssets = (nowMillis?: number) => assets.collect(referencedAssets(sync.store), TOMBSTONE_RETENTION_DAYS, nowMillis);

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

  // MARK: Sync v2 (docs/sync-protocol.md). Gäste (Geräte-Token, Access-Link) sehen nur ihren Bereich (docs/sharing.md).
  router.add("GET", "/sync/v2/info", () => json({ ...sync.info(), assets: { maxBytes: assets.maxBytes, chunkBytes: ASSET_CHUNK_LIMIT } }), { access: "shared" });
  router.add("GET", "/sync/v2/pull", ({ url, caller }) =>
    handle(() => json(share.pull(principalOf(caller), sync, intParam(url, "after", 0), intParam(url, "limit", DEFAULT_PAGE)))), { access: "shared" });
  router.add("POST", "/sync/v2/push", ({ body, caller }) =>
    handle(() => {
      const p = principalOf(caller);
      const { rejected, ...reply } = share.push(p, sync, decodePush(parseJSON(body)));
      if (rejected.length > 0) log.info("share: rejected records from a shared principal", { count: rejected.length });
      return json(reply);
    }), { bodyLimit: LARGE_BODY_LIMIT, access: "shared" });
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
  }, { access: "shared" });

  // MARK: Assets (BSD-78, docs/sync-protocol.md „Assets“): inhaltsadressierte Blobs, Schlüssel = SHA-256
  const assetHash = (params: Record<string, string>) => {
    const h = params.hash ?? "";
    if (!ASSET_HASH.test(h)) throw new BadRequest("asset id must be a lowercase hex SHA-256");
    return h;
  };
  const assetReply = async (f: () => Promise<ReturnType<typeof json>> | ReturnType<typeof json>) => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof BadRequest) return error(e.message, 400);
      if (e instanceof AssetError) return json({ error: e.message, ...e.extra }, e.status);
      throw e;
    }
  };
  // Gäste: lesen nur Dateien aus ihrem Bereich, hochladen nur mit Bearbeiten-Rolle.
  const guestMayRead = (caller: Parameters<typeof principalOf>[0], hash: string) => share.canReadAsset(principalOf(caller), hash);
  const guestMayWrite = (caller: Parameters<typeof principalOf>[0]) => {
    const p = principalOf(caller);
    return p.kind === "owner" || share.roots(p).some((r) => r.role === "edit" || r.role === "full");
  };
  router.add("GET", "/sync/v2/asset/:hash/status", ({ params, caller }) =>
    assetReply(() => (guestMayWrite(caller) ? json(assets.status(assetHash(params))) : error("forbidden", 403))), { access: "shared" });
  router.add("HEAD", "/sync/v2/asset/:hash", ({ params, caller }) =>
    assetReply(() => {
      const hash = assetHash(params);
      if (!guestMayRead(caller, hash)) return { status: 404 };
      const found = assets.locate(hash);
      return found ? { status: 200, headers: { "Content-Length": String(found.size), "Content-Type": "application/octet-stream" } } : { status: 404 };
    }), { access: "shared" },
  );
  router.add(
    "PUT",
    "/sync/v2/asset/:hash",
    ({ params, url, body, caller }) =>
      assetReply(async () => {
        if (!guestMayWrite(caller)) return error("forbidden", 403);
        const hash = assetHash(params);
        const offset = intParam(url, "offset", 0);
        const total = intParam(url, "total", offset + body.length);
        const status = await assets.write(hash, offset, total, body);
        if (status.complete) log.info("asset stored", { bytes: status.received });
        return json(status, status.complete ? 200 : 202);
      }),
    { bodyLimit: ASSET_CHUNK_LIMIT, access: "shared" },
  );
  router.add("GET", "/sync/v2/asset/:hash", ({ params, req, res, caller }) =>
    assetReply(() => {
      const hash = assetHash(params);
      if (!guestMayRead(caller, hash)) return error("not found", 404);
      const found = assets.locate(hash);
      if (!found) return error("not found", 404);
      const range = parseRange(req.headers.range, found.size);
      if (range === null) return { status: 416, json: { error: "range not satisfiable", size: found.size }, headers: { "Content-Range": `bytes */${found.size}` } };
      const start = range?.start ?? 0, end = range?.end ?? found.size - 1;
      // Inhalt ist unveränderlich (der Name ist sein Hash); nie als HTML ausliefern.
      res.writeHead(range ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(found.size === 0 ? 0 : end - start + 1),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${found.size}` } : {}),
      });
      if (found.size === 0) res.end();
      else createReadStream(found.path, { start, end }).on("error", () => res.destroy()).pipe(res);
      return undefined;
    }), { access: "shared" },
  );

  // MARK: Teilen (docs/sharing.md)
  registerShareRoutes(router, { share, sync, assets, log });
  if (opts.sandbox) registerSandboxRoutes(router, opts.sandbox, log);
  if (opts.coding) registerCodingRoutes(router, opts.coding, log, opts.codingLongPollMs);

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
    try {
      const r = collectAssets();
      if (r.removed > 0 || r.partials > 0) log.info("collected unreferenced assets", { removed: r.removed, partials: r.partials, marked: r.marked });
    } catch (e) {
      log.warning("asset collection failed", { error: e instanceof Error ? e.name : "unknown" });
    }
  };
  if (opts.compactEvery !== false) {
    compact();
    gc = setInterval(compact, opts.compactEvery ?? 3_600_000);
    gc.unref();
  }

  return {
    sync,
    assets,
    collectAssets,
    pages,
    share,
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
      if (opts.sandbox) await opts.sandbox.stopAll();
      opts.coding?.closeAll();
      sync.close(); // offene Long-Polls antworten sofort
      pages.dispose();
      await collab.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
      collabDb.close();
      if (temporaryAssets) assets.destroy();
    },
  };
}
