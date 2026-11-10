// Einstellungen des Agent Brain auf diesem Gerät (localStorage, nichts Geheimes): Privacy-Redact (opt-in, BSD-199),
// automatische Skill-Auswahl (BSD-198), Memory-Vorschläge (BSD-163) und die Korrekturen an Skill-Chips.
import { REDACT_KINDS, type RedactKind, type SkillCorrection } from "@based/brain";

export interface BrainSettings {
  v: 1;
  redact: {
    enabled: boolean;
    kinds: RedactKind[];
    /** Weitere Namen, die immer geschwärzt werden (zusätzlich zu Memories vom Typ People). */
    names: string[];
  };
  skills: { auto: boolean };
  memories: { suggest: boolean };
}

export const DEFAULT_BRAIN_SETTINGS: BrainSettings = {
  v: 1,
  redact: { enabled: false, kinds: [...REDACT_KINDS], names: [] },
  skills: { auto: true },
  memories: { suggest: false },
};

const KEY = "based.brain";
const CORRECTIONS_KEY = "based.brain.corrections";
const MAX_CORRECTIONS = 200;

function read<T>(key: string): T | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, v: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(v));
  } catch {
    // nur für diese Sitzung
  }
}

export function parseBrainSettings(v: unknown): BrainSettings {
  const d = DEFAULT_BRAIN_SETTINGS;
  if (v === null || typeof v !== "object") return structuredClone(d);
  const o = v as Partial<BrainSettings>;
  const kinds = Array.isArray(o.redact?.kinds) ? o.redact.kinds.filter((k): k is RedactKind => (REDACT_KINDS as readonly string[]).includes(k)) : d.redact.kinds;
  return {
    v: 1,
    redact: {
      enabled: o.redact?.enabled === true,
      kinds,
      names: Array.isArray(o.redact?.names) ? o.redact.names.filter((n): n is string => typeof n === "string" && n.trim() !== "") : [],
    },
    skills: { auto: o.skills?.auto !== false },
    memories: { suggest: o.memories?.suggest === true },
  };
}

export class BrainSettingsStore {
  private state: BrainSettings;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = parseBrainSettings(read(KEY));
  }

  getState = (): BrainSettings => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  update(f: (s: BrainSettings) => BrainSettings) {
    this.state = parseBrainSettings(f(structuredClone(this.state)));
    write(KEY, this.state);
    for (const fn of this.listeners) fn();
  }

  corrections(): SkillCorrection[] {
    const list = read<SkillCorrection[]>(CORRECTIONS_KEY);
    return Array.isArray(list) ? list : [];
  }

  addCorrection(c: SkillCorrection) {
    if (c.added.length === 0 && c.removed.length === 0) return;
    write(CORRECTIONS_KEY, [...this.corrections(), c].slice(-MAX_CORRECTIONS));
  }

  clearCorrections() {
    write(CORRECTIONS_KEY, []);
  }
}

let shared: BrainSettingsStore | undefined;
export const brainSettings = (): BrainSettingsStore => (shared ??= new BrainSettingsStore());
