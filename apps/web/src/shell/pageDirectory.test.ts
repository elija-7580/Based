// BSD-322 Teil 5: Erwähnungen zeigen den Papierkorb-Zustand auch dann, wenn er sich änderte, während niemand
// zugehört hat (editor-parity.spec.ts:225 war in WebKit rot: „in Trash“ fehlte).
import { describe, expect, it } from "vitest";
import { ShellPageDirectory } from "./pageDirectory.js";
import type { StoreClient } from "../worker/client.js";
import type { PageInfo } from "../worker/protocol.js";

function fakeClient() {
  let state = { titles: new Map<string, string>([["p1", "Airship"]]), outline: { nodes: {} } as unknown };
  const listeners = new Set<() => void>();
  const pages = new Map<string, PageInfo>([["p1", { id: "p1", title: "Airship", trashed: false } as PageInfo]]);
  const client = {
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    pageInfo: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, pages.get(id) ?? null])),
  };
  return {
    client: client as unknown as StoreClient,
    trash(id: string) {
      pages.set(id, { ...pages.get(id)!, trashed: true });
      state = { ...state, outline: { nodes: {} } };
      for (const fn of [...listeners]) fn();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ShellPageDirectory", () => {
  it("frischt bekannte Seiten auf, wenn ein Zuhörer neu dazukommt und sich inzwischen etwas geändert hat", async () => {
    const fake = fakeClient();
    const dir = new ShellPageDirectory(fake.client);
    const off = dir.subscribe(() => {});
    dir.get("p1");
    await tick();
    expect(dir.get("p1")?.trashed).toBe(false);
    off(); // Seite gewechselt: niemand hört zu
    fake.trash("p1");
    await tick();
    let notified = 0;
    dir.subscribe(() => notified++);
    await tick();
    expect(dir.get("p1")?.trashed).toBe(true);
    expect(notified).toBe(1);
  });

  it("Änderung während zugehört wird: sofort neu gefragt", async () => {
    const fake = fakeClient();
    const dir = new ShellPageDirectory(fake.client);
    let notified = 0;
    dir.subscribe(() => notified++);
    dir.get("p1");
    await tick();
    fake.trash("p1");
    await tick();
    expect(dir.get("p1")?.trashed).toBe(true);
    expect(notified).toBe(2);
  });

  it("BSD-407: vorläufiger Eintrag (Worker hat noch nicht geantwortet) ist bei gleichen Werten dasselbe Objekt", () => {
    const fake = fakeClient();
    const dir = new ShellPageDirectory(fake.client);
    const a = dir.get("p1");
    expect(a?.title).toBe("Airship");
    expect(dir.get("p1")).toBe(a); // sonst zeichnet useSyncExternalStore endlos neu (React-Fehler 185)
  });
});
