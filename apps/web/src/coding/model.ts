// BSD-223 Teil 4: Zustand der Coding-Ansicht (#coding). Spricht über `CodingClient` mit dem based-server:
// Sitzungsliste, gewählte Sitzung (Ereignisse per Long-Poll), Freigabe-Inbox (Long-Poll auf die Version).
// Läuft im Hauptthread; ein Modell je Server-Konfiguration.
import { CodingClient, codingErrorMessage, foldTranscript, type CodingAgentInfo, type CodingSessionView, type InboxItem, type StoredChatEvent, type TranscriptItem } from "@based/brain";

export interface CodingUIState {
  agents: CodingAgentInfo[];
  sessions: CodingSessionView[];
  selected: string | undefined;
  /** Ereignisse der gewählten Sitzung. */
  events: StoredChatEvent[];
  items: TranscriptItem[];
  inbox: InboxItem[];
  error: string | undefined;
  loading: boolean;
}

const EMPTY: CodingUIState = { agents: [], sessions: [], selected: undefined, events: [], items: [], inbox: [], error: undefined, loading: true };
const LONG_POLL_MS = 20_000;

export class CodingModel {
  readonly client: CodingClient;
  private state: CodingUIState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private eventsLoop: AbortController | undefined;
  private inboxLoop: AbortController | undefined;
  private started = false;

  constructor(opts: { url: string; token: string; fetch?: typeof fetch }, private readonly retryMs = 3000) {
    this.client = new CodingClient(opts);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): CodingUIState => this.state;

  private set(patch: Partial<CodingUIState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const [agents, sessions] = await Promise.all([this.client.agents(), this.client.sessions()]);
      this.set({ agents, sessions, loading: false, error: undefined });
      void this.runInbox();
    } catch (e) {
      this.started = false;
      this.set({ loading: false, error: codingErrorMessage(e) });
    }
  }

  stop(): void {
    this.started = false;
    this.eventsLoop?.abort();
    this.inboxLoop?.abort();
  }

  /** Fehler anzeigen statt werfen (Knöpfe). */
  private async guard<T>(f: () => Promise<T>): Promise<T | undefined> {
    try {
      const r = await f();
      if (this.state.error) this.set({ error: undefined });
      return r;
    } catch (e) {
      this.set({ error: codingErrorMessage(e) });
      return undefined;
    }
  }

  async refreshSessions(): Promise<void> {
    const sessions = await this.guard(() => this.client.sessions());
    if (sessions) this.set({ sessions });
  }

  select(id: string | undefined): void {
    if (id === this.state.selected) return;
    this.eventsLoop?.abort();
    this.set({ selected: id, events: [], items: [] });
    if (id) void this.runEvents(id);
  }

  async create(input: { agent: string; cwd: string; mode?: string; resume?: string; handoffFrom?: string }): Promise<CodingSessionView | undefined> {
    const s = await this.guard(() => this.client.create(input));
    if (!s) return undefined;
    await this.refreshSessions();
    if (s.state === "failed") this.set({ error: s.error ?? "The agent could not be started." });
    this.select(s.id);
    return s;
  }

  async send(text: string): Promise<boolean> {
    const id = this.state.selected;
    if (!id || !text.trim()) return false;
    const ok = await this.guard(async () => { await this.client.prompt(id, text); return true; });
    if (ok) this.patchSession(id, { state: "running" });
    return ok === true;
  }

  async cancel(): Promise<void> {
    const id = this.state.selected;
    if (id) await this.guard(() => this.client.cancel(id));
  }

  async setMode(mode: string): Promise<void> {
    const id = this.state.selected;
    if (!id) return;
    const s = await this.guard(() => this.client.setMode(id, mode));
    if (s) this.patchSession(id, s);
  }

  async close(id: string): Promise<void> {
    await this.guard(() => this.client.close(id));
    await this.refreshSessions();
  }

  async answer(itemId: string, optionId: string | undefined): Promise<void> {
    await this.guard(() => this.client.answer(itemId, optionId));
    this.set({ inbox: this.state.inbox.filter((i) => i.id !== itemId) });
  }

  private patchSession(id: string, patch: Partial<CodingSessionView>) {
    this.set({ sessions: this.state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  }

  private async runEvents(id: string): Promise<void> {
    const ctl = new AbortController();
    this.eventsLoop = ctl;
    let since = 0;
    while (!ctl.signal.aborted) {
      try {
        const r = await this.client.events(id, since, since === 0 ? 0 : LONG_POLL_MS, ctl.signal);
        if (ctl.signal.aborted) return;
        since = r.next;
        if (r.events.length > 0) {
          const events = [...this.state.events, ...r.events];
          this.set({ events, items: foldTranscript(events).items });
        }
        else if (r.state !== "running" && r.state !== "starting") await new Promise((res) => setTimeout(res, this.retryMs));
        const cur = this.state.sessions.find((s) => s.id === id);
        if (cur && cur.state !== r.state) this.patchSession(id, { state: r.state });
        if (r.state === "closed" || r.state === "failed") return;
      } catch (e) {
        if (ctl.signal.aborted) return;
        this.set({ error: codingErrorMessage(e) });
        await new Promise((res) => setTimeout(res, this.retryMs));
      }
    }
  }

  private async runInbox(): Promise<void> {
    const ctl = new AbortController();
    this.inboxLoop = ctl;
    let version: number | undefined;
    while (!ctl.signal.aborted) {
      try {
        const r = await this.client.inbox(version, version === undefined ? 0 : LONG_POLL_MS, ctl.signal);
        if (ctl.signal.aborted) return;
        const same = r.version === version;
        version = r.version;
        if (!same) this.set({ inbox: r.items });
        // Antwortet ein Server ohne zu warten, nicht im Kreis fragen.
        else await new Promise((res) => setTimeout(res, this.retryMs));
      } catch (e) {
        if (ctl.signal.aborted) return;
        this.set({ error: codingErrorMessage(e) });
        await new Promise((res) => setTimeout(res, this.retryMs));
      }
    }
  }
}
