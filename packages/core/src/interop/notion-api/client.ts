// BSD-217: Notion-REST-Client (Port von Swift `NotionClient`): API-Version 2026-03-11, ~3 Anfragen/s, Wiederholen bei
// 429/5xx (Retry-After), Seitenweise lesen. Plattformneutral: das HTTP liefert `NotionTransport` (Tauri-HTTP in der
// Desktop-App, fetch im Test). Das Token geht nur in den Authorization-Header, nie in Meldungen oder Berichte.
import type { JSONValue } from "../../json.js";
import { notionIDInName, notionUUID } from "../importids.js";

export interface NotionResponse { status: number; headers: Record<string, string>; body: Uint8Array }

/** HTTP-Schicht (austauschbar). `url` ist absolut; Header-Namen der Antwort klein. */
export interface NotionTransport {
  send(method: string, url: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<NotionResponse>;
}

/** Transport über `fetch` (Browser/Node; in der Desktop-App ersetzt die Hülle `fetch`, damit kein CORS greift). */
export function fetchTransport(f: typeof fetch = (...a) => fetch(...a)): NotionTransport {
  return {
    async send(method, url, headers, body, signal) {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = body;
      if (signal) init.signal = signal;
      const r = await f(url, init);
      const h: Record<string, string> = {};
      r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      return { status: r.status, headers: h, body: new Uint8Array(await r.arrayBuffer()) };
    },
  };
}

export type NotionAPIErrorKind = "unauthorized" | "notFound" | "restricted" | "http" | "cancelled";

export class NotionAPIError extends Error {
  constructor(readonly kind: NotionAPIErrorKind, readonly detail: string, readonly status = 0) {
    super(NotionAPIError.describe(kind, detail, status));
    this.name = "NotionAPIError";
  }
  static describe(kind: NotionAPIErrorKind, m: string, status: number): string {
    switch (kind) {
      case "unauthorized": return `Notion rejected the integration token. ${m}`;
      case "notFound": return `Not found or not shared with the integration: ${m}`;
      case "restricted": return `The integration lacks access: ${m}`;
      case "http": return `Notion API error ${status}: ${m}`;
      case "cancelled": return "The import was cancelled.";
    }
  }
}

const utf8 = new TextDecoder();
const parse = (b: Uint8Array): JSONValue | undefined => {
  try { return JSON.parse(utf8.decode(b)) as JSONValue; } catch { return undefined; }
};
type Obj = { [k: string]: JSONValue };
const obj = (v: JSONValue | undefined): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const str = (v: JSONValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export interface NotionClientOptions {
  baseURL?: string;
  /** 0 = ohne Drossel (Tests). */
  requestsPerSecond?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (ms <= 0) { resolve(); return; }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new NotionAPIError("cancelled", "")); }, { once: true });
});

export class NotionClient {
  static readonly version = "2026-03-11";
  readonly baseURL: string;
  private readonly token: string;
  private readonly minInterval: number;
  private nextSlot = 0;
  requestCount = 0;
  /** Letzte fehlgeschlagene Anfrage („HTTP 404 [GET /v1/pages/…]: …“) für den Bericht. */
  lastFailure: string | undefined;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal | undefined;

  constructor(token: string, readonly transport: NotionTransport, o: NotionClientOptions = {}) {
    this.token = token.trim();
    this.baseURL = (o.baseURL ?? "https://api.notion.com/v1").replace(/\/+$/, "");
    const rps = o.requestsPerSecond ?? 3;
    this.minInterval = rps > 0 ? 1000 / rps : 0;
    this.sleep = o.sleep ?? defaultSleep;
    this.signal = o.signal;
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minInterval;
    if (slot > now) await this.sleep(slot - now, this.signal);
    if (this.signal?.aborted) throw new NotionAPIError("cancelled", "");
  }

  url(path: string, query: Record<string, string> = {}): string {
    const keys = Object.keys(query).sort();
    const q = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`).join("&");
    return `${this.baseURL}/${path}${q ? "?" + q : ""}`;
  }

  async request(method: string, path: string, query: Record<string, string> = {}, body?: JSONValue): Promise<JSONValue> {
    const headers = { Authorization: `Bearer ${this.token}`, "Notion-Version": NotionClient.version, "Content-Type": "application/json" };
    const data = body === undefined ? undefined : JSON.stringify(body);
    let attempt = 0;
    for (;;) {
      await this.waitForSlot();
      this.requestCount++;
      let r: NotionResponse;
      try {
        r = await this.transport.send(method, this.url(path, query), headers, data, this.signal);
      } catch (e) {
        if (this.signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw new NotionAPIError("cancelled", "");
        attempt++;
        if (attempt > 3) throw e;
        await this.sleep(2 ** attempt * 500, this.signal);
        continue;
      }
      if (r.status >= 200 && r.status < 300) return r.body.length === 0 ? null : (parse(r.body) ?? null);
      const err = obj(parse(r.body));
      const message = str(err?.message) ?? utf8.decode(r.body.slice(0, 300));
      const code = str(err?.code) ?? "";
      if (r.status === 429 || code === "rate_limited" || (r.status >= 500 && r.status < 600)) {
        attempt++;
        if (attempt > 6) throw new NotionAPIError("http", message, r.status);
        const ra = Number(r.headers["retry-after"]);
        const wait = Number.isFinite(ra) && r.headers["retry-after"] !== undefined && r.headers["retry-after"] !== "" ? ra : Math.min(30, 2 ** attempt * 0.5);
        this.nextSlot = Date.now() + wait * 1000;
        continue;
      }
      const qk = Object.keys(query).sort();
      const where = ` [${method} /v1/${path}${qk.length ? "?" + qk.join("&") : ""}${code ? ", " + code : ""}]`;
      this.lastFailure = `HTTP ${r.status}${where}: ${message}`;
      switch (r.status) {
        case 401: throw new NotionAPIError("unauthorized", message, 401);
        case 404: throw new NotionAPIError("notFound", message + where, 404);
        case 403: throw new NotionAPIError("restricted", message + where, 403);
        default: throw new NotionAPIError("http", message + where, r.status);
      }
    }
  }

  get(path: string, query: Record<string, string> = {}) { return this.request("GET", path, query); }
  post(path: string, body: JSONValue) { return this.request("POST", path, {}, body); }

  /** Alle `results` eines seitenweisen GET-Endpunkts. */
  async paginateGet(path: string, query: Record<string, string> = {}, limit = Infinity): Promise<JSONValue[]> {
    const out: JSONValue[] = [];
    let cursor: string | undefined;
    do {
      const q = { ...query, page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) };
      const r = obj(await this.get(path, q));
      out.push(...(Array.isArray(r?.results) ? r.results : []));
      cursor = r?.has_more === true ? str(r.next_cursor) : undefined;
    } while (cursor !== undefined && out.length < limit);
    return out;
  }

  /** Alle `results` eines seitenweisen POST-Endpunkts (Query, Suche). */
  async paginatePost(path: string, body: Obj = {}, limit = Infinity): Promise<JSONValue[]> {
    const out: JSONValue[] = [];
    let cursor: string | undefined;
    do {
      const b: Obj = { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const r = obj(await this.post(path, b));
      out.push(...(Array.isArray(r?.results) ? r.results : []));
      cursor = r?.has_more === true ? str(r.next_cursor) : undefined;
    } while (cursor !== undefined && out.length < limit);
    return out;
  }

  /** Seiten-IDs einer Ansicht in ihrer Reihenfolge (Views-API: Abfrage anlegen, durchblättern, löschen). */
  async viewOrder(viewID: string): Promise<string[]> {
    const first = obj(await this.post(`views/${viewID}/queries`, { page_size: 100 }));
    const ids = (Array.isArray(first?.results) ? first.results : []).flatMap((x) => { const id = str(obj(x)?.id); return id ? [id] : []; });
    const qid = str(first?.id);
    let cursor = first?.has_more === true ? str(first.next_cursor) : undefined;
    while (cursor !== undefined && qid !== undefined) {
      const r = obj(await this.get(`views/${viewID}/queries/${qid}`, { start_cursor: cursor, page_size: "100" }));
      ids.push(...(Array.isArray(r?.results) ? r.results : []).flatMap((x) => { const id = str(obj(x)?.id); return id ? [id] : []; }));
      cursor = r?.has_more === true ? str(r.next_cursor) : undefined;
    }
    if (qid !== undefined) await this.request("DELETE", `views/${viewID}/queries/${qid}`).catch(() => undefined);
    return ids;
  }

  /** Eine von Notion gehostete Datei (signierte URL, ohne Auth-Header). */
  async download(url: string, name?: string): Promise<{ name: string; data: Uint8Array }> {
    let attempt = 0;
    for (;;) {
      const r = await this.transport.send("GET", url, {}, undefined, this.signal);
      if (r.status >= 200 && r.status < 300) {
        const last = decodeURIComponent((url.split(/[?#]/)[0] ?? "").split("/").pop() ?? "") || "file";
        const base = (name ?? last).replaceAll("/", "-");
        return { name: base === "" ? "file" : base, data: r.body };
      }
      attempt++;
      if (attempt > 2 || (r.status >= 400 && r.status < 500)) throw new NotionAPIError("http", `download ${(url.split(/[?#]/)[0] ?? "").split("/").pop() ?? ""}`, r.status);
      await this.sleep(800, this.signal);
    }
  }
}

/** Was importiert wird: Link oder ID einer Seite/Datenbank (notion.so, notion.site, app.notion.com). */
export function notionTarget(raw: string): string | undefined {
  const s = raw.trim();
  if (s === "") return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return undefined; }
    const p = u.searchParams.get("p");
    if (p) { const id = notionUUID(p); if (id) return id; }
    return notionIDInName(u.pathname);
  }
  return notionUUID(s) ?? notionIDInName(s);
}

/** Mehrere Ziele aus freiem Text (Zeilen, Leerzeichen, Kommas); doppelte fallen weg. */
export function parseNotionTargets(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\n ,\t]+/).flatMap((x) => { const id = notionTarget(x); return id && !seen.has(id) ? (seen.add(id), [id]) : []; });
}
