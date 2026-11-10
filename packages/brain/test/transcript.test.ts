// BSD-77: Transkripte als ChatEvent-Folge in Records – Round-Trip aller Ereignisarten, Segmente (max. Größe, nur das
// letzte ändert sich), Übertragung wie über Sync v2, Import alter Swift-Transkripte an Fixtures.
import { describe, expect, it } from "vitest";
import { addRow, createDatabase, createPage, MarkdownImporter, makeBlock, makeRecordID, parseRecord, sortKeys, toRichText, type MarkdownBlock, type WorkspaceStore } from "@based/core";
import {
  ChatStore, CHAT_TYPE, CHUNK_TYPE, chunkEvents, compactEvents, findLegacyChats, foldTranscript, importLegacyChat, importLegacyChats, legacyToEvents, looksLikeLegacyTranscript,
  parseLegacyTranscript, type ChatEvent, type StoredChatEvent,
} from "../src/index.js";
import { fixtureText, memoryStore } from "./helpers.js";

const ALL: StoredChatEvent[] = [
  { type: "userMessage", text: "Make a page about Lisbon", at: 1_800_000_000_000 },
  { type: "started", model: "anthropic/claude-x", sessionID: "sess-1" },
  { type: "thinking", text: "The user wants a page." },
  { type: "text", text: "I'll create it." },
  { type: "toolUse", id: "toolu_01", name: "create_page", input: { title: "Lisbon", markdown: "# Lisbon\n\n- Tram 28", nested: { deep: [1, 2, { x: null }] } } },
  { type: "usage", inputTokens: 1200, outputTokens: 80, costUSD: 0.0048, estimated: true, model: "anthropic/claude-x" },
  { type: "toolResult", id: "toolu_01", output: "Created page “Lisbon” (id: 6f0c)", isError: false },
  { type: "notice", text: "The answer hit the length limit and was continued." },
  { type: "text", text: "Done — the page **Lisbon** exists." },
  { type: "result", text: "Done — the page **Lisbon** exists.", sessionID: "sess-1", costUSD: 0.0048, isError: false },
  { type: "userMessage", text: "and delete it" },
  { type: "thinkingDelta", text: "hm" },
  { type: "textDelta", text: "I can" },
  { type: "toolStart", id: "toolu_02", name: "trash_page" },
  { type: "toolInputDelta", id: "toolu_02", json: '{"page_id":' },
  { type: "failed", message: "Stopped.", stopped: true },
  { type: "userMessage", text: "third" },
  { type: "toolUse", id: "toolu_03", name: "search", input: {} },
  { type: "permissionRequest", id: "toolu_03", name: "search" },
  { type: "hologram", payload: { from: "a newer version" } },
  { type: "failed", message: "HTTP 529: Overloaded" },
];

const turnAt = (t: ReturnType<typeof foldTranscript>, i: number) => {
  const item = t.items[i];
  return item?.kind === "assistant" ? item.turn : undefined;
};

const chunksOf = (store: WorkspaceStore, chat: string) => store.children("b:" + chat).map((id) => store.blocks.get(id)!);

describe("ChatStore", () => {
  it("Round-Trip aller Ereignisarten, verlustfrei (Tool-Eingaben, IDs, Thinking, Unbekanntes)", () => {
    const store = memoryStore();
    const chats = new ChatStore(store);
    const chat = chats.create();
    chats.save(chat.id, 0, ALL);
    expect(chats.load(chat.id)).toEqual(ALL);
    // nach einem „Neustart“ (frischer Store auf derselben Persistenz) genauso
    const reopened = new ChatStore(new (store.constructor as typeof import("@based/core").WorkspaceStore)({ node: "t2", persistence: store.persistence! }));
    expect(reopened.load(chat.id)).toEqual(ALL);
    const t = foldTranscript(reopened.load(chat.id));
    const tool = turnAt(t, 1)?.parts.find((p) => p.kind === "tool");
    expect(tool).toMatchObject({ id: "toolu_01", toolName: "create_page", status: "done", input: { title: "Lisbon", nested: { deep: [1, 2, { x: null }] } } });
  });

  it("Chat-Record: Titel aus der ersten Frage, Kurzfassung, Summen, Modell", () => {
    const store = memoryStore();
    const chats = new ChatStore(store);
    const chat = chats.create();
    expect(chats.list()).toEqual([expect.objectContaining({ id: chat.id, title: "", events: 0 })]);
    chats.save(chat.id, 0, ALL);
    const info = chats.get(chat.id)!;
    expect(info).toMatchObject({ title: "Make a page about Lisbon", model: "anthropic/claude-x", summary: "I can", events: ALL.length });
    expect(info.usage).toEqual({ inputTokens: 1200, outputTokens: 80, costUSD: 0.0048, estimated: true });
    const b = store.blocks.get(chat.id)!;
    expect(b).toMatchObject({ type: CHAT_TYPE, parent: "w" });
    // Records sind gültiges Wire-Format (Sync v2 überträgt sie wie jeden Block)
    for (const r of store.allRecords()) expect(() => parseRecord(structuredClone(r))).not.toThrow();
    chats.rename(chat.id, "Lisbon");
    expect(chats.get(chat.id)!.title).toBe("Lisbon");
    chats.save(chat.id, ALL.length, [{ type: "userMessage", text: "later" }]);
    expect(chats.get(chat.id)!.title, "ein gesetzter Titel bleibt").toBe("Lisbon");
  });

  it("Transkript-Schreiben ist kein Undo-Schritt", () => {
    const store = memoryStore();
    const chats = new ChatStore(store);
    const page = createPage(store, { title: "Mine" });
    const chat = chats.create();
    chats.save(chat.id, 0, ALL);
    store.undo();
    expect(store.blocks.has(page), "Undo nimmt die Seite zurück …").toBe(false);
    expect(chats.load(chat.id), "… nicht den Chat").toEqual(ALL);
    expect(store.canUndo).toBe(false);
  });

  it("Segmente: höchstens maxChunkBytes, ein übergroßes Ereignis allein", () => {
    const events: ChatEvent[] = Array.from({ length: 40 }, (_, i) => ({ type: "text", text: `${i}:` + "x".repeat(180) }));
    events.splice(10, 0, { type: "toolResult", id: "big", output: "y".repeat(5000), isError: false });
    const parts = chunkEvents(events, 1000);
    expect(parts.flat()).toEqual(events);
    for (const p of parts) expect(p.length === 1 || JSON.stringify(p).length <= 1000 + p.length + 1).toBe(true);
    expect(parts.find((p) => p.some((e) => e.type === "toolResult"))).toHaveLength(1);
    expect(parts.length).toBeGreaterThan(8);
  });

  it("live: nur das letzte Segment wird neu geschrieben, ältere bleiben byte-gleich", () => {
    const store = memoryStore();
    const chats = new ChatStore(store, { maxChunkBytes: 1000 });
    const chat = chats.create();
    const turn = (n: number): ChatEvent[] => [{ type: "userMessage", text: "question " + n }, { type: "text", text: `answer ${n} ` + "z".repeat(300) }, { type: "result", text: "", isError: false }];
    let all: ChatEvent[] = [];
    for (let n = 0; n < 6; n++) {
      const t = turn(n);
      chats.save(chat.id, all.length, t);
      all = [...all, ...t];
    }
    expect(chats.load(chat.id)).toEqual(all);
    const before = chunksOf(store, chat.id).map((b) => JSON.stringify(b));
    expect(before.length).toBeGreaterThanOrEqual(3);

    // Ein Turn streamt: mehrfach speichern, der Turn wächst und wird am Ende verdichtet.
    const base = all.length;
    const written: string[][] = [];
    const off = store.observe((c) => written.push(c.keys));
    const live: ChatEvent[] = [{ type: "userMessage", text: "stream please" }];
    chats.save(chat.id, base, live);
    for (const w of ["Hello", " there", ", this", " is", " streamed."]) {
      live.push({ type: "textDelta", text: w });
      chats.save(chat.id, base, live);
    }
    live.push({ type: "text", text: "Hello there, this is streamed." }, { type: "result", text: "Hello there, this is streamed.", isError: false });
    chats.save(chat.id, base, live);
    off();

    const after = chunksOf(store, chat.id);
    const lastOld = before.length - 1;
    for (let i = 0; i < lastOld; i++) expect(JSON.stringify(after[i]), `Segment ${i} unverändert`).toBe(before[i]);
    const oldIDs = new Set(after.slice(0, lastOld).map((b) => "block:" + b.id));
    for (const keys of written) for (const k of keys) expect(oldIDs.has(k), "kein älteres Segment im Change").toBe(false);
    for (const keys of written) expect(keys.length, "je Speichern: letztes Segment (+ ggf. ein neues) + Chat").toBeLessThanOrEqual(3);
    expect(chats.load(chat.id)).toEqual([...all, ...compactEvents(live)]);
    expect(chats.load(chat.id).slice(-3).map((e) => e.type)).toEqual(["userMessage", "text", "result"]);
    expect(chats.get(chat.id)!.events).toBe(all.length + 3);
    for (const c of after) expect(c.type).toBe(CHUNK_TYPE);
  });

  it("ein Turn, der schrumpft, räumt überzählige Segmente ab", () => {
    const store = memoryStore();
    const chats = new ChatStore(store, { maxChunkBytes: 400 });
    const chat = chats.create();
    const long: ChatEvent[] = Array.from({ length: 12 }, (_, i) => ({ type: "notice", text: `n${i} ` + "q".repeat(100) }));
    chats.save(chat.id, 0, [{ type: "userMessage", text: "q" }, ...long]);
    const many = chunksOf(store, chat.id).length;
    const r = chats.save(chat.id, 1, [{ type: "text", text: "short" }]);
    expect(r.removed).toBeGreaterThan(0);
    expect(chunksOf(store, chat.id).length).toBeLessThan(many);
    expect(chats.load(chat.id)).toEqual([{ type: "userMessage", text: "q" }, { type: "text", text: "short" }]);
  });

  it("überträgt sich wie über Sync: Records in einen zweiten Store, dort lesbar; Löschen als Tombstones", () => {
    const a = memoryStore("a");
    const chatsA = new ChatStore(a, { maxChunkBytes: 600 });
    const chat = chatsA.create();
    const sent: string[] = [];
    const b = memoryStore("b");
    // was der Sync-Client pusht: die Records jeder lokalen Änderung
    a.observe((c) => {
      const upserts = c.keys.map((k) => a.record(k)).filter((r) => r !== undefined).map((r) => structuredClone(r));
      const deletions = c.keys.filter((k) => !a.record(k));
      sent.push(...c.keys);
      b.applyRemote(upserts, deletions);
    });
    b.applyRemote([structuredClone(a.record(`block:${chat.id}`)!)], []);
    chatsA.save(chat.id, 0, ALL);
    const chatsB = new ChatStore(b);
    expect(chatsB.load(chat.id)).toEqual(ALL);
    expect(chatsB.list().map((c) => c.title)).toEqual(["Make a page about Lisbon"]);
    chatsA.delete(chat.id);
    expect(chatsB.list()).toEqual([]);
    expect(b.children("b:" + chat.id)).toEqual([]);
    expect(sent.length).toBeGreaterThan(2);
  });

  it("Liste: zuletzt geänderte zuerst; unbekannter Chat wirft", () => {
    const store = memoryStore();
    const chats = new ChatStore(store);
    const one = chats.create({ title: "one" }), two = chats.create({ title: "two" });
    chats.append(one.id, [{ type: "userMessage", text: "bump" }]);
    expect(chats.list().map((c) => c.title)).toEqual(["one", "two"]);
    expect(() => chats.load("nope")).toThrow();
    expect(chats.get(two.id)?.title).toBe("two");
  });
});

describe("alte Swift-Transkripte (Markdown mit **Rolle**)", () => {
  it("Session-Fixture: Rollen, Tool mit Ergebnis, Diff, Plan, Hinweis", () => {
    const items = parseLegacyTranscript(fixtureText("legacy-session.md"));
    expect(items.map((i) => i.kind)).toEqual(["user", "thought", "tool", "tool", "diff", "plan", "agent", "notice", "user"]);
    expect(items[2]).toEqual({ kind: "tool", text: "Read(/src/a.swift)", toolKind: "read", output: "let a = 1", failed: false });
    expect(items[4]).toEqual({ kind: "diff", text: "/src/a.swift", output: "@@ -1,1 +1,1 @@\n-let a = 1\n+let a = 2" });
    const events = legacyToEvents(items);
    expect(events.map((e) => e.type)).toEqual(["userMessage", "thinking", "toolUse", "toolResult", "toolUse", "toolUse", "toolResult", "text", "text", "notice", "result", "userMessage"]);
    const t = foldTranscript(events);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant", "user"]);
    const turn = turnAt(t, 1);
    expect(turn!.parts.map((p) => [p.kind, p.toolName, p.detail])).toEqual([
      ["thinking", "", ""], ["tool", "read", "Read(/src/a.swift)"], ["tool", "edit", "Edit(/src/a.swift)"], ["tool", "Edit", "/src/a.swift"], ["text", "", ""], ["text", "", ""],
    ]);
    expect(turn!.parts[1]!.output).toBe("let a = 1");
    expect(turn!.parts[3]!.output).toContain("+let a = 2");
    expect(turn!.parts[4]!.text).toBe("**Plan**\n\n- [completed] Read\n- [pending] Test");
    expect(turn!.notices).toEqual(["Model: opus"]);
    expect(turn!.done).toBe(true);
    expect(new Set(turn!.parts.map((p) => p.id)).size).toBe(turn!.parts.length);
  });

  it("Chat-Fixture: Agent-Stücke zusammen, gescheitertes Tool, Fehler beendet den Turn", () => {
    const events = legacyToEvents(parseLegacyTranscript(fixtureText("legacy-chat.md")));
    const t = foldTranscript(events);
    expect(t.items.map((i) => (i.kind === "user" ? i.text : "·"))).toEqual(["Which pages mention the Lisbon trip?", "·", "Delete both.", "·", "ok, never mind"]);
    const first = turnAt(t, 1);
    expect(first!.text).toBe("Two pages mention it: **Lisbon trip** and *Packing list*.\n\nWant me to open one?");
    expect(first!.parts[1]).toMatchObject({ toolName: "search", detail: "Lisbon", output: "- Lisbon trip (id: 6f0c)\n- Packing list (id: 9a1d)", status: "done" });
    const second = turnAt(t, 3);
    expect(second!.parts[0]).toMatchObject({ toolName: "trash_page", status: "failed", output: "Permission denied" });
    expect(second!.error).toBe("HTTP 529: Overloaded");
  });

  it("Text ohne Rollen ist kein Transkript; unbekannte **Fettzeilen** bleiben Text", () => {
    expect(parseLegacyTranscript("Just a page\n\n**Important**\n\ntext")).toEqual([]);
    expect(looksLikeLegacyTranscript("\n**You**\nhi")).toBe(true);
    expect(looksLikeLegacyTranscript("**Important**\nhi")).toBe(false);
    const items = parseLegacyTranscript("**Agent**\nSee:\n\n**Important**\n\nthis");
    expect(items).toEqual([{ kind: "agent", text: "See:\n\n**Important**\n\nthis" }]);
  });

  /** Markdown als Blöcke in eine Seite schreiben – so, wie die Mac-App Transkripte abgelegt hat (appendBody). */
  function putMarkdown(store: WorkspaceStore, page: string, md: string) {
    const put = (items: MarkdownBlock[], parent: string) => {
      const keys = sortKeys(store, parent, { kind: "end" }, items.length);
      store.transact("t", (tx) => items.forEach((item, i) => {
        const id = makeRecordID();
        tx.put({ kind: "block", data: makeBlock({ id, type: item.type, parent, sk: keys[i]!, text: toRichText(item.text), props: { ...item.props } }, store.now()) });
      }));
    };
    put(new MarkdownImporter().parse(md), "b:" + page);
  }

  it("Import aus dem Store: Sessions-Zeile → neuer Chat, alte Seite bleibt, kein Doppel-Import", () => {
    const store = memoryStore();
    const brain = createPage(store, { title: "Agent Brain" });
    const db = createDatabase(store, { parent: "b:" + brain, title: "Sessions", inline: true, sampleRows: 0 }).databaseID;
    const row = addRow(store, db, { title: "Lisbon search" })!;
    putMarkdown(store, row, fixtureText("legacy-chat.md"));
    const empty = addRow(store, db, { title: "Empty session" })!;
    const notes = createPage(store, { title: "Notes" });
    putMarkdown(store, notes, "**You**\n\nnot in Sessions");

    expect(findLegacyChats(store)).toEqual([{ pageID: row, title: "Lisbon search" }]);
    const chats = new ChatStore(store);
    const blocksBefore = store.children("b:" + row).length;
    const imported = importLegacyChats(chats);
    expect(imported.map((c) => [c.title, c.importedFrom])).toEqual([["Lisbon search", row]]);
    expect(store.children("b:" + row).length, "die alte Seite bleibt unverändert").toBe(blocksBefore);
    const t = foldTranscript(chats.load(imported[0]!.id));
    expect(t.items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual(["Which pages mention the Lisbon trip?", "Delete both.", "ok, never mind"]);
    const first = turnAt(t, 1);
    expect(first!.text).toContain("Two pages mention it: **Lisbon trip** and *Packing list*.");
    expect(first!.parts.find((p) => p.kind === "tool")).toMatchObject({ toolName: "search", output: "- Lisbon trip (id: 6f0c)\n- Packing list (id: 9a1d)" });
    // zweiter Lauf: nichts Neues
    expect(importLegacyChats(chats)).toEqual([]);
    expect(importLegacyChat(chats, row)?.id).toBe(imported[0]!.id);
    expect(chats.list()).toHaveLength(1);
    expect(importLegacyChat(chats, empty)).toBeUndefined();
    // eine einzelne Seite außerhalb von Sessions lässt sich gezielt übernehmen
    expect(importLegacyChat(chats, notes)?.title).toBe("Notes");
  });
});
