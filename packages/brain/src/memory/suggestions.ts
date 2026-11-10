// BSD-163 / BSD-59: Memory-Vorschläge aus Chats. Nach einem Turn liest ein kleines Modell den letzten Austausch und
// die Titel der vorhandenen Memories und schlägt höchstens drei neue oder erweiterte Memories vor. Gespeichert wird
// NICHTS, bevor der Nutzer bestätigt (Save · Dismiss); sensible Themen (Gesundheit, Geld) sind markiert.
// Port von Swift `MemoryExtractor` (Prompt, Lesen der Antwort, Ähnlichkeit, sensibel).

export const MEMORY_KINDS = ["Profile", "Preference", "Work", "People", "Notes"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryRecord {
  id: string;
  title: string;
  kind: MemoryKind;
  body: string;
}

export interface MemorySuggestion {
  title: string;
  kind: MemoryKind;
  body: string;
  /** Die vorhandene Memory, die erweitert wird (ähnlicher Titel); fehlt = neue Memory. */
  updates?: string;
  sensitive: boolean;
}

export const MAX_MEMORY_SUGGESTIONS = 3;
/** Kürzere Nachrichten tragen nichts Merkenswertes („danke“, „weiter“). */
export const MIN_MEMORY_USER_CHARS = 20;

export const MEMORY_EXTRACTOR_SYSTEM = `You maintain the user's long-term memories for a notes app. From the conversation excerpt, extract only durable facts the USER stated about themselves, their projects, people they work with or their preferences — nothing the assistant said, nothing about the current task only, nothing already in the existing memories. One topic per memory; title the topic, not the fact (e.g. "Writing style", "Project Based"). Reuse an existing title when the fact extends it. Mark health, medical, financial, legal or similarly private facts with "sensitive": true. At most 3. Reply with JSON only: {"memories": [{"title": "…", "type": "Profile|Preference|Work|People|Notes", "body": "one or two sentences", "sensitive": false}]} — or {"memories": []} when there is nothing.`;

export function memoryExtractorPrompt(exchange: string, existing: readonly MemoryRecord[]): string {
  const titles = existing.slice(0, 60).map((m) => `- ${m.title} (${m.kind})`).join("\n");
  return `Existing memories:\n${titles || "(none)"}\n\nConversation:\n${exchange}`;
}

export function normalizedWords(s: string): string {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
}

/** Gleiches Thema: gleich nach Normalisieren, eins im anderen enthalten oder die meisten Wörter gemeinsam. */
export function similarTitles(a: string, b: string): boolean {
  const x = normalizedWords(a), y = normalizedWords(b);
  if (!x || !y) return false;
  if (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))) return true;
  const wa = new Set(x.split(" ")), wb = new Set(y.split(" "));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return common / (wa.size + wb.size - common) >= 0.6;
}

const SENSITIVE = ["health", "medical", "diagnos", "illness", "therapy", "medication", "doctor", "salary", "debt", "bank account", "income", "finances", "pregnan",
  "gesundheit", "krank", "therapie", "medikament", "diagnose", "arzt", "gehalt", "schulden", "einkommen", "finanzen", "kontostand"];

export const looksSensitive = (text: string) => {
  const t = text.toLowerCase();
  return SENSITIVE.some((w) => t.includes(w));
};

/** Antwort des Modells (auch mit Codezaun oder Text drumherum) → höchstens drei Vorschläge. */
export function parseMemorySuggestions(answer: string, existing: readonly MemoryRecord[]): MemorySuggestion[] {
  const start = answer.search(/[{[]/);
  const end = Math.max(answer.lastIndexOf("}"), answer.lastIndexOf("]"));
  if (start < 0 || end <= start) return [];
  let v: unknown;
  try {
    v = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  const items = Array.isArray(v) ? v : Array.isArray((v as { memories?: unknown })?.memories) ? (v as { memories: unknown[] }).memories : [];
  const out: MemorySuggestion[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const body = typeof item.body === "string" ? item.body.trim() : "";
    if (!title || !body) continue;
    const kind = MEMORY_KINDS.find((k) => k.toLowerCase() === String(item.type ?? "").toLowerCase()) ?? "Notes";
    const s: MemorySuggestion = { title: title.slice(0, 80), kind, body: body.slice(0, 1000), sensitive: item.sensitive === true || looksSensitive(title + " " + body) };
    const match = existing.find((m) => similarTitles(m.title, s.title));
    if (match) {
      if (normalizedWords(match.body).includes(normalizedWords(s.body))) continue;
      s.updates = match.id;
      s.title = match.title;
      s.kind = match.kind;
    }
    if (out.some((o) => similarTitles(o.title, s.title))) continue;
    out.push(s);
    if (out.length === MAX_MEMORY_SUGGESTIONS) break;
  }
  return out;
}

/** Ein Austausch fürs Extrahieren: die letzte Nutzer-Nachricht und die Antwort darauf (gekürzt). */
export function exchangeText(user: string, answer: string, limit = 6000): string {
  return `User: ${user}\n\nAssistant: ${answer}`.slice(0, limit);
}

// MARK: Vorschläge im Transkript

/** Ereignis im Chat-Transkript (unbekannter Typ für ältere Versionen – bleibt erhalten, wird nicht gezeichnet). */
export interface MemorySuggestionEvent {
  type: "memorySuggestion";
  id: string;
  suggestion: MemorySuggestion;
  [key: string]: unknown;
}

export interface MemoryDecisionEvent {
  type: "memoryDecision";
  id: string;
  decision: "saved" | "dismissed";
  /** Die gespeicherte Memory. */
  memoryID?: string;
  [key: string]: unknown;
}

export interface PendingMemory {
  id: string;
  suggestion: MemorySuggestion;
  state: "pending" | "saved" | "dismissed";
  memoryID?: string;
}

/** Vorschläge und Entscheidungen eines Transkripts falten. */
export function memorySuggestionsOf(events: readonly { type: string; [key: string]: unknown }[]): PendingMemory[] {
  const out = new Map<string, PendingMemory>();
  for (const e of events) {
    if (e.type === "memorySuggestion") {
      const x = e as MemorySuggestionEvent;
      if (x.id && x.suggestion) out.set(x.id, { id: x.id, suggestion: x.suggestion, state: "pending" });
    } else if (e.type === "memoryDecision") {
      const x = e as MemoryDecisionEvent;
      const p = out.get(x.id);
      if (p) {
        p.state = x.decision;
        if (x.memoryID) p.memoryID = x.memoryID;
      }
    }
  }
  return [...out.values()];
}
