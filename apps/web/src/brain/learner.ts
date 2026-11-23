// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Das Gedächtnis lernt von selbst (Einstellungen → Agents & AI → Memories → „Learn from my notes“, opt-in).
// Einmal je Minute: gibt es eine geänderte Seite, die seit ein paar Minuten ruht, liest das Chat-Modell sie und die
// Tatsachen landen als Memories (Heikles als „To review“); sonst wird, höchstens wöchentlich, der Schreibstil aus
// Schreibproben abgelesen. Regeln, Prompts und Budget: packages/brain/src/memory/learn.ts. Was schon gelesen wurde,
// steht auf diesem Gerät (localStorage). Mehrere Tabs: nur einer lernt (Web Lock).
import {
  learnPrompt, LEARN_MIN_CHARS, LEARN_SYSTEM, markLearned, markStyle, nextLearnPage, parseLearnState, parseMemorySuggestions, parseStyle, Redactor, styleDue, stylePrompt,
  STYLE_REFRESH_MS, STYLE_SYSTEM, learnHash, type LearnState,
} from "@based/brain";
import type { BrainClient } from "./client.js";
import type { BrainSettingsStore } from "./settings.js";

const KEY = "based.brain.learn";
export const LEARN_TICK_MS = 60_000;

export interface LearnerOptions {
  client: Pick<BrainClient, "learnCandidates" | "learnSave" | "styleSamples" | "saveStyle" | "memories" | "personNames">;
  settings: Pick<BrainSettingsStore, "getState">;
  /** Ein Aufruf des Chat-Modells ohne Werkzeuge. */
  write: (system: string, prompt: string, signal: AbortSignal) => Promise<string>;
  /** Modell eingerichtet und AI an? */
  canWrite: () => boolean;
  now?: () => number;
  storage?: { get(): unknown; set(v: LearnState): void };
}

const localState = {
  get(): unknown {
    try {
      const raw = globalThis.localStorage?.getItem(KEY);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  },
  set(v: LearnState) {
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(v));
    } catch {
      // nur für diese Sitzung
    }
  },
};

export class Learner {
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private abort = new AbortController();
  private readonly storage: NonNullable<LearnerOptions["storage"]>;

  /** `o.now` wird bei jedem Schritt gelesen (E2E stellt die Uhr vor, statt Minuten zu warten). */
  constructor(readonly o: LearnerOptions) {
    this.storage = o.storage ?? localState;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  start() {
    this.timer ??= setInterval(() => void this.tickLocked(), LEARN_TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    this.abort = new AbortController();
  }

  private async tickLocked() {
    const locks = globalThis.navigator?.locks;
    if (!locks) return void (await this.tick());
    await locks.request("based.brain.learn", { ifAvailable: true }, async (lock) => {
      if (lock) await this.tick();
    });
  }

  /** Ein Modellaufruf; ist Privacy-Redact an, gehen nur Platzhalter raus und die Antwort bekommt die Werte zurück. */
  private async ask(system: string, prompt: string): Promise<string> {
    const r = this.o.settings.getState().redact;
    if (!r.enabled) return this.o.write(system, prompt, this.abort.signal);
    const names = await this.o.client.personNames().catch(() => [] as string[]);
    const redactor = new Redactor({ names: [...names, ...r.names], kinds: new Set(r.kinds) });
    return redactor.restore(await this.o.write(system, redactor.redact(prompt).text, this.abort.signal));
  }

  /** Ein Schritt: höchstens ein Modellaufruf. Gibt zurück, was getan wurde (für Tests). */
  async tick(): Promise<"off" | "idle" | "page" | "style"> {
    if (this.busy || this.o.settings.getState().memories.learn !== true || !this.o.canWrite()) return "off";
    this.busy = true;
    try {
      let state = parseLearnState(this.storage.get());
      const candidates = await this.o.client.learnCandidates(!state.seeded);
      if (!state.seeded) this.storage.set((state = { ...state, seeded: true }));
      // Was zu kurz ist, gilt als gelesen (ohne Aufruf).
      for (const c of candidates) {
        if (c.text.trim().length < LEARN_MIN_CHARS && state.pages[c.id]?.hash !== learnHash(c.text)) state = markLearned(state, c.id, c.text, this.now(), false);
      }
      const page = nextLearnPage(candidates, state, this.now());
      if (page) {
        const existing = await this.o.client.memories();
        // Erst merken, dann rufen: schlägt der Aufruf fehl, wird dieselbe Fassung nicht jede Minute neu versucht.
        this.storage.set((state = markLearned(state, page.id, page.text, this.now())));
        const answer = await this.ask(LEARN_SYSTEM, learnPrompt(page, existing));
        const found = parseMemorySuggestions(answer, existing);
        await this.o.client.learnSave(page.id, found);
        return "page";
      }
      this.storage.set(state);
      // Schreibproben nur holen, wenn der Stil überhaupt fällig sein kann (noch nie oder eine Woche her).
      if (state.style && this.now() - state.style.at < STYLE_REFRESH_MS) return "idle";
      const samples = await this.o.client.styleSamples();
      if (styleDue(state, samples, this.now())) {
        this.storage.set(markStyle(state, samples, this.now()));
        const style = parseStyle(await this.ask(STYLE_SYSTEM, stylePrompt(samples)));
        if (style) await this.o.client.saveStyle(style);
        return "style";
      }
      return "idle";
    } catch {
      return "idle";
    } finally {
      this.busy = false;
    }
  }
}
