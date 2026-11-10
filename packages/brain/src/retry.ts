// Wiederholen bei Überlast / Rate-Limit / wackligem Netz mit exponentiellem Backoff und Jitter (Swift `RetryPolicy`,
// BSD-46). Nur vor dem ersten Token: sobald Ausgabe gezeigt wurde, würde ein Retry sie wiederholen. Dazu das
// gestreamte HTTP mit injizierbarem `fetch`.
import { AbortError, AIError, isAbort } from "./messages.js";
import { SSEParser, type SSEEvent } from "./sse.js";

/** Gescheiterte HTTP-Antwort mit dem, was der Retry braucht. */
export class HTTPFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfter?: number,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "HTTPFailure";
  }
}

/** Fehler, nachdem schon Ausgabe gestreamt wurde: wird nicht wiederholt. */
class AfterOutput extends Error {
  constructor(readonly error: unknown) {
    super("after output");
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  /** Sekunden. */
  baseDelay?: number;
  maxDelay?: number;
  statuses?: readonly number[];
  sleep?: (seconds: number, signal?: AbortSignal) => Promise<void>;
  jitter?: () => number;
}

const realSleep = (seconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, seconds) * 1000);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class RetryPolicy {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  statuses: ReadonlySet<number>;
  sleep: (seconds: number, signal?: AbortSignal) => Promise<void>;
  jitter: () => number;

  constructor(o: RetryOptions = {}) {
    this.maxAttempts = o.maxAttempts ?? 4;
    this.baseDelay = o.baseDelay ?? 1;
    this.maxDelay = o.maxDelay ?? 20;
    this.statuses = new Set(o.statuses ?? [429, 500, 502, 503, 529]);
    this.sleep = o.sleep ?? realSleep;
    this.jitter = o.jitter ?? (() => Math.random() * 0.3);
  }

  /** Wartezeit vor Versuch `attempt + 1` (ab 1 gezählt). `retry-after` des Servers gewinnt. */
  delay(attempt: number, retryAfter?: number): number {
    if (retryAfter !== undefined && retryAfter >= 0) return Math.min(retryAfter, 60);
    return Math.min(this.maxDelay, this.baseDelay * 2 ** (attempt - 1)) * (1 + this.jitter());
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (e) {
        if (e instanceof AfterOutput) throw toAIError(e.error);
        if (signal?.aborted || isAbort(e)) throw new AbortError();
        const wait = attempt < this.maxAttempts ? this.retryDelay(e, attempt) : undefined;
        if (wait === undefined) throw toAIError(e);
        await this.sleep(wait, signal);
      }
    }
  }

  private retryDelay(e: unknown, attempt: number): number | undefined {
    if (e instanceof HTTPFailure) return this.statuses.has(e.status) ? this.delay(attempt, e.retryAfter) : undefined;
    if (e instanceof AIError) return e.kind === "network" || (e.status !== undefined && this.statuses.has(e.status)) ? this.delay(attempt) : undefined;
    // fetch wirft TypeError bei Netzfehlern (Verbindung weg, DNS, CORS)
    if (e instanceof TypeError) return this.delay(attempt);
    return undefined;
  }
}

function toAIError(e: unknown): unknown {
  if (e instanceof HTTPFailure) return AIError.http(e.status, e.body);
  if (e instanceof TypeError) return AIError.network(e.message || "Network error");
  return e;
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

async function failureFrom(r: Response): Promise<HTTPFailure> {
  let after: number | undefined;
  const ms = Number(r.headers.get("retry-after-ms") ?? NaN);
  const s = Number(r.headers.get("retry-after") ?? NaN);
  if (Number.isFinite(ms)) after = ms / 1000;
  else if (Number.isFinite(s)) after = s;
  let body = "";
  try {
    body = (await r.text()).slice(0, 4000);
  } catch {
    // Antworttext nicht lesbar: Status reicht
  }
  return new HTTPFailure(r.status, body, after);
}

/**
 * Schickt `body` als JSON und füttert die SSE-Ereignisse der Antwort an `handle` (gibt zurück, ob Ausgabe gezeigt
 * wurde). Wiederholt nach `policy` bis zur ersten Ausgabe; HTTP-Fehler werden `AIError.http`.
 */
export async function streamSSE<T>(opts: {
  fetch: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  policy: RetryPolicy;
  signal?: AbortSignal | undefined;
  makeState: () => T;
  handle: (state: T, e: SSEEvent) => boolean;
}): Promise<T> {
  const { signal } = opts;
  return opts.policy.run(async () => {
    if (signal?.aborted) throw new AbortError();
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...opts.headers },
      body: JSON.stringify(opts.body),
      ...(signal ? { signal } : {}),
    };
    const r = await opts.fetch(opts.url, init);
    if (r.status < 200 || r.status >= 300) throw await failureFrom(r);
    const state = opts.makeState();
    const parser = new SSEParser();
    let shown = false;
    try {
      const reader = r.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const e of parser.feed(value)) if (opts.handle(state, e)) shown = true;
        }
      }
      for (const e of parser.finish()) if (opts.handle(state, e)) shown = true;
    } catch (e) {
      if (signal?.aborted || isAbort(e)) throw new AbortError();
      if (shown) throw new AfterOutput(e);
      throw e;
    }
    return state;
  }, signal);
}
