// BSD-335: settled() wartet, bis jede abgeschickte Anfrage beantwortet ist (= im Store-Tab geschrieben). Ein Befehl
// ohne Antwort ist noch nicht gespeichert und ginge beim Neuladen mit dem Worker verloren.
import { describe, expect, it } from "vitest";
import { StoreClient } from "./client.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

function fakeEndpoint() {
  const sent: RequestMessage[] = [];
  let listener: ((e: { data: Event }) => void) | undefined;
  const end: Endpoint<Event, RequestMessage> = {
    postMessage: (m: RequestMessage) => void sent.push(m),
    addEventListener: (_t: "message", fn: (e: { data: Event }) => void) => void (listener = fn),
    removeEventListener: () => void (listener = undefined),
  } as Endpoint<Event, RequestMessage>;
  const reply = (id: number) => listener?.({ data: { type: "reply", id, ok: true, result: null } as Event });
  return { end, sent, reply };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("StoreClient.settled (BSD-335)", () => {
  it("ohne offene Anfragen sofort erfüllt", async () => {
    const { end } = fakeEndpoint();
    await expect(new StoreClient(end).settled()).resolves.toBeUndefined();
  });

  it("wartet auf die Antwort jeder vorher abgeschickten Anfrage, nicht auf spätere", async () => {
    const { end, sent, reply } = fakeEndpoint();
    const client = new StoreClient(end);
    void client.command({ op: "trash", ids: ["a"] });
    void client.command({ op: "trash", ids: ["b"] });
    let done = false;
    void client.settled().then(() => (done = true));
    void client.command({ op: "trash", ids: ["c"] }); // danach geschickt: zählt nicht
    reply(sent[1]!.id);
    await tick();
    expect(done).toBe(false); // die erste ist noch nicht geschrieben
    reply(sent[0]!.id);
    await tick();
    expect(done).toBe(true);
  });

  it("dispose bricht ab und erfüllt wartende settled()", async () => {
    const { end } = fakeEndpoint();
    const client = new StoreClient(end);
    void client.command({ op: "trash", ids: ["a"] }).catch(() => undefined);
    const s = client.settled();
    client.dispose();
    await expect(s).resolves.toBeUndefined();
  });
});
