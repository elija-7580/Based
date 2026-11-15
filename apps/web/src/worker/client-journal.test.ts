// BSD-416: Beim Verlassen noch unbestätigte Editor-Änderungen ins Journal (localStorage), beim nächsten Start
// nachholen – nur wo neuer als der gespeicherte Stand. WebKit (Mac, Tauri) verlor sonst die letzten getippten
// Zeichen, wenn sofort neu geladen wurde (der Store-Worker ging mit seiner Warteschlange unter).
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { afterEach, describe, expect, it } from "vitest";
import type { WireRecord } from "@based/core";
import { JOURNAL_PREFIX, StoreClient, type JournalStorage } from "./client.js";
import { StoreHost } from "./host.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

type Fn<T> = (e: { data: T }) => void;
let hosts: StoreHost[] = [];
afterEach(() => { hosts.forEach((h) => h.stop()); hosts = []; });

class MapStorage implements JournalStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

/** Ein Client, dessen Store-Worker nie antwortet (hängt bzw. ist schon weg). */
function silentClient() {
  const sent: RequestMessage[] = [];
  const end: Endpoint<Event, RequestMessage> = { postMessage: (m) => void sent.push(m), addEventListener: () => undefined, removeEventListener: () => undefined };
  return { client: new StoreClient(end), sent };
}

function setup() {
  const toHost = new Set<Fn<RequestMessage>>();
  const toClient = new Set<Fn<Event>>();
  const end: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const db = openNodeDatabase(":memory:");
  const host = new StoreHost({
    post: (e) => { const c = structuredClone(e); setTimeout(() => toClient.forEach((f) => f({ data: c }))); },
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
  });
  hosts.push(host);
  let queue = Promise.resolve();
  toHost.add((e) => { queue = queue.then(() => host.handle(e.data)); });
  return { host, client: new StoreClient(end) };
}

const block = (id: string, text: string, millis: number, node = "a"): WireRecord =>
  ({ kind: "block", data: { id, type: "paragraph", parent: "b:p", sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis, counter: 0, node } } }) as WireRecord;

describe("BSD-416 Journal unbestätigter Änderungen", () => {
  it("sichert nur unbeantwortete applyLocal-Records (letzte Version je Record), keine Befehle", () => {
    const { client } = silentClient();
    void client.request({ type: "applyLocal", pageID: "p", upserts: [block("x", "ty", 10)], deletions: [] });
    void client.request({ type: "applyLocal", pageID: "p", upserts: [block("x", "typed", 11), block("y", "line", 11)], deletions: [] });
    void client.command({ op: "createPage", title: "Not journaled" });
    const s = new MapStorage();
    expect(client.journalUnsaved(s, JOURNAL_PREFIX + "t")).toBe(2);
    const saved = JSON.parse(s.getItem(JOURNAL_PREFIX + "t")!) as { upserts: WireRecord[] };
    expect(saved.upserts.map((r) => [r.data.id, (r.data as { text: string }).text])).toEqual([["x", "typed"], ["y", "line"]]);
    expect(JSON.stringify(saved)).not.toContain("Not journaled");
    // nichts offen → nichts geschrieben
    expect(silentClient().client.journalUnsaved(s, JOURNAL_PREFIX + "u")).toBe(0);
    expect(s.getItem(JOURNAL_PREFIX + "u")).toBeNull();
  });

  it("nächster Start holt nach – nur was neuer ist –, dann ist das Journal leer", async () => {
    const { client } = setup();
    await client.init({ device: "dev" });
    const page = await client.command<string>({ op: "createPage", title: "Journal page" });
    const fresh = { ...block("j1", "typed before reload", Date.now() + 1000), data: { ...block("j1", "", 0).data, parent: "b:" + page, text: "typed before reload", stamp: { millis: Date.now() + 1000, counter: 0, node: "a" } } } as WireRecord;
    // auf dem Gerät schon neuer gespeichert: bleibt
    const kept = { kind: "block", data: { ...fresh.data, id: "j2", text: "newer on disk", sk: "a1", stamp: { millis: Date.now() + 5000, counter: 0, node: "a" } } } as WireRecord;
    await client.request({ type: "applyLocal", pageID: page, upserts: [kept], deletions: [] });
    const stale = { kind: "block", data: { ...kept.data, text: "older journal copy", stamp: { millis: Date.now() + 2000, counter: 0, node: "a" } } } as WireRecord;
    const s = new MapStorage();
    s.setItem(JOURNAL_PREFIX + "a", JSON.stringify({ v: 1, at: 0, upserts: [fresh, stale] }));
    s.setItem(JOURNAL_PREFIX + "b", "kaputt");
    s.setItem("other.key", "bleibt");
    expect(await client.replayJournal(s)).toBe(2);
    expect([...s.m.keys()]).toEqual(["other.key"]);
    const opened = await client.openPage(page);
    expect(opened.store.blocks.get("j1")?.text).toBe("typed before reload");
    expect(opened.store.blocks.get("j2")?.text).toBe("newer on disk");
    // zweites Nachholen derselben Daten ändert nichts
    s.setItem(JOURNAL_PREFIX + "c", JSON.stringify({ v: 1, at: 0, upserts: [fresh] }));
    await client.replayJournal(s);
    expect(s.m.size).toBe(1);
  });
});
