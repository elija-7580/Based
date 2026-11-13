// ADR 0016 (E7): Echtzeit-Text des neuen Editors – Y.Text je Block. Server + zwei Geräte im Speicher: Yjs-Updates
// und Records (Sync v2) werden direkt weitergereicht, Verbindungen lassen sich anhalten (gleichzeitiges Tippen).
import { describe, expect, it } from "vitest";
import { blockCommands as cmd, MemoryPersistence, plainText, WorkspaceStore, type Block, type RecordKeyString, type WireRecord } from "@based/core";
import * as Y from "yjs";
import { richTextOf, TEXTS, TextSession, writeRuns } from "../src/yjs/text-session.js";

const STAMP = { millis: 1, counter: 0, node: "seed" };
const blk = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, stamp: STAMP, ...extra } as Block,
});

describe("RichText ⇄ Y.Text", () => {
  it("Marks, Erwähnungen und Formeln mit gleichen Offsets; zwei gleiche Erwähnungen bleiben zwei", () => {
    const doc = new Y.Doc();
    const yt = doc.getMap<Y.Text>(TEXTS).set("a", new Y.Text());
    const mention = { page: { _0: "P" } };
    const text = [{ t: "Hi " }, { t: "bold", m: { b: true } }, { t: "@P", mention }, { t: "@P", mention }, { t: "x²", eq: "x^2" }, { t: " end", m: { link: "https://x.y" } }];
    writeRuns(yt, text as never);
    expect(yt.length).toBe(plainText(text as never).length);
    expect(richTextOf(yt)).toEqual(text);
    // Nur Formatierung ändern → umformatieren statt neu schreiben
    const bolder = [{ t: "Hi bold", m: { b: true } }, ...text.slice(2)];
    writeRuns(yt, bolder as never);
    expect(richTextOf(yt)).toEqual(bolder);
    writeRuns(yt, undefined);
    expect(yt.length).toBe(0);
    expect(richTextOf(yt)).toBeUndefined();
  });

  it("Umformatieren behält gleichzeitiges Tippen eines anderen im Bereich", () => {
    const a = new Y.Doc(), b = new Y.Doc();
    const ta = a.getMap<Y.Text>(TEXTS).set("x", new Y.Text());
    writeRuns(ta, "hello world");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const tb = b.getMap<Y.Text>(TEXTS).get("x")!;
    writeRuns(ta, [{ t: "hello", m: { b: true } }, { t: " world" }] as never);
    tb.insert(2, "XX");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(richTextOf(ta)).toEqual(richTextOf(tb));
    expect(plainText(richTextOf(ta))).toBe("heXXllo world");
  });
});

// MARK: Server + Geräte

interface Node { store: WorkspaceStore; doc: Y.Doc; session?: TextSession; name: string }

function cluster(seed: WireRecord[]) {
  let t = 1000;
  const mk = (name: string): Node => ({
    name,
    store: new WorkspaceStore({ persistence: new MemoryPersistence(structuredClone(seed)), node: name, now: () => (t += 0.001) }),
    doc: new Y.Doc(),
  });
  const server = mk("server"), a = mk("devA"), b = mk("devB");
  const devices = [a, b];
  let paused = false;
  const queue: (() => void)[] = [];
  const later = (fn: () => void) => (paused ? queue.push(fn) : fn());
  // Yjs: jeder an jeden
  for (const n of [server, a, b]) {
    n.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === "relay") return;
      for (const m of [server, a, b]) if (m !== n) later(() => Y.applyUpdate(m.doc, u, "relay"));
    });
  }
  const participants = new Set<string>();
  server.session = new TextSession(server.store, "P", { doc: server.doc, role: "server", debounceMs: 0, participants: () => participants });
  // Erst die Sitzungen (sie schreiben ins Y.Doc, bevor ein Record weitergeht – wie der Sync-Client, der später pusht),
  // dann die Record-Weitergabe.
  for (const d of devices) {
    d.session = new TextSession(d.store, "P", { doc: d.doc, role: "device" });
    participants.add(d.name);
  }
  // Records: Geräte pushen lokale Änderungen (nicht „derived“), der Server verteilt seine an alle.
  const records = (s: WorkspaceStore, keys: RecordKeyString[]) => keys.map((k) => s.record(k)).filter((r): r is WireRecord => r !== undefined);
  const gone = (s: WorkspaceStore, keys: RecordKeyString[]) => keys.filter((k) => s.record(k) === undefined);
  for (const d of devices) {
    d.store.observe((ch) => {
      if (ch.origin !== "local" && ch.origin !== "undo" && ch.origin !== "redo") return;
      const recs = records(d.store, ch.keys), del = gone(d.store, ch.keys);
      later(() => server.store.applyRemote(recs, del));
    });
  }
  // Was ein Gerät pushte, geht an die anderen (wie der Sync-Server), Änderungen des Servers an alle.
  server.store.observe((ch) => {
    const recs = records(server.store, ch.keys), del = gone(server.store, ch.keys);
    for (const d of devices) later(() => d.store.applyRemote(recs, del));
  });
  return {
    server, a, b,
    pause: () => { paused = true; },
    resume: () => {
      paused = false;
      while (queue.length) queue.shift()!();
    },
    text: (n: Node, id: string) => plainText(n.store.blocks.get(id)?.text),
    rich: (n: Node, id: string) => n.store.blocks.get(id)?.text,
  };
}

const page = () => [
  blk("P", "page", "w", "a0", { text: "Page" }),
  blk("h", "heading1", "b:P", "a0", { text: "Title" }),
  blk("a", "text", "b:P", "a1", { text: [{ t: "Hello " }, { t: "world", m: { b: true } }] as never }),
  blk("L", "columnList", "b:P", "a2"), blk("c1", "column", "b:L", "a0"), blk("x", "todo", "b:c1", "a0", { text: "in column" }),
  blk("S", "page", "b:P", "a3", { text: "Sub" }), blk("s1", "text", "b:S", "a0", { text: "other page" }),
];

describe("Echtzeit-Text: Server und zwei Geräte", () => {
  it("Server füllt alle Textblöcke der Seite (auch in Spalten), keine aus Unterseiten; Geräte übernehmen", () => {
    const c = cluster(page());
    expect([...c.server.doc.getMap(TEXTS).keys()].sort()).toEqual(["a", "h", "x"]);
    expect([...c.a.doc.getMap(TEXTS).keys()].sort()).toEqual(["a", "h", "x"]);
    expect(c.rich(c.a, "a")).toEqual([{ t: "Hello " }, { t: "world", m: { b: true } }]);
  });

  it("Tippen auf A erscheint auf B und auf dem Server; nichts doppelt", () => {
    const c = cluster(page());
    cmd.replaceText(c.a.store, { blockId: "a", from: 11, to: 11 }, "!");
    expect(c.text(c.server, "a")).toBe("Hello world!");
    expect(c.text(c.b, "a")).toBe("Hello world!");
    expect(c.rich(c.b, "a")).toEqual([{ t: "Hello " }, { t: "world!", m: { b: true } }]);
  });

  it("gleichzeitiges Tippen im selben Block: beide Änderungen bleiben, alle gleich", () => {
    const c = cluster(page());
    c.pause();
    cmd.replaceText(c.a.store, { blockId: "a", from: 0, to: 0 }, "A: ");
    cmd.replaceText(c.b.store, { blockId: "a", from: 11, to: 11 }, " (B)");
    cmd.formatText(c.b.store, [{ blockId: "a", from: 0, to: 5 }], "i");
    c.resume();
    const want = c.text(c.server, "a");
    expect(want).toBe("A: Hello world (B)");
    for (const n of [c.a, c.b]) expect(c.rich(n, "a")).toEqual(c.rich(c.server, "a"));
  });

  it("Änderung von außen (Swift, kein Teilnehmer) geht ins Y.Doc und zu den Geräten", () => {
    const c = cluster(page());
    const cur = c.server.store.blocks.get("h")!;
    c.server.store.applyRemote([{ kind: "block", data: { ...cur, text: "From Swift", stamp: { millis: 9e12, counter: 0, node: "swift" } } }]);
    expect(c.server.doc.getMap<Y.Text>(TEXTS).get("h")!.toString()).toBe("From Swift");
    expect(c.text(c.a, "h")).toBe("From Swift");
    expect(c.text(c.b, "h")).toBe("From Swift");
  });

  it("Agent/MCP auf dem Server schreibt Records → alle Geräte", () => {
    const c = cluster(page());
    cmd.replaceText(c.server.store, { blockId: "x", from: 0, to: 2 }, "IN", { coalesce: null });
    expect(c.text(c.a, "x")).toBe("IN column");
    expect(c.text(c.b, "x")).toBe("IN column");
  });

  it("neuer Block (Enter): Server legt sein Y.Text an; was davor getippt wurde, geht hinein", () => {
    const c = cluster(page());
    const f = cmd.splitBlock(c.a.store, "a", 5) as { blockId: string };
    expect(c.text(c.a, "a")).toBe("Hello");
    expect(c.server.doc.getMap(TEXTS).has(f.blockId)).toBe(true);
    expect(c.text(c.b, f.blockId)).toBe(" world");
    // Neuer Block, dessen Y.Text erst später ankommt
    c.pause();
    const g = cmd.splitBlock(c.a.store, f.blockId, 6) as { blockId: string };
    cmd.replaceText(c.a.store, { blockId: g.blockId, from: 0, to: 0 }, "typed early");
    c.resume();
    return Promise.resolve().then(() => {
      expect(c.text(c.server, g.blockId)).toBe("typed early");
      expect(c.text(c.b, g.blockId)).toBe("typed early");
      expect(c.text(c.a, g.blockId)).toBe("typed early");
    });
  });

  it("gelöschter Block verliert sein Y.Text; Undo auf A bringt Text und Y zurück", () => {
    const c = cluster(page());
    cmd.replaceText(c.a.store, { blockId: "h", from: 5, to: 5 }, " 2");
    c.a.store.undo();
    expect(c.text(c.b, "h")).toBe("Title");
    cmd.deleteBlocks(c.a.store, ["x"]);
    expect(c.server.doc.getMap(TEXTS).has("x")).toBe(false);
  });

  it("Zufall: abwechselnd getrennt tippen, löschen, formatieren – am Ende überall derselbe Text", async () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    const c = cluster(page());
    for (let round = 0; round < 40; round++) {
      c.pause();
      for (const n of [c.a, c.b]) {
        for (let k = 0; k < 3; k++) {
          const id = ["a", "h", "x"][rnd(3)]!;
          const len = c.text(n, id).length;
          const at = rnd(len + 1);
          const op = rnd(3);
          if (op === 0) cmd.replaceText(n.store, { blockId: id, from: at, to: at }, "xyz".slice(0, 1 + rnd(3)));
          else if (op === 1 && len > 0) cmd.replaceText(n.store, { blockId: id, from: at, to: Math.min(len, at + 1 + rnd(3)) }, "");
          else if (len > 1) cmd.formatText(n.store, [{ blockId: id, from: Math.min(at, len - 1), to: len }], "b");
        }
      }
      c.resume();
      await Promise.resolve();
    }
    for (const id of ["a", "h", "x"]) {
      expect(c.rich(c.a, id)).toEqual(c.rich(c.server, id));
      expect(c.rich(c.b, id)).toEqual(c.rich(c.server, id));
      expect(richTextOf(c.server.doc.getMap<Y.Text>(TEXTS).get(id)!)).toEqual(c.rich(c.server, id));
    }
  });
});
