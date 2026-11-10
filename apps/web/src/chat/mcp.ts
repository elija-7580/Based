// BSD-222: MCP-Connections im Hauptthread (wie die Modell-Engine: Netz und Geheimnisse leben hier, nie im Worker).
// Hält je eingeschalteter HTTP-Connection eine Verbindung (im Hintergrund aufgebaut, bei geänderter URL/Token neu),
// liefert die Werkzeuge als ToolHost für Chat und Agenten und meldet den Zustand für die Einstellungen.
// Records (Name, URL, Freigaben) kommen aus dem Store-Worker; das Token aus der verschlüsselten Ablage
// (shell/secrets.ts) unter `secretRef`. stdio-Server brauchen die Desktop-Hülle (noch nicht angebunden).
import { connectionsFor, type AgentData, type Connection, type ConnectionPatch, type NewConnection, type ProjectData, type ToolHost } from "@based/brain";
import { httpTransport, McpConnection, McpToolHost, type McpStatus } from "@based/brain/mcp";
import type { SecretStore } from "../shell/secrets.js";
import { secretVault } from "../shell/storage.js";

/** Was die Laufzeit vom Store-Client braucht (StoreClient; in Tests ein Fake). */
export interface ConnectionsBackend {
  agents<T>(action: { op: "connections" } | { op: "addConnection"; input: NewConnection; id?: string } | { op: "updateConnection"; id: string; patch: ConnectionPatch } | { op: "removeConnection"; id: string }): Promise<T>;
}

export interface ConnectionStatus {
  status: McpStatus | "unsupported" | "disabled";
  tools: number;
  error?: string | undefined;
  server?: string | undefined;
}

export interface McpState {
  connections: Connection[];
  status: Record<string, ConnectionStatus>;
}

interface Live {
  key: string;
  conn: McpConnection;
  ready: Promise<void>;
}

export class McpRuntime {
  private state: McpState = { connections: [], status: {} };
  private readonly listeners = new Set<() => void>();
  private live = new Map<string, Live>();
  private refreshing: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly backend: ConnectionsBackend,
    private readonly secrets: () => Pick<SecretStore, "getSecret" | "setSecret"> = secretVault,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  getState = (): McpState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<McpState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  private setStatus(id: string, s: ConnectionStatus) {
    this.set({ status: { ...this.state.status, [id]: s } });
  }

  /** Records neu lesen und Verbindungen abgleichen (läuft nie doppelt; ein Aufruf währenddessen läuft danach). */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async doRefresh() {
    const list = await this.backend.agents<Connection[]>({ op: "connections" });
    const status: Record<string, ConnectionStatus> = {};
    const keep = new Set<string>();
    for (const c of list) {
      if (!c.data.enabled) {
        status[c.id] = { status: "disabled", tools: 0 };
        continue;
      }
      if (c.data.transport !== "http" || !c.data.url) {
        status[c.id] = { status: "unsupported", tools: 0, error: "Needs the desktop app (local command)." };
        continue;
      }
      const token = c.data.secretRef ? await this.secrets().getSecret(c.data.secretRef).catch(() => undefined) : undefined;
      // Schlüssel ohne das Token selbst (nur ob es eins gibt und wie lang es ist, damit ein neues neu verbindet).
      const key = JSON.stringify([c.name, c.data.url, c.data.headerName ?? "", token ? token.length + ":" + hash(token) : ""]);
      keep.add(c.id);
      const cur = this.live.get(c.id);
      if (cur && cur.key === key) {
        status[c.id] = this.statusOf(cur.conn);
        continue;
      }
      if (cur) void cur.conn.close();
      const conn = new McpConnection(c.name, () => httpTransport(c.data.url!, { token, headerName: c.data.headerName, fetch: this.fetchImpl }), { timeoutMs: 30_000 });
      const live: Live = { key, conn, ready: Promise.resolve() };
      live.ready = conn.connect().catch(() => undefined).finally(() => {
        if (this.live.get(c.id) === live) this.setStatus(c.id, this.statusOf(conn));
      });
      this.live.set(c.id, live);
      status[c.id] = { status: "connecting", tools: 0 };
    }
    for (const [id, l] of this.live) {
      if (keep.has(id)) continue;
      void l.conn.close();
      this.live.delete(id);
    }
    this.set({ connections: list, status });
  }

  private statusOf(conn: McpConnection): ConnectionStatus {
    return { status: conn.status, tools: conn.tools.length, error: conn.lastError, server: conn.serverName };
  }

  /** Wartet höchstens `ms`, bis laufende Verbindungsaufbauten fertig sind (vor einem Turn). */
  async ready(ms = 4000): Promise<void> {
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    const all = Promise.all([...this.live.values()].map((l) => l.ready));
    await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
  }

  /** Werkzeuge der bereiten Connections (Chat: alle eingeschalteten; Agenten: freigegebene, siehe connectionsFor). */
  tools(scope: { agent?: AgentData; project?: ProjectData } = {}): ToolHost | undefined {
    const allowed = new Set(connectionsFor(this.state.connections, scope).map((c) => c.id));
    const ready = [...this.live.entries()].filter(([id, l]) => allowed.has(id) && l.conn.status === "ready").map(([, l]) => l.conn);
    return ready.length ? new McpToolHost(ready) : undefined;
  }

  // MARK: Einstellungen

  async add(input: NewConnection, token?: string): Promise<Connection> {
    const id = globalThis.crypto.randomUUID();
    const withSecret = Boolean(token?.trim()) || input.withSecret === true;
    const c = await this.backend.agents<Connection>({ op: "addConnection", id, input: { ...input, withSecret } });
    if (token?.trim() && c.data.secretRef) await this.secrets().setSecret(c.data.secretRef, token.trim());
    await this.refresh();
    return c;
  }

  async update(id: string, patch: ConnectionPatch, token?: string): Promise<void> {
    const withToken = token !== undefined && token.trim() !== "";
    const c = await this.backend.agents<Connection | undefined>({ op: "updateConnection", id, patch: withToken ? { ...patch, withSecret: true } : patch });
    if (withToken && c?.data.secretRef) await this.secrets().setSecret(c.data.secretRef, token.trim());
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    const c = this.state.connections.find((x) => x.id === id);
    await this.backend.agents({ op: "removeConnection", id });
    if (c?.data.secretRef) await this.secrets().setSecret(c.data.secretRef, undefined);
    await this.refresh();
  }

  /** Neu verbinden (Knopf „Test“) und den Zustand liefern. */
  async test(id: string): Promise<ConnectionStatus> {
    const l = this.live.get(id);
    if (l) {
      await l.conn.close();
      this.live.delete(id);
    }
    await this.refresh();
    await this.live.get(id)?.ready;
    return this.state.status[id] ?? { status: "failed", tools: 0, error: "Unknown connection." };
  }

  async close() {
    for (const l of this.live.values()) await l.conn.close();
    this.live.clear();
  }
}

/** Kurzer, nicht umkehrbarer Fingerabdruck (nur zum Erkennen eines geänderten Tokens im Speicher). */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

let shared: McpRuntime | undefined;
/** Die eine Laufzeit der App; folgt Änderungen an den Records (lokal, anderer Tab, Sync). */
export function mcpRuntime(client: ConnectionsBackend & { subscribe(fn: () => void): () => void; getState(): { agents?: unknown } }): McpRuntime {
  if (!shared) {
    const rt = new McpRuntime(client);
    shared = rt;
    let last = client.getState().agents;
    client.subscribe(() => {
      const now = client.getState().agents;
      if (now !== last) {
        last = now;
        void rt.refresh().catch(() => undefined);
      }
    });
    void rt.refresh().catch(() => undefined);
  }
  return shared;
}
