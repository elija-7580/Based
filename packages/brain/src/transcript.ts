// BSD-77: Chat- und Agenten-Transkripte strukturiert ab Tag 1 – als ChatEvent-Folge in Records, die Sync v2 wie
// jeden anderen Block überträgt.
//
// Format (Blöcke mit offenen Typen; ADR 0002: unbekannte Typen/Felder bleiben überall erhalten):
//   Chat:   { type: "chat", parent: "w", text: <Titel>, props: { chat: { v: 1, usage, model, summary, events } } }
//   Chunk:  { type: "transcriptChunk", parent: "b:<chatID>", sk, props: { events: ChatEvent[] } }
// Große Transkripte liegen in Segmenten (Chunks) von höchstens `maxChunkBytes` JSON. Geschrieben wird immer nur ab
// der Stelle, die sich geändert hat – im laufenden Turn also nur der letzte Chunk (wie Meeting-Transkripte), ältere
// Chunks bleiben byte-gleich und erzeugen keine Sync-Last. Der Chat-Block trägt eine lesbare Kurzfassung.
// Transkript-Schreiben ist kein Undo-Schritt (⌘Z nimmt keine Chat-Nachrichten zurück).
import { keyOf, makeBlock, makeRecordID, plainText, sortKeys, type Block, type JSONValue, type WorkspaceStore } from "@based/core";
import { compactEvents, parseChatEvents, type StoredChatEvent } from "./events.js";
import { foldTranscript, ZERO_USAGE, type TurnUsage } from "./turn.js";

export const CHAT_TYPE = "chat";
export const CHUNK_TYPE = "transcriptChunk";
export const DEFAULT_CHUNK_BYTES = 32_000;

export interface ChatInfo {
  id: string;
  title: string;
  /** Swift-Datum (Sekunden seit 2001), wie alle Zeiten im Store. */
  createdAt: number;
  updatedAt: number;
  usage: TurnUsage;
  model?: string;
  /** Lesbare Kurzfassung (Anfang der letzten Antwort). */
  summary?: string;
  /** Anzahl gespeicherter Ereignisse. */
  events: number;
  /** Seite, aus der ein altes Swift-Transkript übernommen wurde. */
  importedFrom?: string;
}

export interface ChatMeta {
  usage?: TurnUsage;
  model?: string | undefined;
  summary?: string | undefined;
  title?: string | undefined;
}

type ChatProps = { v: number; usage?: TurnUsage; model?: string; summary?: string; events?: number; importedFrom?: string; [key: string]: unknown };

const chatProps = (b: Block): ChatProps => {
  const p = (b.props as { chat?: unknown } | undefined)?.chat;
  return p !== null && typeof p === "object" ? (p as ChatProps) : { v: 1 };
};

const bytes = (e: StoredChatEvent) => JSON.stringify(e).length;

/** Ereignisse in Segmente teilen: gierig bis `max` Zeichen JSON; ein übergroßes Ereignis bekommt ein eigenes. */
export function chunkEvents(events: readonly StoredChatEvent[], max = DEFAULT_CHUNK_BYTES): StoredChatEvent[][] {
  const out: StoredChatEvent[][] = [];
  let cur: StoredChatEvent[] = [];
  let size = 0;
  for (const e of events) {
    const n = bytes(e);
    if (cur.length > 0 && size + n > max) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Titel aus der ersten Nutzer-Nachricht. */
export function chatTitleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? line.slice(0, 59).trimEnd() + "…" : line;
}

/** Kurzfassung und Summen aus einem ganzen Transkript. */
export function chatMetaFrom(events: readonly StoredChatEvent[]): Required<Pick<ChatMeta, "usage">> & ChatMeta {
  const t = foldTranscript(events);
  let summary: string | undefined, model: string | undefined, title: string | undefined;
  for (const item of t.items) {
    if (item.kind === "user") title ??= chatTitleFrom(item.text);
    else {
      const text = item.turn.text.trim();
      if (text) summary = text.length > 280 ? text.slice(0, 279) + "…" : text;
      model = item.turn.model ?? model;
    }
  }
  return { usage: t.usage, ...(summary ? { summary } : {}), ...(model ? { model } : {}), ...(title ? { title } : {}) };
}

export class ChatStore {
  readonly maxChunkBytes: number;

  constructor(readonly store: WorkspaceStore, opts: { maxChunkBytes?: number } = {}) {
    this.maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_CHUNK_BYTES;
  }

  private info(b: Block): ChatInfo {
    const p = chatProps(b);
    const info: ChatInfo = { id: b.id, title: plainText(b.text), createdAt: b.createdAt, updatedAt: b.updatedAt, usage: p.usage ?? { ...ZERO_USAGE }, events: p.events ?? 0 };
    if (p.model) info.model = p.model;
    if (p.summary) info.summary = p.summary;
    if (p.importedFrom) info.importedFrom = p.importedFrom;
    return info;
  }

  private chat(id: string): Block {
    const b = this.store.blocks.get(id);
    if (!b || b.type !== CHAT_TYPE) throw new Error(`No chat with id ${id}`);
    return b;
  }

  /** Alle Chats, zuletzt geänderte zuerst. */
  list(): ChatInfo[] {
    const out: ChatInfo[] = [];
    for (const id of this.store.children("w")) {
      const b = this.store.blocks.get(id);
      if (b?.type === CHAT_TYPE && b.trashedAt === undefined) out.push(this.info(b));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  }

  get(id: string): ChatInfo | undefined {
    const b = this.store.blocks.get(id);
    return b?.type === CHAT_TYPE ? this.info(b) : undefined;
  }

  create(opts: { id?: string; title?: string; importedFrom?: string } = {}): ChatInfo {
    const id = opts.id ?? makeRecordID();
    const chat: ChatProps = { v: 1, events: 0 };
    if (opts.importedFrom) chat.importedFrom = opts.importedFrom;
    this.store.transact("New chat", (tx) => {
      const [sk] = sortKeys(this.store, "w", { kind: "end" }, 1);
      const b = makeBlock({ id, type: CHAT_TYPE, parent: "w", sk: sk!, props: { chat } as Block["props"] & object, createdBy: this.store.userID, ...(opts.title ? { text: opts.title } : {}) }, this.store.now());
      tx.put({ kind: "block", data: b });
    }, { undoable: false });
    return this.get(id)!;
  }

  rename(id: string, title: string) {
    this.chat(id);
    this.store.transact("Rename chat", (tx) => tx.update(id, (x) => {
      if (title === "") delete x.text;
      else x.text = title;
    }), { undoable: false });
  }

  /** Chat mit allen Segmenten löschen (als Tombstones gesynct). */
  delete(id: string) {
    this.chat(id);
    this.store.transact("Delete chat", (tx) => {
      // Kopie: `children` ist die lebende Liste des Stores und schrumpft beim Entfernen.
      for (const c of [...this.store.children("b:" + id)]) tx.remove(keyOf("block", c));
      tx.remove(keyOf("block", id));
    }, { undoable: false });
  }

  private chunks(id: string): Block[] {
    return this.store.children("b:" + id).map((c) => this.store.blocks.get(c)).filter((b): b is Block => b?.type === CHUNK_TYPE);
  }

  /** Das ganze Transkript in Reihenfolge. */
  load(id: string): StoredChatEvent[] {
    this.chat(id);
    return this.chunks(id).flatMap((c) => parseChatEvents((c.props as { events?: unknown } | undefined)?.events));
  }

  /**
   * Ereignisse ab Index `base` durch `tail` ersetzen (alles davor bleibt unangetastet). So schreibt ein laufender Turn
   * nur seinen eigenen Teil neu: `base` = Zahl der Ereignisse vor dem Turn. Gibt die Zahl geschriebener/gelöschter
   * Segmente zurück. `meta` spart das Falten des ganzen Transkripts.
   */
  save(id: string, base: number, tail: readonly StoredChatEvent[], meta?: ChatMeta): { written: number; removed: number; events: number } {
    this.chat(id);
    const chunks = this.chunks(id);
    const lists = chunks.map((c) => parseChatEvents((c.props as { events?: unknown } | undefined)?.events));
    // Erstes Segment, das Ereignisse ab `base` enthält (oder das letzte, wenn angehängt wird und dort noch Platz ist).
    let first = 0, before = 0;
    while (first < lists.length && before + lists[first]!.length <= base) {
      before += lists[first]!.length;
      first += 1;
    }
    let keep: StoredChatEvent[] = [];
    if (first < lists.length) keep = lists[first]!.slice(0, Math.max(0, base - before));
    else if (first > 0 && base === before) {
      // Anhängen: das letzte Segment weiter füllen, statt für jedes Ereignis ein neues anzulegen.
      first -= 1;
      before -= lists[first]!.length;
      keep = lists[first]!;
    }
    const fresh = chunkEvents([...keep, ...compactEvents(tail)], this.maxChunkBytes);
    let written = 0, removed = 0;
    const total = before + fresh.reduce((n, c) => n + c.length, 0);
    const all = meta ? undefined : [...lists.slice(0, first).flat(), ...fresh.flat()];
    const m = meta ?? chatMetaFrom(all!);
    this.store.transact("Chat", (tx) => {
      const reuse = chunks.slice(first);
      const extra = fresh.length - reuse.length;
      const newKeys = extra > 0 ? sortKeys(this.store, "b:" + id, { kind: "end" }, extra) : [];
      fresh.forEach((events, i) => {
        const old = reuse[i];
        if (old) {
          if (JSON.stringify(lists[first + i]) === JSON.stringify(events)) return;
          tx.update(old.id, (x) => { x.props = { ...(x.props ?? {}), events } as Block["props"] & object; });
        } else {
          tx.put({ kind: "block", data: makeBlock({ id: makeRecordID(), type: CHUNK_TYPE, parent: "b:" + id, sk: newKeys[i - reuse.length]!, props: { events } as Block["props"] & object, createdBy: this.store.userID }, this.store.now()) });
        }
        written += 1;
      });
      for (const old of reuse.slice(fresh.length)) {
        tx.remove(keyOf("block", old.id));
        removed += 1;
      }
      tx.update(id, (x) => {
        const p: ChatProps = { ...chatProps(x), v: 1, usage: m.usage ?? chatProps(x).usage ?? { ...ZERO_USAGE }, events: total };
        if (m.model) p.model = m.model;
        if (m.summary) p.summary = m.summary;
        x.props = { ...(x.props ?? {}), chat: p as unknown as JSONValue } as Block["props"] & object;
        if (plainText(x.text) === "" && m.title) x.text = m.title;
      });
    }, { undoable: false });
    return { written, removed, events: total };
  }

  /** Ereignisse ans Ende hängen. */
  append(id: string, events: readonly StoredChatEvent[], meta?: ChatMeta) {
    return this.save(id, this.get(id)?.events ?? this.load(id).length, events, meta);
  }
}
