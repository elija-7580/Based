// BSD-336: Nachfrage beim Neuladen/Schließen nur, solange eine Änderung unterwegs ist.
import { describe, expect, it } from "vitest";
import { StoreClient } from "../worker/client.js";
import type { Endpoint, Event, RequestMessage } from "../worker/protocol.js";
import { installUnloadGuard } from "./unloadGuard.js";

function fakeEndpoint() {
  const sent: RequestMessage[] = [];
  let listener: ((e: { data: Event }) => void) | undefined;
  const end = {
    postMessage: (m: RequestMessage) => void sent.push(m),
    addEventListener: (_t: "message", fn: (e: { data: Event }) => void) => void (listener = fn),
    removeEventListener: () => void (listener = undefined),
  } as Endpoint<Event, RequestMessage>;
  const reply = (id: number) => listener?.({ data: { type: "reply", id, ok: true, result: null } as Event });
  return { end, sent, reply };
}

function fakeWindow() {
  let fn: ((e: BeforeUnloadEvent) => void) | undefined;
  return {
    addEventListener: (_t: "beforeunload", f: (e: BeforeUnloadEvent) => void) => void (fn = f),
    removeEventListener: () => void (fn = undefined),
    /** true = das Fenster hätte nachgefragt. */
    unload(): boolean {
      let asked = false;
      const e = { preventDefault: () => void (asked = true), returnValue: undefined as unknown } as unknown as BeforeUnloadEvent;
      fn?.(e);
      return asked;
    },
  };
}

describe("Unload-Schutz (BSD-336)", () => {
  it("fragt nur, solange eine Änderung unterwegs ist; Lesen zählt nicht", () => {
    const { end, sent, reply } = fakeEndpoint();
    const client = new StoreClient(end);
    const win = fakeWindow();
    const off = installUnloadGuard(win, () => client.unsavedWrites);
    expect(win.unload()).toBe(false);
    void client.search("x").catch(() => undefined);
    void client.command({ op: "pageAncestors", id: "p" }).catch(() => undefined);
    expect(client.unsavedWrites).toBe(0);
    expect(win.unload()).toBe(false);
    void client.command({ op: "trash", ids: ["a"] });
    expect(client.unsavedWrites).toBe(1);
    expect(win.unload()).toBe(true);
    reply(sent[sent.length - 1]!.id);
    expect(client.unsavedWrites).toBe(0);
    expect(win.unload()).toBe(false);
    void client.command({ op: "trash", ids: ["b"] });
    off();
    expect(win.unload()).toBe(false);
  });

  it("abgebrochene Verbindung zählt nicht mehr als unterwegs", () => {
    const { end } = fakeEndpoint();
    const client = new StoreClient(end);
    void client.command({ op: "trash", ids: ["a"] }).catch(() => undefined);
    client.dispose();
    expect(client.unsavedWrites).toBe(0);
  });
});
