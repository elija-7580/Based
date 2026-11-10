// BSD-199 / ADR 0013 §7: umkehrbare Platzhalter. Der Anbieter sieht nur `<PERSON_1>`, `<IBAN_1>` …; die Zuordnung
// bleibt in Based (nur im Speicher dieses Chats) und wird in Antworten und Aktionen (Tool-Argumente) wieder
// eingesetzt. Dieselbe Stelle bekommt im ganzen Chat denselben Platzhalter. Stufe 2 (lokales Modell) hängt sich
// über `RedactModel` ein; ohne Modell wirken nur die Regeln.
import type { JSONValue } from "@based/core";
import { detectSensitive, resolveOverlaps, type Detection, type RedactKind, type RuleOptions } from "./rules.js";

/** Austauschbares lokales Erkennungsmodell (z. B. ein Privacy-Filter im Worker). Nie ein fremder Server. */
export interface RedactModel {
  readonly id: string;
  detect(text: string, signal?: AbortSignal): Promise<Omit<Detection, "value">[]>;
}

export interface RedactorOptions extends RuleOptions {
  model?: RedactModel | undefined;
}

export interface RedactResult {
  text: string;
  detections: Detection[];
}

// Auch ohne spitze Klammern (Modelle lassen sie gern weg), aber nie mitten in einem Wort.
const PLACEHOLDER = /<?\b(PERSON|EMAIL|PHONE|IBAN|CARD|ADDRESS|SECRET)_(\d{1,4})\b>?/g;

export class Redactor {
  private byValue = new Map<string, string>();
  private byPlaceholder = new Map<string, { kind: RedactKind; value: string }>();
  private counters = new Map<RedactKind, number>();
  /** Platzhalter, die seit `beginTurn` benutzt wurden (für „n details redacted“). */
  private used = new Set<string>();

  constructor(private opts: RedactorOptions = {}) {}

  /** Namen/Arten ändern (z. B. neue Workspace-Personen); die Zuordnung bleibt. */
  configure(opts: RedactorOptions) {
    this.opts = opts;
  }

  beginTurn() {
    this.used.clear();
  }

  /** Was in diesem Turn ersetzt wurde: Anzahl je Art. */
  turnSummary(): { count: number; kinds: Partial<Record<RedactKind, number>> } {
    const kinds: Partial<Record<RedactKind, number>> = {};
    for (const p of this.used) {
      const k = this.byPlaceholder.get(p)!.kind;
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    return { count: this.used.size, kinds };
  }

  /** Alle Zuordnungen (zum Nachsehen im Chat). */
  entries(): { placeholder: string; kind: RedactKind; value: string }[] {
    return [...this.byPlaceholder].map(([placeholder, v]) => ({ placeholder, ...v }));
  }

  private placeholderFor(kind: RedactKind, value: string): string {
    const key = kind + "\u0000" + (kind === "EMAIL" ? value.toLowerCase() : value.replace(/\s+/g, " "));
    let p = this.byValue.get(key);
    if (!p) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      p = `<${kind}_${n}>`;
      this.byValue.set(key, p);
      this.byPlaceholder.set(p, { kind, value });
    }
    this.used.add(p);
    return p;
  }

  private apply(text: string, detections: readonly Detection[]): string {
    let out = "";
    let last = 0;
    for (const d of detections) {
      out += text.slice(last, d.start) + this.placeholderFor(d.kind, d.value);
      last = d.end;
    }
    return out + text.slice(last);
  }

  /** Nur Regeln (synchron). Bereits gesetzte Platzhalter bleiben unangetastet. */
  redact(text: string): RedactResult {
    if (!text) return { text, detections: [] };
    const detections = detectSensitive(text, this.opts).filter((d) => !this.isPlaceholderSpan(text, d));
    return { text: this.apply(text, detections), detections };
  }

  /** Regeln und – falls vorhanden – das lokale Modell. */
  async redactAsync(text: string, signal?: AbortSignal): Promise<RedactResult> {
    if (!text || !this.opts.model) return this.redact(text);
    const rules = detectSensitive(text, this.opts);
    const fromModel = (await this.opts.model.detect(text, signal)).map((d) => ({ ...d, value: text.slice(d.start, d.end) }));
    const detections = resolveOverlaps([...rules, ...fromModel]).filter((d) => d.value.trim() && !this.isPlaceholderSpan(text, d));
    return { text: this.apply(text, detections), detections };
  }

  private isPlaceholderSpan(text: string, d: Detection): boolean {
    PLACEHOLDER.lastIndex = 0;
    for (const m of text.matchAll(PLACEHOLDER)) if (d.start < m.index + m[0].length && m.index < d.end) return true;
    return false;
  }

  /** Platzhalter zurück in echte Werte; unbekannte bleiben stehen. */
  restore(text: string): string {
    if (!text || this.byPlaceholder.size === 0) return text;
    return text.replace(PLACEHOLDER, (all, kind: string, n: string) => this.byPlaceholder.get(`<${kind}_${n}>`)?.value ?? all);
  }

  /** Strings in JSON (Tool-Argumente) ersetzen bzw. zurücktauschen. */
  redactJSON(v: JSONValue): JSONValue {
    return mapStrings(v, (s) => this.redact(s).text);
  }
  restoreJSON(v: JSONValue): JSONValue {
    return mapStrings(v, (s) => this.restore(s));
  }

  /**
   * Rücktausch für gestreamte Teilstücke: ein Platzhalter, der über zwei Deltas geht („<PERS“ + „ON_1>“), wird
   * zurückgehalten, bis er vollständig ist.
   */
  streamRestorer(): { push(delta: string): string; flush(): string } {
    let pending = "";
    return {
      push: (delta: string) => {
        pending += delta;
        // Ab dem letzten möglichen Anfang eines Platzhalters zurückhalten.
        const m = /<?[A-Z]{0,7}(?:_\d{0,4})?>?$/.exec(pending);
        let cut = pending.length;
        if (m && m[0].length > 0 && !/>$/.test(m[0])) cut = m.index;
        const ready = pending.slice(0, cut);
        pending = pending.slice(cut);
        return this.restore(ready);
      },
      flush: () => {
        const out = this.restore(pending);
        pending = "";
        return out;
      },
    };
  }
}

function mapStrings(v: JSONValue, f: (s: string) => string): JSONValue {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v !== null && typeof v === "object") {
    const out: { [k: string]: JSONValue } = {};
    for (const [k, x] of Object.entries(v)) out[k] = mapStrings(x, f);
    return out;
  }
  return v;
}
