// Mehrere Tabs: Wahl des Store-Tabs (Web Lock), Weiterleiten über einen BroadcastChannel, Übernahme ohne
// Datenverlust. Lock, Kanal und Worker sind simuliert; der Store ist echt (StoreHost auf node:sqlite in einer Datei,
// die nach der Übernahme der neue Store-Tab öffnet – wie die OPFS-Datei im Browser).
import { sectionKey } from "@based/core";
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreClient } from "./client.js";
import { StoreHost } from "./host.js";
import { Relay, StoreLink, type ChannelLike, type LockManagerLike, type StartedStore } from "./leader.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

type Fn<T> = (e: { data: T }) => void;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};

/** Web Locks: exklusiv, Warteschlange in Anfragereihenfolge, frei, wenn der Callback endet. */
class FakeLocks implements LockManagerLike {
  private held = new Set<string>();
  private waiting = new Map<string, (() => void)[]>();
  request(name: string, cb: (lock: unknown) => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.held.add(name);
        Promise.resolve()
          .then(() => cb({ name }))
          .then(resolve, reject)
          .finally(() => {
            this.held.delete(name);
            const next = this.waiting.get(name)?.shift();
            if (next) setTimeout(next);
          });
      };
      if (!this.held.has(name)) run();
      else this.waiting.set(name, [...(this.waiting.get(name) ?? []), run]);
    });
  }
}

/** BroadcastChannel: an alle anderen offenen Kanäle, geklont, als eigener Task. */
class FakeBus {
  private channels = new Set<{ fns: Set<Fn<unknown>>; open: boolean }>();
  /** Nachrichten mitzählen (für Prüfungen). */
  sent: unknown[] = [];
  channel = (): ChannelLike => {
    const me = { fns: new Set<Fn<unknown>>(), open: true };
    this.channels.add(me);
    return {
      postMessage: (m) => {
        this.sent.push(m);
        const copy = structuredClone(m);
        for (const c of this.channels) if (c !== me && c.open) setTimeout(() => c.open && c.fns.forEach((f) => f({ data: copy })));
      },
      addEventListener: (_t, f) => me.fns.add(f),
      removeEventListener: (_t, f) => me.fns.delete(f),
      close: () => {
        me.open = false;
        this.channels.delete(me);
      },
    };
  };
}

let dir: string;
let links: StoreLink[] = [];
let started = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "based-tabs-"));
  started = 0;
});
afterEach(() => {
  links.forEach((l) => l.close());
  links = [];
  rmSync(dir, { recursive: true, force: true });
});

/** „Worker“: StoreHost auf der gemeinsamen Datei, Nachrichten geklont und asynchron. */
function startStore(): StartedStore {
  started += 1;
  const toHost = new Set<Fn<RequestMessage>>();
  const toClient = new Set<Fn<Event>>();
  let alive = true;
  const db = openNodeDatabase(join(dir, "based.sqlite"));
  const host = new StoreHost({
    post: (e) => {
      const copy = structuredClone(e);
      setTimeout(() => alive && toClient.forEach((f) => f({ data: copy })));
    },
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
  });
  let queue = Promise.resolve();
  toHost.add((e) => {
    queue = queue.then(() => (alive ? host.handle(e.data) : undefined));
  });
  const endpoint: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => alive && toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  return {
    endpoint,
    terminate: () => {
      alive = false;
      host.stop();
      db.close();
    },
  };
}

function tab(env: { locks?: LockManagerLike; bus?: FakeBus }, name: string) {
  const link = new StoreLink({
    id: name,
    locks: env.locks,
    channel: env.bus?.channel,
    startStore,
    initParams: async () => ({ opfs: "based.sqlite" }),
  });
  links.push(link);
  const client = new StoreClient(link);
  link.onReconnect = () => void client.resync();
  return { link, client };
}

const pagesIn = (c: StoreClient) => c.getState().outline?.children[sectionKey("private")] ?? [];

describe("Mehrere Tabs: ein Store-Tab, die anderen verbunden", () => {
  it("der erste Tab hält den Store, der zweite redet mit ihm; Änderungen sehen beide sofort", async () => {
    const env = { locks: new FakeLocks(), bus: new FakeBus() };
    const a = tab(env, "A");
    const ra = await a.client.init({});
    expect(ra.created).toBe(true);
    const b = tab(env, "B");
    const rb = await b.client.init({});
    expect(rb.created).toBe(false);
    expect(a.link.role).toBe("leader");
    expect(b.link.role).toBe("follower");
    expect(started).toBe(1);
    // B bekommt beim Verbinden den Stand
    expect(b.client.title(ra.homePageID!)).toBe("Welcome to Based");
    expect(b.client.getState().status.state).toBe("local");

    const id = await b.client.command<string>({ op: "createPage", title: "From B" });
    await settle();
    expect(pagesIn(a.client)).toContain(id);
    expect(a.client.title(id)).toBe("From B");

    // dieselbe Seite in beiden Tabs offen: Bearbeiten in A kommt in B an und umgekehrt
    const pa = await a.client.openPage(ra.homePageID!);
    const pb = await b.client.openPage(ra.homePageID!);
    const first = pa.store.children("b:" + ra.homePageID)[0]!;
    pa.store.setText(first, "Typed in A");
    await settle();
    expect(pb.store.blocks.get(first)?.text).toBe("Typed in A");
    pb.store.setText(first, "Typed in B");
    await settle();
    expect(pa.store.blocks.get(first)?.text).toBe("Typed in B");

    // A schließt die Seite, B hat sie noch offen: B bekommt weiter Änderungen
    pa.close();
    await settle();
    await a.client.command({ op: "rename", id: ra.homePageID!, title: "Renamed in A" });
    await settle();
    expect(pb.store.blocks.get(ra.homePageID!)?.text).toBe("Renamed in A");
  });

  it("schließt der Store-Tab, übernimmt ein anderer ohne Datenverlust", async () => {
    const env = { locks: new FakeLocks(), bus: new FakeBus() };
    const a = tab(env, "A");
    const { homePageID } = await a.client.init({});
    const b = tab(env, "B");
    await b.client.init({});
    const c = tab(env, "C");
    await c.client.init({});
    const pb = await b.client.openPage(homePageID!);
    const first = pb.store.children("b:" + homePageID)[0]!;

    // A geht; B tippt genau in der Lücke, bevor ein neuer Store-Tab da ist
    a.link.close();
    pb.store.setText(first, "Typed during takeover");
    const created = b.client.command<string>({ op: "createPage", title: "Created during takeover" });
    await settle(40);
    expect(b.link.role).toBe("leader");
    expect(c.link.role).toBe("follower");
    expect(started).toBe(2);
    const id = await created;
    await settle();
    expect(pagesIn(c.client)).toContain(id);
    expect(c.client.title(id)).toBe("Created during takeover");

    // die Replik in B hängt am neuen Host: Änderungen von C kommen an
    const pc = await c.client.openPage(homePageID!);
    expect(pc.store.blocks.get(first)?.text).toBe("Typed during takeover");
    pc.store.setText(first, "From C after takeover");
    await settle();
    expect(pb.store.blocks.get(first)?.text).toBe("From C after takeover");

    // alles liegt in der Datei: auch B schließt, C übernimmt und öffnet sie neu
    b.link.close();
    await settle(40);
    expect(c.link.role).toBe("leader");
    expect(started).toBe(3);
    await c.client.command({ op: "rename", id, title: "Still saved" });
    c.link.close();
    await settle();
    const d = tab(env, "D");
    await d.client.init({});
    await settle();
    expect(d.client.title(id)).toBe("Still saved");
    const pd = await d.client.openPage(homePageID!);
    expect(pd.store.blocks.get(first)?.text).toBe("From C after takeover");
  });

  it("ohne Web Locks/BroadcastChannel: jeder Tab ist sein eigener Store-Tab", async () => {
    const a = tab({}, "A");
    const r = await a.client.init({});
    expect(r.created).toBe(true);
    expect(a.link.role).toBe("leader");
  });

  it("Relay: Anfrage-IDs verschiedener Tabs kommen sich nicht in die Quere", async () => {
    const s = startStore();
    const out: [string | undefined, Event][] = [];
    const relay = new Relay(s.endpoint, (c, ev) => out.push([c, ev]));
    await relay.start({});
    await relay.handle("local", { id: 1, type: "command", command: { op: "createPage", title: "L" } });
    await relay.handle("other", { id: 1, type: "command", command: { op: "createPage", title: "O" } });
    await settle();
    const replies = out.filter(([, e]) => e.type === "reply");
    expect(replies.map(([c, e]) => [c, (e as { id: number }).id]).sort()).toEqual([["local", 1], ["other", 1]]);
    // Struktur geht an alle
    expect(out.some(([c, e]) => c === undefined && e.type === "outline")).toBe(true);
    relay.dispose();
    s.terminate();
  });
});
