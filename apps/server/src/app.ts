// Der TS-based-server als Ganzes: Routen (Sync v2, v1-Kompatibilität, MCP, Health) über einem SyncService.
import { createReadStream, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parseKey, type WorkspaceStore } from "@based/core";
import { type SqlDatabase } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { ASSET_CHUNK_LIMIT, ASSET_HASH, AssetError, AssetStore, parseRange, referencedAssets } from "./assets.js";
import { Collab, YStateStore } from "./collab.js";
import { createLogger, type Logger } from "./log.js";
import { createMcpServer } from "./mcp.js";
import { Pages } from "./pages.js";
import { error, json, LARGE_BODY_LIMIT, Router, tokenEquals, type Caller } from "./router.js";
import type { AgentRunnerOptions, CodingSessions, PtyFactory } from "@based/brain";
import { registerCodingRoutes, type CodingHost } from "./coding-routes.js";
import { TerminalSockets } from "./terminal-ws.js";
import { OwnerDevices } from "./devices.js";
import { Backups } from "./backups.js";
import { FolderSyncService } from "./folder-sync.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";
import type { SandboxManager } from "./sandbox.js";
import { ShareService } from "./share.js";
import { Scheduler } from "./scheduler.js";
import { principalOf, registerShareRoutes } from "./share-routes.js";
import { BadRequest, ProtocolMismatch, PROTOCOL_HEADER, WaitLimit, decodePush, DEFAULT_PAGE, SyncService, TOMBSTONE_RETENTION_DAYS, type SyncServiceOptions } from "./sync.js";

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
  /** Rechner der Agenten (CLI-Verlauf, Setup-Doctor); ohne: diese Routen fehlen. */
  codingHost?: CodingHost | undefined;
  /** BSD-274: Ordner für automatische Backups (stündlich bei Änderungen, beim Beenden); ohne: keine. */
  backupDir?: string | undefined;
  /** BSD-334: Ordner-Sync (iCloud Drive) – Ordner und Kennung dieses Geräts; ohne: keiner. */
  folderSync?: { dir: string; device: string; intervalMs?: number } | undefined;
  /** Takt der Backups in ms (Tests); Standard 1 h. */
  backupEvery?: number;
  /** BSD-314: PTY-Start für Terminals (Tests); `null` = kein Terminal; ohne Angabe node-pty. */
  ptySpawn?: PtyFactory | null;
  /** BSD-235: Adresse des Web-Clients; Access-Links bieten dann „Open in Based“ (Gast-Modus) an. */
  webURL?: string | undefined;
  /** BSD-243: Abstand der Zeitplan-Prüfung in ms (Standard 30 000; `false` = aus). */
  scheduleEvery?: number | false;
  /** BSD-243 Teil 2: Modell für Läufe auf dem Server (ohne: Läufe warten auf eine offene App). */
  agentEngine?: ((store: WorkspaceStore) => AgentRunnerOptions["engine"]) | undefined;
}

export interface App {
  sync: SyncService;
  assets: AssetStore;
  /** Nicht mehr referenzierte Dateien aufräumen (läuft mit der Tombstone-GC; für Tests einzeln aufrufbar). */
  collectAssets(nowMillis?: number): { removed: number; marked: number; partials: number };
  pages: Pages;
  /** Freigaben, Links, Veröffentlichen (docs/sharing.md). */
  share: ShareService;
  /** BSD-243: fällige Zeitpläne → Run-Records, auch ohne offene App. */
  scheduler: Scheduler;
  collab: Collab;
  /** BSD-334: Ordner-Sync, wenn eingeschaltet. */
  folderSync: FolderSyncService | undefined;
  router: Router;
  server: Server;
  log: Logger;
  /** Lauscht auf `port` (0 = frei wählen); gibt die Adresse zurück. */
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
  /** BSD-315: zusätzlich auf einer weiteren Adresse lauschen (Tailscale), gleicher Port, gleiche Routen. */
  listenAlso(port: number, host: string): Promise<void>;
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
  share.onScopeChange = () => sync.wake();
  const scheduler = new Scheduler(sync.store, { log, ...(opts.nowMillis ? { now: opts.nowMillis } : {}), ...(opts.scheduleEvery ? { intervalMs: opts.scheduleEvery } : {}),
    ...(opts.agentEngine ? { engine: opts.agentEngine(sync.store) } : {}) });
  if (opts.agentEngine) log.info("scheduler: runs execute on the server");
  if (opts.scheduleEvery !== false) scheduler.start();
  // BSD-315: eigene Geräte des Besitzers (Handy im Tailnet) mit eigenem, widerrufbarem Token.
  const devices = new OwnerDevices(db);
  const ownerToken = (t: string) => tokenEquals(t, opts.token) || devices.check(t) !== undefined;
  const router = new Router({ token: opts.token, allowedOrigin: opts.allowedOrigin, log, sharedPrincipal: (t) => share.principal(t), ownerDevice: (t) => devices.check(t)?.id });
  const collabPath = opts.collabDb ?? (typeof opts.db === "string" && opts.db !== ":memory:" ? opts.db.replace(/(\.sqlite)?$/, ".collab.sqlite") : ":memory:");
  const collabDb = typeof collabPath === "string" ? openNodeDatabase(collabPath) : collabPath;
  const collab = new Collab({ store: sync.store, states: new YStateStore(collabDb), token: opts.token, acceptToken: ownerToken, log, ...(opts.collabDebounce !== undefined ? { debounce: opts.collabDebounce } : {}) });

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
      // BSD-30: Client und Server sprechen nicht dasselbe Format (426 = App aktualisieren, 409 = Server noch alt)
      if (e instanceof ProtocolMismatch) return error(e.message, e.status);
      throw e;
    }
  };
  const sameProtocol = (req: { headers: Record<string, string | string[] | undefined> }) => sync.checkProtocol(req.headers[PROTOCOL_HEADER]);

  // MARK: öffentlich
  const health = () => json({ ok: true, name: "based-server", impl: "ts", protocol: sync.protocol, time: new Date().toISOString() });
  router.add("GET", "/health", health, { access: "public" });
  router.add("GET", "/", health, { access: "public" });

  // MARK: Sync v2 (docs/sync-protocol.md). Gäste (Geräte-Token, Access-Link) sehen nur ihren Bereich (docs/sharing.md).
  // BSD-243: `agents.runsOnServer` – Zeitpläne laufen auch bei geschlossener App (Modell auf dem Server eingerichtet).
  router.add("GET", "/sync/v2/info", () => json({ ...sync.info(), assets: { maxBytes: assets.maxBytes, chunkBytes: ASSET_CHUNK_LIMIT }, agents: { runsOnServer: scheduler.executes } }), { access: "shared" });
  router.add("GET", "/sync/v2/pull", ({ url, caller, req }) =>
    handle(() => (sameProtocol(req), json(share.pull(principalOf(caller), sync, intParam(url, "after", 0), intParam(url, "limit", DEFAULT_PAGE))))), { access: "shared" });
  router.add("POST", "/sync/v2/push", ({ body, caller, req }) =>
    handle(() => {
      sameProtocol(req);
      const p = principalOf(caller);
      const { rejected, ...reply } = share.push(p, sync, decodePush(parseJSON(body)));
      if (rejected.length > 0) log.info("share: rejected records from a shared principal", { count: rejected.length });
      // BSD-285: abgelehnte Records eigens nennen – das Gerät übernimmt die Server-Kopie dann trotz eigenem Stempel.
      return json(rejected.length > 0 ? { ...reply, rejected: rejected.map((k) => parseKey(k)) } : reply);
    }), { bodyLimit: LARGE_BODY_LIMIT, access: "shared" });
  router.add("GET", "/sync/v2/wait", async ({ url, signal, caller, req }) => {
    let after: number, timeout: number;
    try {
      sameProtocol(req);
      after = intParam(url, "after", 0);
      const t = url.searchParams.get("timeout");
      timeout = t === null || t === "" ? 25 : Number(t);
      if (!Number.isFinite(timeout)) throw new BadRequest("timeout must be a number");
    } catch (e) {
      if (e instanceof BadRequest) return error(e.message, 400);
      if (e instanceof ProtocolMismatch) return error(e.message, e.status);
      throw e;
    }
    // BSD-75: Grenze je Client (Owner bzw. geteilter Principal); darüber 429 mit Retry-After statt offener Verbindung.
    const client = caller?.kind === "shared" ? "shared:" + JSON.stringify(caller.principal).slice(0, 200) : "owner";
    try {
      return json({ seq: await sync.wait(after, timeout, signal, client) });
    } catch (e) {
      if (e instanceof WaitLimit) {
        log.warning("long-poll limit", { scope: e.scope, waiting: sync.waiting });
        return { status: 429, json: { error: e.message }, headers: { "Retry-After": "5" } };
      }
      throw e;
    }
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
  registerShareRoutes(router, { share, sync, assets, log, webURL: opts.webURL });
  if (opts.sandbox) registerSandboxRoutes(router, opts.sandbox, log);
  if (opts.coding) registerCodingRoutes(router, opts.coding, log, opts.codingLongPollMs, opts.codingHost);

  // MARK: Backups (BSD-274)
  const backups = opts.backupDir ? new Backups(opts.backupDir, sync.store, assets, log) : undefined;
  // BSD-334: Ordner-Sync – nach Backups, damit ein Stand vor dem ersten Einmischen gesichert werden kann
  const folderSync = opts.folderSync
    ? new FolderSyncService({ ...opts.folderSync, store: sync.store, persistence: sync.persistence, assets, log, referencedAssets: () => referencedAssets(sync.store) })
    : undefined;
  if (folderSync) {
    folderSync.start();
    router.add("GET", "/folder-sync", async () => json({ dir: opts.folderSync!.dir, device: opts.folderSync!.device, lastRound: folderSync.lastRound ?? null, error: folderSync.lastError ?? null, state: folderSync.sync.state() }));
    router.add("POST", "/folder-sync", async () => { await folderSync.round(); return json({ lastRound: folderSync.lastRound ?? null, error: folderSync.lastError ?? null }); });
  }
  if (backups) {
    backups.start(opts.backupEvery);
    const nameOK = (n: string) => /^[0-9T-]+Z\.based\.jsonl$/.test(n);
    router.add("GET", "/backups", async () => json({ dir: backups.dir, last: backups.last, error: backups.lastError, snapshots: await backups.list() }));
    router.add("POST", "/backups", async () => json({ snapshot: (await backups.snapshot(true)) ?? null }, 201));
    router.add("GET", "/backups/:name/preview", async ({ params }) => nameOK(params.name!) ? json({ pages: await backups.preview(params.name!) }) : error("not a backup", 400));
    router.add("POST", "/backups/:name/restore", async ({ params }) => nameOK(params.name!) ? json(await backups.restore(params.name!)) : error("not a backup", 400));
  }

  // MARK: Eigene Geräte (BSD-315). Verwalten nur mit dem Haupt-Token, nicht mit einem Geräte-Token.
  const mainOnly = (caller: Caller<unknown> | undefined) => caller?.kind === "owner" && caller.device === undefined;
  router.add("GET", "/devices", ({ caller }) => json({ devices: devices.list(), current: caller?.kind === "owner" ? caller.device : undefined }));
  router.add("POST", "/devices", ({ caller, body }) => {
    if (!mainOnly(caller)) return error("devices can only be added with the main token", 403);
    let name = "";
    try { const v = JSON.parse(body.toString("utf8")) as { name?: unknown }; name = typeof v.name === "string" ? v.name : ""; } catch { /* leer */ }
    const r = devices.add(name);
    log.info("device added", { device: r.device.id });
    return json({ device: r.device, token: r.token }, 201);
  });
  router.add("DELETE", "/devices/:id", ({ caller, params }) => {
    if (!mainOnly(caller)) return error("devices can only be removed with the main token", 403);
    return devices.remove(params.id!) ? json({ ok: true }) : error("device not found", 404);
  });

  // MARK: Sync v1 (nur für sehr alte Apps)
  router.add("GET", "/sync/pull", ({ url, req }) =>
    handle(() => {
      sameProtocol(req);
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
  router.add("POST", "/sync/push", ({ body, req }) => handle(() => (sameProtocol(req), json(sync.pushV1(parseJSON(body))))), { bodyLimit: LARGE_BODY_LIMIT });

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

  const makeServer = () => createServer({ requestTimeout: 120_000, headersTimeout: 30_000, keepAliveTimeout: 5_000 }, (req, res) => void router.handle(req, res));
  const server = makeServer();
  const extraServers: ReturnType<typeof makeServer>[] = [];
  // Long-Polls dauern bis 55 s; alles andere bricht nach requestTimeout ab.
  server.timeout = 0;
  // BSD-314: Terminal je Coding-Sitzung (WebSocket /coding/terminal/<id>), nur mit Coding-Agenten.
  const terminals = opts.coding ? new TerminalSockets(opts.coding, ownerToken, log, opts.ptySpawn) : undefined;
  collab.attach(server, terminals?.handle);

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
    folderSync,
    sync,
    assets,
    collectAssets,
    pages,
    share,
    scheduler,
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
    listenAlso(port, host) {
      const extra = makeServer();
      extra.timeout = 0;
      collab.attach(extra, terminals?.handle);
      extraServers.push(extra);
      return new Promise((resolve, reject) => {
        extra.once("error", reject);
        extra.listen(port, host, () => resolve());
      });
    },
    async close() {
      if (gc) clearInterval(gc);
      // BSD-274: beim Beenden noch einmal sichern (nur bei Änderungen)
      if (backups) { backups.stop(); await backups.snapshot().catch(() => undefined); }
      if (folderSync) await folderSync.stop().catch(() => undefined);
      for (const x of extraServers) { x.close(); x.closeAllConnections(); }
      if (opts.sandbox) await opts.sandbox.stopAll();
      opts.coding?.closeAll();
      terminals?.close();
      sync.close(); // offene Long-Polls antworten sofort
      share.close();
      scheduler.stop();
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
