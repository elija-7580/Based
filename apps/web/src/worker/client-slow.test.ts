// BSD-418: Store-Anfragen über 1 s melden sich mit Operationsnamen (ohne Inhalte) an die Hänger-Analyse.
import { describe, expect, it, vi } from "vitest";
import { requestName, StoreClient } from "./client.js";
import type { Endpoint, Event, Request, RequestMessage } from "./protocol.js";

describe("Langsame Store-Anfragen (BSD-418)", () => {
  it("Name: Art und Operation, nie Inhalte", () => {
    expect(requestName({ type: "command", command: { op: "rename", id: "x", title: "Geheimes Tagebuch" } } as Request)).toBe("command rename");
    expect(requestName({ type: "search", query: "Geheimes Tagebuch" } as Request)).toBe("search");
    expect(requestName({ type: "history", action: { op: "list", pageID: "p" } } as Request)).toBe("history list");
  });

  it("meldet nur Anfragen ab 1 s, mit monotonen Zeiten", async () => {
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    const sent: RequestMessage[] = [];
    let listener: ((e: { data: Event }) => void) | undefined;
    const end: Endpoint<Event, RequestMessage> = {
      postMessage: (m) => void sent.push(m),
      addEventListener: (_t, fn) => void (listener = fn),
      removeEventListener: () => undefined,
    };
    const client = new StoreClient(end);
    const slow: [string, number, number][] = [];
    client.onSlowRequest = (op, t0, t1) => slow.push([op, t0, t1]);
    const a = client.command({ op: "emptyTrash" });
    const b = client.search("Geheim");
    t = 400;
    listener!({ data: { type: "reply", id: sent[1]!.id, ok: true, result: undefined } as Event });
    t = 1500;
    listener!({ data: { type: "reply", id: sent[0]!.id, ok: true, result: undefined } as Event });
    await Promise.all([a, b]);
    expect(slow).toEqual([["command emptyTrash", 0, 1500]]);
    vi.restoreAllMocks();
  });
});
