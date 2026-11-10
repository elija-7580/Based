// BSD-198 / ADR 0013 §6: automatische Skill-Auswahl, lokal und anbieterunabhängig. Der Router bewertet jede Skill
// über Name, Beschreibung UND Abschnitte des Rumpfs (SkillRouter-Befund: der Rumpf zählt) und liefert
//   - `candidates`: die Top-5 fürs Verstehen (unter ~20 Skills: alle, ohne Vorauswahl),
//   - `selected`: 0–2 Skills, die sicher genug passen (als Chips sichtbar, entfernen/tauschen = Korrektur).
// Grundlage ist BM25 (deterministisch, ohne Modell). Ein lokales Embedding-Modell lässt sich über `dense`
// dazunehmen (gleiche Schnittstelle wie die semantische Suche), ist aber keine Voraussetzung.
import { BM25, markdownSections, tokenize } from "../semantic/text.js";

export interface RoutableSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
}

export interface SkillMatch {
  id: string;
  name: string;
  description: string;
  score: number;
  /** Wert relativ zum besten Treffer (0…1). */
  relative: number;
}

export interface SkillRouting {
  /** Was ins Verstehen geht (Top-K, oder alle bei kleinem Katalog), beste zuerst. */
  candidates: SkillMatch[];
  /** Automatisch gewählte Skills (0…maxSelected). */
  selected: SkillMatch[];
  /** false = kleiner Katalog: alle Beschreibungen gehen ungefiltert mit. */
  preselected: boolean;
}

/** Korrektur des Nutzers (Chip entfernt/getauscht) – fließt als Beispiel in spätere Auswahlen ein (ADR 0013 §5). */
export interface SkillCorrection {
  query: string;
  added: string[];
  removed: string[];
  at: number;
}

export interface SkillRouterOptions {
  topK?: number;
  maxSelected?: number;
  /** Unter so vielen Skills keine Vorauswahl (ADR: ~20). */
  smallCatalog?: number;
  /** Mindestwert für eine automatische Wahl. */
  minScore?: number;
  /** Eine zweite Skill nur, wenn sie so nah am besten Treffer liegt. */
  neighborRatio?: number;
}

export const SKILL_ROUTER_DEFAULTS: Required<SkillRouterOptions> = { topK: 5, maxSelected: 2, smallCatalog: 20, minScore: 2.2, neighborRatio: 0.8 };

const W_NAME = 3, W_DESC = 2, W_SECTION = 1, W_BODY = 0.5;

interface Indexed {
  skill: RoutableSkill;
  name: string[];
  desc: string[];
  sections: string[][];
  all: string[];
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n / (a.size + b.size - n);
};

export class SkillRouter {
  readonly options: Required<SkillRouterOptions>;
  private readonly items: Indexed[];
  private readonly bm: BM25;

  constructor(skills: readonly RoutableSkill[], options: SkillRouterOptions = {}) {
    this.options = { ...SKILL_ROUTER_DEFAULTS, ...options };
    this.items = skills.filter((s) => s.enabled !== false).map((skill) => {
      const name = tokenize(skill.name.replace(/[-_]/g, " "));
      const desc = tokenize(skill.description);
      const sections = markdownSections(skill.body).map(tokenize).filter((s) => s.length > 0);
      return { skill, name, desc, sections, all: [...name, ...desc, ...sections.flat()] };
    });
    // IDF über ganze Skills: ein Wort, das jede Skill hat, trennt nichts.
    this.bm = new BM25(this.items.map((i) => i.all));
  }

  get size() {
    return this.items.length;
  }

  /** Rohwert je Skill (ohne Korrekturen). */
  private lexical(q: string[], i: Indexed): number {
    const section = i.sections.reduce((m, s) => Math.max(m, this.bm.score(q, s)), 0);
    const body = this.bm.score(q, i.sections.flat());
    return W_NAME * this.bm.score(q, i.name) + W_DESC * this.bm.score(q, i.desc) + W_SECTION * section + W_BODY * body;
  }

  /**
   * Skills für eine Anfrage. `dense`: Ähnlichkeit (Kosinus −1…1) je Skill-ID aus einem lokalen Embedding-Modell;
   * `corrections`: frühere Korrekturen (ähnliche Anfrage → hinzugefügte Skill gewinnt, entfernte verliert).
   */
  route(query: string, extra: { dense?: ReadonlyMap<string, number>; corrections?: readonly SkillCorrection[] } = {}): SkillRouting {
    const o = this.options;
    const q = tokenize(query);
    const qs = new Set(q);
    const boosts = new Map<string, number>();
    // Fast dieselbe Anfrage schon einmal korrigiert: entfernte Skills nicht wieder wählen, hinzugefügte wählen.
    const vetoed = new Set<string>(), forced = new Set<string>();
    for (const c of extra.corrections ?? []) {
      const sim = jaccard(qs, new Set(tokenize(c.query)));
      if (sim < 0.5) continue;
      for (const id of c.added) {
        boosts.set(id, (boosts.get(id) ?? 0) + 4 * sim);
        if (sim >= 0.7) { forced.add(id); vetoed.delete(id); }
      }
      for (const id of c.removed) {
        boosts.set(id, (boosts.get(id) ?? 0) - 4 * sim);
        if (sim >= 0.7) { vetoed.add(id); forced.delete(id); }
      }
    }
    const scored = this.items.map((i) => {
      let score = q.length > 0 ? this.lexical(q, i) : 0;
      const d = extra.dense?.get(i.skill.id);
      if (d !== undefined) score += 4 * Math.max(0, d);
      score += boosts.get(i.skill.id) ?? 0;
      return { i, score: Math.max(0, score) };
    });
    scored.sort((a, b) => b.score - a.score || (a.i.skill.name < b.i.skill.name ? -1 : 1));
    const top = scored[0]?.score ?? 0;
    const match = (x: (typeof scored)[number]): SkillMatch => ({ id: x.i.skill.id, name: x.i.skill.name, description: x.i.skill.description, score: Math.round(x.score * 1000) / 1000, relative: top > 0 ? x.score / top : 0 });
    const preselected = this.items.length >= o.smallCatalog;
    const candidates = (preselected ? scored.slice(0, o.topK) : scored).map(match);
    const selected: SkillMatch[] = scored.filter((x) => forced.has(x.i.skill.id)).slice(0, o.maxSelected).map(match);
    for (const x of scored) {
      if (selected.length >= o.maxSelected) break;
      if (vetoed.has(x.i.skill.id) || forced.has(x.i.skill.id)) continue;
      if (x.score < o.minScore) break;
      if (selected.length > 0 && x.score < top * o.neighborRatio) break;
      selected.push(match(x));
    }
    return { candidates, selected, preselected };
  }
}

/** Abschnitt fürs System-Prompt: gewählte Skills ganz, die übrigen Kandidaten nur mit Beschreibung. */
export function skillsPrompt(selected: readonly RoutableSkill[], candidates: readonly Pick<SkillMatch, "id" | "name" | "description">[]): string {
  if (selected.length === 0 && candidates.length === 0) return "";
  let s = "";
  if (selected.length > 0) {
    s += "# Skills for this request\nFollow these instructions where they apply.\n";
    for (const k of selected) s += `\n## Skill: ${k.name}\n${k.description}\n\n${k.body.trim()}\n`;
  }
  const rest = candidates.filter((c) => !selected.some((k) => k.id === c.id));
  if (rest.length > 0) {
    s += `${s ? "\n" : ""}# Other skills (load one with load_skill before following it)\n`;
    for (const c of rest) s += `- ${c.name}: ${c.description}\n`;
  }
  return s.trim();
}
