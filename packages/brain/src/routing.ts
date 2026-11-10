// BSD-242: Modellwahl Low/Auto/High (Port der API-Hälfte von Swift `ModelRouter`). Regeln ordnen eine Aufgabe einer
// Route zu (Code, Quick, Writing, Research, Long document, Background, General); jede Route nennt je Stufe eine Kette
// von Modell-Stufen (@small, @balanced, @strong, @default). Aufgelöst wird gegen die eingerichteten Modelle.
// Eine genaue Modellwahl überschreibt immer. Reine Funktionen, keine Netzaufrufe.

export type ComputeLevel = "low" | "auto" | "high";
export type ModelTier = 0 | 1 | 2; // small, balanced, strong

export const COMPUTE_LABEL: Record<ComputeLevel, string> = { low: "Low", auto: "Auto", high: "High" };

/** Stufe eines Modellnamens (wie Swift `ModelTier.of`). */
export function modelTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (["haiku", "mini", "nano", "flash", "lite", "small", "8b", "3b", "1b"].some((x) => m.includes(x))) return 0;
  if (["opus", "-pro", "ultra", "large", "o3", "o1"].some((x) => m.includes(x)) || m.startsWith("gpt-5")) return 2;
  return 1;
}

export interface RouteTask {
  text: string;
  /** Zeichen angehängter/eingefügter Dokumente. */
  attachmentChars?: number;
  /** Projekt-/Arbeitsordner, wenn es einen gibt. */
  folder?: string | undefined;
  scheduled?: boolean;
}

type Token = "@small" | "@balanced" | "@strong" | "@default";
interface Route { id: string; name: string; low: Token[]; auto: Token[]; high: Token[] }

export const ROUTES: readonly Route[] = [
  { id: "code", name: "Code", low: ["@balanced"], auto: ["@strong"], high: ["@strong"] },
  { id: "quick", name: "Quick", low: ["@small"], auto: ["@small", "@default"], high: ["@balanced", "@default"] },
  { id: "write", name: "Writing", low: ["@small"], auto: ["@balanced"], high: ["@strong"] },
  { id: "research", name: "Research", low: ["@small"], auto: ["@balanced"], high: ["@strong"] },
  { id: "long", name: "Long document", low: ["@balanced"], auto: ["@balanced"], high: ["@strong"] },
  { id: "background", name: "Background", low: ["@small"], auto: ["@small"], high: ["@balanced"] },
  { id: "general", name: "General", low: ["@small"], auto: ["@default"], high: ["@strong"] },
];

export const LONG_DOCUMENT_CHARS = 100_000;

/** Regel-Route einer Aufgabe; `undefined`, wenn keine Regel sicher ist (dann „general“). */
export function ruleRoute(task: RouteTask): { id: string; reason: string } | undefined {
  const t = " " + task.text.toLowerCase() + " ";
  const has = (words: string[]) => words.some((w) => t.includes(w));
  const att = task.attachmentChars ?? 0;
  if (task.scheduled) return { id: "background", reason: "scheduled run" };
  if (att > LONG_DOCUMENT_CHARS || task.text.length > LONG_DOCUMENT_CHARS) {
    return { id: "long", reason: `attachment of ${Math.floor(Math.max(att, task.text.length) / 1000)}k characters` };
  }
  const codeVerbs = ["implement", "fix ", "fixe", "refactor", "debug", "compile", "build ", "baue", "commit", "merge", "pull request", " pr ",
    "unit test", "write a test", "schreib einen test", "bug", "stack trace", "stacktrace", "function", "funktion", "programmier", "code"];
  const codeNouns = ["repo", "repository", "```", ".swift", ".py", ".ts", ".js", "xcode", "git ", "npm ", "swift test", "compiler", "api endpoint"];
  if (has(codeVerbs) && (task.folder !== undefined || has(codeNouns))) return { id: "code", reason: task.folder !== undefined ? "coding task in a project folder" : "coding task" };
  if (has(codeNouns) && has(["implement", "fix", "build", "baue", "änder", "change", "add ", "füg"])) return { id: "code", reason: "coding task" };
  if (has(["recherch", "research", "look up", "search the web", "im internet", "im web", "on the web", "latest news", "aktuelle", "current price", "neueste", "sources", "quellen"])) {
    return { id: "research", reason: "needs the web" };
  }
  if (has(["zusammenfass", "summar", "tl;dr", "tldr", "übersetz", "translate", "sortier", "sort ", "classify", "kategorisier", "rechtschreib", "spell", "fasse "])) {
    return { id: "quick", reason: "summary / sorting / translation" };
  }
  if (has(["schreib", "write ", "draft", "entwurf", "entwirf", "formulier", "rewrite", "umschreib", "letter", "brief", "essay", "blog", "artikel", "article", "e-mail an", "email to"])) {
    return { id: "write", reason: "writing task" };
  }
  const words = task.text.split(/[ \n]+/).filter((w) => w !== "");
  if (words.length <= 12 && att === 0 && task.text.includes("?")) return { id: "quick", reason: "short question" };
  return undefined;
}

/** Ein eingerichtetes Modell (`provider/model`, wie in den KI-Einstellungen). */
export interface AvailableModel { ref: string; onDevice?: boolean }

export interface RouteDecision {
  /** Gewähltes Modell (`provider/model`) oder `undefined`, wenn keines eingerichtet ist. */
  model: string | undefined;
  level: ComputeLevel;
  routeID: string;
  routeName: string;
  reason: string;
  /** Weitere Kandidaten in Reihenfolge (falls das erste ausfällt). */
  fallbacks: string[];
  manual: boolean;
}

const providerOf = (ref: string) => ref.split("/")[0] ?? "";
const modelOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);

/** Stufen-Token gegen die Modelle auflösen (wie Swift `apiModel`: Anbieter des Standardmodells zuerst, sonst nächste Stufe). */
export function resolveTier(token: Token, models: readonly AvailableModel[], defaultModel: string | undefined): string | undefined {
  const cloud = models.filter((m) => !m.onDevice);
  const defaultIsCloud = defaultModel !== undefined && defaultModel !== "" && cloud.some((m) => m.ref === defaultModel);
  if (token === "@default") return defaultIsCloud ? defaultModel : cloud[0]?.ref;
  const tier: ModelTier = token === "@small" ? 0 : token === "@balanced" ? 1 : 2;
  const preferred = defaultIsCloud ? providerOf(defaultModel!) : "";
  const ordered = [...cloud.filter((m) => providerOf(m.ref) === preferred), ...cloud.filter((m) => providerOf(m.ref) !== preferred)];
  if (ordered.length === 0) return undefined;
  const exact = ordered.find((m) => modelTier(modelOf(m.ref)) === tier);
  if (exact) return exact.ref;
  if (tier === 1 && defaultIsCloud) return defaultModel;
  let best = ordered[0]!;
  for (const m of ordered) if (Math.abs(modelTier(modelOf(m.ref)) - tier) < Math.abs(modelTier(modelOf(best.ref)) - tier)) best = m;
  return best.ref;
}

/**
 * Modell für eine Aufgabe. `manual` (genaue Wahl) gewinnt immer; `forceLow` (Budget überschritten) erzwingt Low.
 * Ist keine Kette auflösbar, nimmt Auto das Standardmodell bzw. das erste eingerichtete (nie schlechter als ohne Routing).
 */
export function routeModel(task: RouteTask, level: ComputeLevel, models: readonly AvailableModel[], opts: { defaultModel?: string | undefined; manual?: string | undefined; forceLow?: boolean } = {}): RouteDecision {
  const picked = ruleRoute(task) ?? { id: "general", reason: "general task" };
  const route = ROUTES.find((r) => r.id === picked.id) ?? ROUTES[ROUTES.length - 1]!;
  if (opts.manual) return { model: opts.manual, level, routeID: route.id, routeName: route.name, reason: "chosen model", fallbacks: [], manual: true };
  const lvl: ComputeLevel = opts.forceLow ? "low" : level;
  let reason = picked.reason;
  if (opts.forceLow && level !== "low") reason += "; budget exceeded → Low";
  const out: string[] = [];
  for (const t of route[lvl]) { const m = resolveTier(t, models, opts.defaultModel); if (m && !out.includes(m)) out.push(m); }
  const plain = opts.defaultModel && models.some((m) => m.ref === opts.defaultModel) ? opts.defaultModel : models.find((m) => !m.onDevice)?.ref ?? models[0]?.ref;
  if (out.length === 0 && plain) { out.push(plain); reason += "; no route candidate available"; }
  else if (plain && !out.includes(plain)) out.push(plain);
  return { model: out[0], level: lvl, routeID: route.id, routeName: route.name, reason, fallbacks: out.slice(1), manual: false };
}
