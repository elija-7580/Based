// BSD-159 / BSD-77: Chat-Seite des Store-Hosts. Transkripte liegen als Records im Store (ChatStore), Werkzeuge der
// Agenten laufen hier auf dem echten WorkspaceStore (WorkspaceTools) – jede Änderung ist eine Transaktion, wird
// gespeichert, gesynct und erscheint in offenen Seiten. Die Engine selbst (Netz, API-Schlüssel) läuft im
// Hauptthread; der Schlüssel kommt nie hierher.
import { parseKey, type SearchIndex, type StoreChange, type WorkspaceStore } from "@based/core";
import { CHAT_TYPE, ChatStore, importLegacyChats, WorkspaceTools, type ChatInfo, type ChatMeta, type StoredChatEvent, type ToolResult, type ToolSpec } from "@based/brain";
import type { JSONValue } from "@based/core";

export type ChatAction =
  | { op: "list" }
  | { op: "create"; title?: string }
  | { op: "load"; id: string }
  /** Ereignisse ab `base` ersetzen (der laufende Turn schreibt nur seinen eigenen Teil neu). */
  | { op: "save"; id: string; base: number; events: StoredChatEvent[]; meta?: ChatMeta }
  | { op: "rename"; id: string; title: string }
  | { op: "delete"; id: string }
  | { op: "toolSpecs" }
  | { op: "tool"; name: string; input: JSONValue }
  /** Alte Swift-Transkripte (Datenbank „Sessions“) als Chats übernehmen. */
  | { op: "importLegacy" };

export interface ChatLoaded {
  info: ChatInfo;
  events: StoredChatEvent[];
}

export interface ToolCatalog {
  specs: ToolSpec[];
  /** Namen der Werkzeuge, die schreiben. */
  write: string[];
}

export class ChatHost {
  readonly chats: ChatStore;
  readonly tools: WorkspaceTools;
  private ids = new Set<string>();
  private dirty = false;

  constructor(private readonly store: WorkspaceStore, searchIndex: () => SearchIndex) {
    this.chats = new ChatStore(store);
    this.tools = new WorkspaceTools(store, { search: (query, limit) => searchIndex().search(query, {}, "bestMatch", limit * 2) });
    for (const c of this.chats.list()) this.ids.add(c.id);
  }

  handle(a: ChatAction): unknown {
    switch (a.op) {
      case "list": return this.chats.list();
      case "create": return this.checked(() => this.chats.create(a.title ? { title: a.title } : {}));
      case "load": {
        const info = this.chats.get(a.id);
        if (!info) throw new Error("This chat no longer exists.");
        return { info, events: this.chats.load(a.id) } satisfies ChatLoaded;
      }
      case "save": return this.checked(() => this.chats.save(a.id, a.base, a.events, a.meta));
      case "rename": return this.checked(() => this.chats.rename(a.id, a.title));
      case "delete": return this.checked(() => this.chats.delete(a.id));
      case "toolSpecs": {
        const specs = this.tools.specs;
        return { specs, write: specs.map((s) => s.name).filter((n) => this.tools.isWrite(n)) } satisfies ToolCatalog;
      }
      case "tool": return this.tools.callSync(a.name, a.input) satisfies ToolResult;
      case "importLegacy": return this.checked(() => importLegacyChats(this.chats));
    }
  }

  /** Der Store weist Schreiben still ab, wenn er schreibgeschützt ist: als Fehler melden, nicht als Erfolg. */
  private checked<T>(body: () => T): T {
    const out = body();
    if (this.store.isReadOnly) throw new Error("read-only: " + (this.store.writeFailure?.message ?? ""));
    return out;
  }

  /** Hat sich die Chat-Liste geändert (lokal oder über Sync)? */
  noteChange(change: StoreChange) {
    for (const key of change.keys) {
      const { kind, id } = parseKey(key);
      if (kind !== "block") continue;
      const b = this.store.blocks.get(id);
      if (b?.type === CHAT_TYPE) {
        this.ids.add(id);
        this.dirty = true;
      } else if (!b && this.ids.delete(id)) this.dirty = true;
    }
  }

  /** Die Liste, falls sie sich seit dem letzten Aufruf geändert hat. */
  takeList(): ChatInfo[] | undefined {
    if (!this.dirty) return undefined;
    this.dirty = false;
    return this.chats.list();
  }
}
