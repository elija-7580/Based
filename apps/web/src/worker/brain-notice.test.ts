// BSD-163: verweigertes Löschen des Agent Brain bleibt nicht still – der Worker schickt einen Hinweis, die Seiten
// bleiben, alles andere aus derselben Auswahl geht wie gewohnt in den Papierkorb.
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refusedDeleteNotice, type BrainStatus } from "./brain.js";
import { StoreClient } from "./client.js";
import { StoreHost } from "./host.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

let hosts: StoreHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.forEach((h) => h.stop());
  hosts = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "based-brain-notice-"));
  dirs.push(dir);
  const toHost = new Set<(e: { data: RequestMessage }) => void>();
  const toClient = new Set<(e: { data: Event }) => void>();
  const end: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const db = openNodeDatabase(join(dir, "w.sqlite"));
  const host = new StoreHost({
    post: (e) => { const c = structuredClone(e); setTimeout(() => toClient.forEach((f) => f({ data: c }))); },
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
  });
  hosts.push(host);
  let q = Promise.resolve();
  toHost.add((e) => { q = q.then(() => host.handle(e.data)); });
  return new StoreClient(end);
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("Hinweis beim verweigerten Löschen (BSD-163)", () => {
  it("Text: eine Seite mit Titel, mehrere als Anzahl, Papierkorb bzw. endgültig", () => {
    expect(refusedDeleteNotice([])).toBeUndefined();
    expect(refusedDeleteNotice(["Agent Brain"])).toBe("“Agent Brain” stays: the Agent Brain (About me, Memories, Skills) can't be moved to the Trash. Its pages keep what your agents know.");
    expect(refusedDeleteNotice(["", "Skills"], true)).toMatch(/^2 pages stay: .* can't be deleted\./);
    expect(refusedDeleteNotice([""])).toMatch(/^“Untitled” stays/);
  });

  it("Papierkorb: Brain bleibt mit Hinweis, die andere Seite geht; ohne Brain kein Hinweis", async () => {
    const client = setup();
    await client.init({});
    const other = await client.command<string>({ op: "createPage", title: "Notes" });
    await client.command({ op: "trash", ids: [other] });
    await settle();
    expect(client.getState().notice).toBeUndefined();
    await client.command({ op: "restore", ids: [other] });

    await client.request({ type: "brain", action: { op: "ensure" } });
    const st = await client.request<BrainStatus>({ type: "brain", action: { op: "status" } });
    expect(st.rootID).toBeTruthy();
    const trashed = await client.command<string[]>({ op: "trash", ids: [st.rootID!, other] });
    await settle();
    expect(trashed).toEqual([other]);
    expect(client.getState().notice?.message).toMatch(/^“Agent Brain” stays: .*moved to the Trash/);
    expect(client.getState().outline?.trash.map((t) => t.id)).toEqual([other]);

    client.dismissNotice();
    expect(client.getState().notice).toBeUndefined();
    await client.command({ op: "deleteForever", ids: [st.rootID!] });
    await settle();
    expect(client.getState().notice?.message).toMatch(/can't be deleted\./);
  });
});
