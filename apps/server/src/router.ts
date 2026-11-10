// Router mit Middleware-Kette wie Swift `ServerRouter` (ADR 0006): CORS-Preflight → Route suchen (404/405) →
// Body-Grenze (413) → Authentifizierung (nur Header, nie `?token=`) → Handler. Eine neue Route ist damit
// standardmäßig geschützt. Node-HTTP ohne Framework.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./log.js";

export const DEFAULT_BODY_LIMIT = 1 << 20; // 1 MiB
export const LARGE_BODY_LIMIT = 32 << 20; // 32 MiB: Sync-Pushes, MCP-Aufrufe mit Seiteninhalt

/** Wer eine Route aufrufen darf: niemand Bestimmtes, nur der Owner, oder Owner und geteilte Principals (docs/sharing.md). */
export type RouteAccess = "public" | "owner" | "shared";

/** Wer anfragt. `owner` = BASED_TOKEN; sonst ein geteilter Principal (Gerät eines Gasts, Access-Link). */
export type Caller<P> = { kind: "owner" } | { kind: "shared"; principal: P };

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Gelesener Body (leer bei GET). */
  body: Buffer;
  /** Werte der `:name`-Abschnitte des Routenpfads. */
  params: Record<string, string>;
  /** Wird ausgelöst, wenn der Client die Verbindung schließt. */
  signal: AbortSignal;
  /** Wer anfragt (bei öffentlichen Routen: Owner, wenn der Owner-Token mitkam, sonst undefined). */
  caller: Caller<unknown> | undefined;
}

/** Antwort eines Handlers; `undefined` = der Handler hat selbst geantwortet (MCP-Transport). */
export type RouteResult = { status: number; json?: unknown; text?: string; html?: string; body?: Buffer; headers?: Record<string, string> } | undefined;

/** Passt `path` auf das Muster (`/a/:name/b`)? Gibt die Parameter zurück. Ohne `:` nur exakter Vergleich. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  if (!pattern.includes(":")) return pattern === path ? {} : undefined;
  const a = pattern.split("/"), b = path.split("/");
  if (a.length !== b.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg.startsWith(":")) {
      if (!b[i]) return undefined;
      params[seg.slice(1)] = b[i]!;
    } else if (seg !== b[i]) return undefined;
  }
  return params;
}

export interface Route {
  method: string;
  path: string;
  access: RouteAccess;
  bodyLimit: number;
  handler: (ctx: RouteContext) => Promise<RouteResult> | RouteResult;
}

export const json = (value: unknown, status = 200): RouteResult => ({ status, json: value });
export const error = (message: string, status: number): RouteResult => ({ status, json: { error: message } });

/** Konstante Laufzeit: beide Seiten erst hashen (gleich lang), dann vergleichen. */
export function tokenEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim();
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners("data");
        reject(new BodyTooLarge());
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export interface RouterConfig {
  /** Owner-Token. Pflicht: der Server startet ohne Token nicht (main.ts). */
  token: string;
  /** Einziger Origin mit CORS-Headern (aus BASED_PUBLIC_URL); undefined = kein Cross-Origin-Zugriff. */
  allowedOrigin?: string | undefined;
  log: Logger;
  /** Geteilte Principals aus einem Token (Geräte-Token `bdu_…`, Link-Geheimnis `bdl_…`); ohne: nur der Owner. */
  sharedPrincipal?: ((token: string) => unknown) | undefined;
}

export class Router {
  readonly routes: Route[] = [];
  constructor(readonly config: RouterConfig) {
    if (!config.token) throw new Error("Router needs a token");
  }

  add(method: string, path: string, handler: Route["handler"], opts: { access?: RouteAccess; bodyLimit?: number } = {}) {
    this.routes.push({ method, path, handler, access: opts.access ?? "owner", bodyLimit: opts.bodyLimit ?? DEFAULT_BODY_LIMIT });
  }

  /** Node-`request`-Handler. */
  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    const origin = req.headers.origin;
    if (origin && this.config.allowedOrigin && origin === this.config.allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    let result: RouteResult;
    // Ins Log kommt das Muster der Route, nie der konkrete Pfad mit Kennungen.
    const matched = this.routes.find((r) => matchPath(r.path, path));
    const logPath = matched ? matched.path : path;
    try {
      result = await this.dispatch(req, res, url, path, controller.signal);
    } catch (e) {
      // Fehlermeldung ohne Inhalte: nur der Typ.
      this.config.log.error("handler failed", { method: req.method, path: logPath, error: e instanceof Error ? e.name : "unknown" });
      result = error("internal error", 500);
    }
    if (result && !res.headersSent && !res.writableEnded) send(res, result, req.method === "HEAD");
    const status = result?.status ?? res.statusCode;
    this.config.log.log(status >= 500 ? "error" : "debug", "request", {
      method: req.method,
      path: logPath,
      status,
      ms: Math.round(performance.now() - started),
    });
  };

  private async dispatch(req: IncomingMessage, res: ServerResponse, url: URL, path: string, signal: AbortSignal): Promise<RouteResult> {
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, Mcp-Session-Id, Mcp-Protocol-Version",
        },
      };
    }
    const candidates = this.routes.filter((r) => matchPath(r.path, path));
    if (candidates.length === 0) return error("not found", 404);
    const route = candidates.find((r) => r.method === method);
    if (!route) {
      return { status: 405, json: { error: "method not allowed" }, headers: { Allow: [...new Set(candidates.map((r) => r.method))].sort().join(", ") } };
    }
    const token = bearer(req);
    let caller: Caller<unknown> | undefined;
    if (token && tokenEquals(token, this.config.token)) caller = { kind: "owner" };
    else if (token && route.access !== "public") {
      const principal = this.config.sharedPrincipal?.(token);
      if (principal !== undefined) caller = { kind: "shared", principal };
    }
    if (route.access !== "public") {
      if (!caller) return error("unauthorized", 401);
      // Ein gültiger Gast-Token reicht nicht für Owner-Routen (MCP, Assets-GC, Sandbox …).
      if (route.access === "owner" && caller.kind !== "owner") return error("forbidden", 403);
    }
    let body: Buffer;
    try {
      body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req, route.bodyLimit);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        res.setHeader("Connection", "close");
        return error("request body too large", 413);
      }
      throw e;
    }
    return route.handler({ req, res, url, body, signal, caller, params: matchPath(route.path, path) ?? {} });
  }
}

function send(res: ServerResponse, r: NonNullable<RouteResult>, head = false) {
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  if (head) {
    res.writeHead(r.status);
    res.end();
  } else if (r.json !== undefined) {
    const data = JSON.stringify(r.json);
    res.writeHead(r.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  } else if (r.html !== undefined) {
    res.writeHead(r.status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(r.html) });
    res.end(r.html);
  } else if (r.body !== undefined) {
    res.writeHead(r.status, { "Content-Length": r.body.length });
    res.end(r.body);
  } else if (r.text !== undefined) {
    res.writeHead(r.status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(r.text) });
    res.end(r.text);
  } else {
    res.writeHead(r.status);
    res.end();
  }
}
