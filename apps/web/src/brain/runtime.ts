// Agent Brain im Chat: hängt sich über `ChatController.hooks` ein (keine Änderung am Turn-Ablauf selbst).
// - BSD-198: während des Tippens wählt der lokale Router 0–2 Skills (Chips über dem Eingabefeld, entfernen/tauschen
//   = Korrektur, die als Beispiel gespeichert wird); beim Senden gehen die gewählten Skills ganz, die übrigen
//   Kandidaten mit Beschreibung ins System-Prompt (`load_skill` holt den Rest).
// - BSD-199: ist Redact an (oder für diese Nachricht gewählt), sitzt der Redactor vor jedem externen Modellaufruf;
//   die Zuordnung bleibt je Chat im Speicher. Lokale Modelle: aus. CLI-Engines: nur Hinweis.
// - BSD-163: Memory-Vorschläge nach dem Turn (opt-in), gespeichert wird erst nach „Save“; Zitate werden aufgelöst.
import {
  BRAIN_TOOL_SPECS, CITATION_INSTRUCTION, citationMarkers, CLI_REDACT_WARNING, detectSensitive, exchangeText, MEMORY_EXTRACTOR_SYSTEM, memoryExtractorPrompt,
  MIN_MEMORY_USER_CHARS, parseMemorySuggestions, privacyGate, RedactingEngine, RedactingProvider, redactionPlan, Redactor, skillsPrompt,
  type ChatEvent, type Detection, type PendingMemory, type SkillMatch, type SkillRouting, type StoredChatEvent, type ToolHost,
} from "@based/brain";
import type { ChatController, TurnContext, TurnPrep, TurnReach } from "../chat/controller.js";
import type { ResolvedCitation } from "../worker/brain.js";
import type { BrainClient } from "./client.js";
import { brainSettings, type BrainSettingsStore } from "./settings.js";

export interface SkillChip {
  id: string;
  name: string;
  description: string;
}

export interface BrainChatState {
  /** Text, für den die Chips gelten. */
  draft: string;
  routing: SkillRouting | undefined;
  /** Gewählte Skills (Chips). */
  chips: SkillChip[];
  /** Der Nutzer hat die Chips verändert (Korrektur). */
  edited: boolean;
  /** Sensible Stellen im Entwurf (lokal geprüft, beim Einfügen). */
  sensitive: Detection[];
  /** Nur für die nächste Nachricht schwärzen (Angebot beim Einfügen). */
  redactOnce: boolean;
  /** Aufgelöste Zitate: "block:<id>" → Quelle oder null (gibt es nicht). */
  citations: ReadonlyMap<string, ResolvedCitation | null>;
  /** BSD-184: Nachricht mit sensiblen Stellen wartet auf die Wahl (Trotzdem senden / Schwärzen / Lokales Modell). */
  privacyCheck?: { text: string; hits: Detection[] } | undefined;
}

/** Ereignisse, die das Brain ins Transkript schreibt (unbekannte Typen: bleiben erhalten, werden nicht gezeichnet). */
export interface SkillsEvent { type: "skills"; skills: SkillChip[]; corrected?: boolean; [k: string]: unknown }
export interface RedactionEvent { type: "redaction"; count: number; kinds: Record<string, number>; [k: string]: unknown }

const chip = (m: Pick<SkillMatch, "id" | "name" | "description">): SkillChip => ({ id: m.id, name: m.name, description: m.description });
const userText = (turn: readonly StoredChatEvent[]) => (turn.find((e) => e.type === "userMessage") as Extract<ChatEvent, { type: "userMessage" }> | undefined)?.text ?? "";

export class BrainChat {
  private state: BrainChatState = { draft: "", routing: undefined, chips: [], edited: false, sensitive: [], redactOnce: false, citations: new Map() };
  private listeners = new Set<() => void>();
  private redactors = new Map<string, Redactor>();
  private names: string[] = [];
  private routeSeq = 0;
  private routeTimer: ReturnType<typeof setTimeout> | undefined;
  private resolving = new Set<string>();
  /** Für Tests/E2E: Antwort des Memory-Extraktors statt eines Modellaufrufs. */
  extractor: ((system: string, prompt: string) => Promise<string>) | undefined;
  /** Beim Senden festgehaltene Chips je Nachricht (der Composer leert den Entwurf sofort, der Turn startet später). */
  private sent: { text: string; routing: SkillRouting | undefined; chips: SkillChip[]; edited: boolean; redactOnce: boolean }[] = [];
  /** Was der letzte Redact-Schritt der Engine gezeigt hat (E2E prüft, dass nur Platzhalter rausgehen). */
  lastRedacted: string | undefined;

  constructor(readonly client: BrainClient, readonly controller: ChatController, readonly settings: BrainSettingsStore = brainSettings(), private readonly debounceMs = 200) {}

  getState = (): BrainChatState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<BrainChatState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  install() {
    this.controller.hooks = {
      prepare: (text, ctx) => this.prepare(text, ctx),
      after: (turn, ctx) => this.after(turn, ctx.complete),
      tools: () => this.tools(),
    };
    void this.refreshNames();
  }

  async refreshNames() {
    try {
      this.names = await this.client.personNames();
    } catch {
      this.names = [];
    }
  }

  // MARK: Entwurf → Chips

  setDraft(text: string) {
    const s = this.settings.getState();
    const sensitive = text.trim() ? detectSensitive(text, { names: [...this.names, ...s.redact.names], kinds: new Set(s.redact.kinds) }) : [];
    if (text.trim() === "") {
      if (this.routeTimer) clearTimeout(this.routeTimer);
      this.routeSeq += 1;
      this.set({ draft: "", routing: undefined, chips: [], edited: false, sensitive: [], redactOnce: false });
      return;
    }
    this.set({ draft: text, sensitive });
    if (!s.skills.auto) return;
    if (this.routeTimer) clearTimeout(this.routeTimer);
    this.routeTimer = setTimeout(() => void this.route(text), this.debounceMs);
  }

  private async route(text: string): Promise<SkillRouting | undefined> {
    const seq = ++this.routeSeq;
    try {
      const routing = await this.client.route(text, this.settings.corrections());
      if (seq !== this.routeSeq) return routing;
      this.set(this.state.edited ? { routing } : { routing, chips: routing.selected.map(chip) });
      return routing;
    } catch {
      return undefined;
    }
  }

  removeChip(id: string) {
    this.set({ chips: this.state.chips.filter((c) => c.id !== id), edited: true });
  }

  /** Chip tauschen (`from` fehlt = hinzufügen). */
  swapChip(from: string | undefined, to: SkillChip) {
    const chips = this.state.chips.filter((c) => c.id !== from && c.id !== to.id);
    const at = from ? Math.max(0, this.state.chips.findIndex((c) => c.id === from)) : chips.length;
    chips.splice(at, 0, to);
    this.set({ chips: chips.slice(0, 3), edited: true });
  }

  /** Alternativen für einen Chip: die übrigen Kandidaten des Routers. */
  alternatives(): SkillChip[] {
    return (this.state.routing?.candidates ?? []).filter((c) => !this.state.chips.some((x) => x.id === c.id)).map(chip);
  }

  setRedactOnce(on: boolean) {
    this.set({ redactOnce: on });
  }

  private decision: "raw" | "redact" | undefined;

  /**
   * BSD-184: Privacy-Check vor dem Senden (Einstellung „Ask before sending sensitive details“). `false` = nicht
   * senden; der Hinweis zeigt die Treffer und die Wahl. Lokale Modelle und eingeschaltetes Schwärzen fragen nicht.
   */
  gate(text: string, reach: TurnReach): boolean {
    const s = this.settings.getState().redact;
    if (!s.check) return true;
    const hits = detectSensitive(text, { names: [...this.names, ...s.names], kinds: new Set(s.kinds) });
    const g = privacyGate({ hits: hits.length, reach, redactAlways: s.enabled || this.state.redactOnce, decision: this.decision });
    this.decision = undefined;
    if (g === "ask") {
      this.set({ privacyCheck: { text, hits } });
      return false;
    }
    if (g === "redact" && !s.enabled) this.set({ redactOnce: true });
    if (this.state.privacyCheck) this.set({ privacyCheck: undefined });
    return true;
  }

  /** Wahl im Hinweis; die nächste Sendung dieser Nachricht nimmt sie (ChatView löst das Senden aus). */
  decide(d: "raw" | "redact") {
    this.decision = d;
    this.set({ privacyCheck: undefined });
  }

  dismissPrivacyCheck() {
    this.decision = undefined;
    this.set({ privacyCheck: undefined });
  }

  /** Vor dem Senden aufrufen: Chips und Redact-Wahl gehören zu dieser Nachricht. */
  captureSend(text: string) {
    const st = this.state;
    const same = st.draft.trim() === text.trim();
    this.sent.push({ text: text.trim(), routing: same ? st.routing : undefined, chips: same ? st.chips : [], edited: same && st.edited, redactOnce: st.redactOnce });
    if (this.sent.length > 20) this.sent.shift();
  }

  // MARK: Turn

  private redactor(chatID: string): Redactor {
    let r = this.redactors.get(chatID);
    if (!r) this.redactors.set(chatID, (r = new Redactor()));
    const s = this.settings.getState().redact;
    r.configure({ names: [...this.names, ...s.names], kinds: new Set(s.kinds) });
    return r;
  }

  private async prepare(text: string, ctx: TurnContext): Promise<TurnPrep> {
    const s = this.settings.getState();
    const i = this.sent.findIndex((x) => x.text === text.trim());
    const st = i >= 0 ? this.sent.splice(i, 1)[0]! : { text, routing: undefined, chips: [] as SkillChip[], edited: false, redactOnce: false };
    const prep: TurnPrep = {};
    const events: StoredChatEvent[] = [];
    let system = "";

    // Skills: die Chips des Entwurfs, sonst jetzt routen.
    if (s.skills.auto) {
      if (this.routeTimer) clearTimeout(this.routeTimer);
      let routing = st.routing;
      let chips = routing || st.edited ? st.chips : [];
      if (!routing && !st.edited) {
        routing = await this.client.route(text, this.settings.corrections()).catch(() => undefined);
        chips = routing?.selected.map(chip) ?? [];
      }
      if (st.edited && routing) {
        const auto = routing.selected.map((x) => x.id);
        const now = chips.map((c) => c.id);
        this.settings.addCorrection({ query: text, added: now.filter((id) => !auto.includes(id)), removed: auto.filter((id) => !now.includes(id)), at: Date.now() });
      }
      const full = chips.length > 0 ? await this.client.skillsByID(chips.map((c) => c.id)) : [];
      const ordered = chips.map((c) => full.find((f) => f.id === c.id)).filter((x) => x !== undefined);
      system = skillsPrompt(ordered, routing?.candidates ?? []);
      if (chips.length > 0) events.push({ type: "skills", skills: chips, ...(st.edited ? { corrected: true } : {}) } satisfies SkillsEvent);
    }
    system = [system, CITATION_INSTRUCTION].filter(Boolean).join("\n\n");
    prep.system = system;

    // Redact.
    const plan = redactionPlan(s.redact.enabled || st.redactOnce, ctx.reach);
    if (plan === "redact") {
      await this.refreshNames();
      const r = this.redactor(ctx.chatID);
      r.beginTurn();
      prep.wrapEngine = (e) => new RedactingEngine(e, r);
      prep.wrapProvider = (p) => new RedactingProvider(p, r);
      prep.finish = () => {
        const sum = r.turnSummary();
        this.lastRedacted = r.redact(text).text;
        return sum.count > 0 ? [{ type: "redaction", count: sum.count, kinds: sum.kinds } satisfies RedactionEvent] : [];
      };
    } else if (plan === "warn") {
      events.push({ type: "notice", text: CLI_REDACT_WARNING });
    }
    prep.events = events;
    return prep;
  }

  private async after(turn: readonly StoredChatEvent[], complete: (system: string, prompt: string) => Promise<string>): Promise<StoredChatEvent[] | undefined> {
    if (!this.settings.getState().memories.suggest) return undefined;
    const user = userText(turn);
    if (user.trim().length < MIN_MEMORY_USER_CHARS) return undefined;
    const result = turn.find((e) => e.type === "result") as Extract<ChatEvent, { type: "result" }> | undefined;
    if (!result) return undefined;
    const existing = await this.client.memories();
    const answer = await (this.extractor ?? complete)(MEMORY_EXTRACTOR_SYSTEM, memoryExtractorPrompt(exchangeText(user, result.text), existing));
    return parseMemorySuggestions(answer, existing).map((suggestion) => ({ type: "memorySuggestion", id: crypto.randomUUID(), suggestion }));
  }

  /** Vorschlag bestätigen: erst jetzt wird die Memory geschrieben. */
  async saveMemory(p: PendingMemory, edited?: { title: string; body: string }) {
    const s = { ...p.suggestion, ...(edited ?? {}) };
    const memoryID = await this.client.saveMemory({ title: s.title, kind: s.kind, body: s.body, updates: s.updates });
    await this.controller.appendEvents([{ type: "memoryDecision", id: p.id, decision: "saved", memoryID }]);
    void this.refreshNames();
  }

  async dismissMemory(p: PendingMemory) {
    await this.controller.appendEvents([{ type: "memoryDecision", id: p.id, decision: "dismissed" }]);
  }

  // MARK: Werkzeuge, Zitate

  private tools(): ToolHost {
    return {
      specs: BRAIN_TOOL_SPECS,
      isWrite: () => false,
      call: (name, input) => this.client.tool(name, input),
    };
  }

  /** Zitate in Antworten nachschlagen (einmal je Marker). */
  resolveCitations(texts: readonly string[]) {
    const want = new Map<string, { kind: "block" | "page"; id: string }>();
    for (const t of texts) for (const m of citationMarkers(t)) {
      const key = `${m.kind}:${m.id}`;
      if (!this.state.citations.has(key) && !this.resolving.has(key)) want.set(key, m);
    }
    if (want.size === 0) return;
    for (const k of want.keys()) this.resolving.add(k);
    void this.client.resolveCitations([...want.values()]).then((r) => {
      const next = new Map(this.state.citations);
      for (const [k, v] of Object.entries(r)) next.set(k, v);
      for (const k of want.keys()) this.resolving.delete(k);
      this.set({ citations: next });
    }, () => {
      for (const k of want.keys()) this.resolving.delete(k);
    });
  }
}
