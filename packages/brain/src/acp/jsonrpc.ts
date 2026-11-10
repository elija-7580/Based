// BSD-223: JSON-RPC 2.0 über zeilenweises JSON (stdio), wie ACP es nutzt (Port von Swift `JSONRPCPeer`).
// Plattformneutral: der Transport liefert nur `write(line)` und füttert empfangene Bytes per `receive(chunk)`;
// den Prozess (Node `child_process`, Tauri-Shell, Server) stellt die Hülle (siehe `acp/stdio.ts`).
// Beide Richtungen: Anfragen an den Agenten (`request`, `notify`) und Anfragen des Agenten an uns (`onRequest`).
import type { JSONValue } from "@based/core";

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: JSONValue) {
    super(message);
    this.name = "RpcError";
  }
  static methodNotFound(m: string) { return new RpcError(-32601, `Method not found: ${m}`); }
  static invalidParams(s: string) { return new RpcError(-32602, s); }
  static internal(s: string) { return new RpcError(-32603, s); }
  static closed() { return new RpcError(-32000, "Connection closed"); }
  toJSON(): JSONValue {
    const o: { [k: string]: JSONValue } = { code: this.code, message: this.message };
    if (this.data !== undefined) o.data = this.data;
    return o;
  }
}

export type RpcRequestHandler = (method: string, params: JSONValue | undefined) => Promise<JSONValue>;
export type RpcNotificationHandler = (method: string, params: JSONValue | undefined) => void;

type Obj = { [k: string]: JSONValue };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export class JsonRpcPeer {
  onRequest: RpcRequestHandler | undefined;
  onNotification: RpcNotificationHandler | undefined;
  onClose: (() => void) | undefined;
  /** Protokoll ohne Inhalte über 300 Zeichen (für die Diagnose; Werte bleiben gekürzt). */
  log: ((line: string) => void) | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: JSONValue) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private isClosed = false;

  /** `write` bekommt eine fertige Zeile mit `\n`; wirft sie, gilt die Verbindung als geschlossen. */
  constructor(private readonly write: (line: string) => void) {}

  get closed(): boolean { return this.isClosed; }

  request(method: string, params?: JSONValue): Promise<JSONValue> {
    if (this.isClosed) return Promise.reject(RpcError.closed());
    const id = ++this.nextId;
    const msg: Obj = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    return new Promise<JSONValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(msg);
    });
  }

  notify(method: string, params?: JSONValue): void {
    const msg: Obj = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.send(msg);
  }

  /** Rohe Daten vom Transport; vollständige Zeilen werden verarbeitet, der Rest wartet auf mehr. */
  receive(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line !== "") this.dispatch(line);
    }
  }

  /** Transport ist weg: offene Anfragen schlagen fehl statt ewig zu hängen (Swift BSD-36). */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(RpcError.closed());
    this.onClose?.();
  }

  private send(msg: Obj): void {
    if (this.isClosed) return;
    const line = JSON.stringify(msg) + "\n";
    this.log?.(`→ ${line.slice(0, 300).trimEnd()}`);
    try {
      this.write(line);
    } catch (e) {
      this.log?.(`write failed: ${e instanceof Error ? e.message : String(e)}`);
      this.close();
    }
  }

  private dispatch(line: string): void {
    this.log?.(`← ${line.slice(0, 300)}`);
    let m: unknown;
    try { m = JSON.parse(line); } catch { return; }
    if (!isObj(m)) return;
    const method = typeof m.method === "string" ? m.method : undefined;
    const params = m.params;
    if (method !== undefined) {
      const id = m.id;
      if (id === undefined || id === null) {
        try { this.onNotification?.(method, params); } catch { /* Handler-Fehler beenden die Verbindung nicht */ }
        return;
      }
      const handler = this.onRequest;
      void (async () => {
        const reply: Obj = { jsonrpc: "2.0", id };
        try {
          if (!handler) throw RpcError.methodNotFound(method);
          reply.result = await handler(method, params);
        } catch (e) {
          reply.error = (e instanceof RpcError ? e : RpcError.internal(e instanceof Error ? e.message : String(e))).toJSON();
        }
        this.send(reply);
      })();
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (isObj(m.error)) {
      const err = m.error;
      p.reject(new RpcError(typeof err.code === "number" ? err.code : -1, typeof err.message === "string" ? err.message : "error", err.data));
    } else p.resolve(m.result ?? null);
  }
}
