// BSD-223 Teil 4: Client für die /coding-Routen des based-servers (Web, Desktop, iPhone). Reines fetch, kein DOM.
// Long-Poll für Ereignisse und Inbox; das Token geht nur in den Authorization-Header.
import type { StoredChatEvent } from "../events.js";
import type { CodingSessionState, CodingSessionView } from "./sessions.js";
import type { InboxItem } from "./inbox.js";
import type { CliSession } from "./history.js";
import type { AgentStatus, DoctorTool } from "./doctor.js";

export class CodingAPIError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CodingAPIError";
  }
}

/** Verständliche Meldung (404 auf /coding = Server ohne Coding-Agenten). */
export function codingErrorMessage(e: unknown): string {
  if (e instanceof CodingAPIError) {
    if (e.status === 401) return "The server didn't accept the token. Check Settings → Sync & server.";
    if (e.status === 404 && (e.message === "" || e.message === "not found")) return "This server has no coding agents. Start based-server with --coding-root <folder>.";
    return e.message || `The server answered ${e.status}.`;
  }
  if (e instanceof TypeError) return "Can't reach the server. Check your connection and Settings → Sync & server.";
  return e instanceof Error ? e.message : String(e);
}

export interface CodingAgentInfo { id: string; name: string; icon: string; note: string }

export class CodingClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(readonly opts: { url: string; token: string; fetch?: typeof fetch }) {
    this.base = opts.url.replace(/\/+$/, "");
    this.fetcher = opts.fetch ?? ((...a) => fetch(...a));
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { method, headers: { Authorization: `Bearer ${this.opts.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    const res = await this.fetcher(this.base + path, init);
    const data = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    if (!res.ok && !(res.status === 502 && path === "/coding/sessions")) throw new CodingAPIError(res.status, data?.error ?? "");
    return data as T;
  }

  async agents(): Promise<CodingAgentInfo[]> {
    return (await this.request<{ agents: CodingAgentInfo[] }>("GET", "/coding/agents")).agents;
  }

  async sessions(): Promise<CodingSessionView[]> {
    return (await this.request<{ sessions: CodingSessionView[] }>("GET", "/coding/sessions")).sessions;
  }

  /** Neue Sitzung; schlägt der Start fehl, kommt die Sitzung mit `state: "failed"` und `error` zurück. */
  create(input: { agent: string; cwd: string; mode?: string; resume?: string; handoffFrom?: string }): Promise<CodingSessionView> {
    return this.request("POST", "/coding/sessions", input);
  }

  session(id: string): Promise<CodingSessionView> {
    return this.request("GET", `/coding/sessions/${encodeURIComponent(id)}`);
  }

  /** Ereignisse ab `since`; mit `waitMs` wartet der Server, bis es neue gibt (Long-Poll). */
  events(id: string, since: number, waitMs = 0, signal?: AbortSignal): Promise<{ events: StoredChatEvent[]; next: number; state: CodingSessionState }> {
    return this.request("GET", `/coding/sessions/${encodeURIComponent(id)}/events?since=${since}&wait=${waitMs}`, undefined, signal);
  }

  async prompt(id: string, prompt: string): Promise<void> {
    await this.request("POST", `/coding/sessions/${encodeURIComponent(id)}/prompt`, { prompt });
  }

  setMode(id: string, mode: string): Promise<CodingSessionView> {
    return this.request("POST", `/coding/sessions/${encodeURIComponent(id)}/mode`, { mode });
  }

  async cancel(id: string): Promise<void> {
    await this.request("POST", `/coding/sessions/${encodeURIComponent(id)}/cancel`, {});
  }

  async close(id: string): Promise<void> {
    await this.request("DELETE", `/coding/sessions/${encodeURIComponent(id)}`);
  }

  /** Offene Freigaben; mit `since` = letzte Version und `waitMs` als Long-Poll. */
  inbox(since?: number, waitMs = 0, signal?: AbortSignal): Promise<{ version: number; items: InboxItem[] }> {
    return this.request("GET", `/coding/inbox?${since !== undefined ? `since=${since}&` : ""}wait=${waitMs}`, undefined, signal);
  }

  /** Antwort auf eine Freigabe (`undefined` = abbrechen). */
  async answer(itemId: string, optionId: string | undefined): Promise<void> {
    await this.request("POST", `/coding/inbox/${encodeURIComponent(itemId)}`, { optionId: optionId ?? null });
  }

  async history(limit = 400): Promise<CliSession[]> {
    return (await this.request<{ sessions: CliSession[] }>("GET", `/coding/history?limit=${limit}`)).sessions;
  }

  historyTranscript(tool: string, id: string): Promise<{ session: CliSession; events: StoredChatEvent[] }> {
    return this.request("GET", `/coding/history/${encodeURIComponent(tool)}/${encodeURIComponent(id)}`);
  }

  doctor(): Promise<{ tools: DoctorTool[]; agents: AgentStatus[] }> {
    return this.request("GET", "/coding/doctor");
  }

  testAgent(agentId: string): Promise<{ ok: boolean; message: string }> {
    return this.request("POST", `/coding/doctor/${encodeURIComponent(agentId)}/test`, {});
  }
}
