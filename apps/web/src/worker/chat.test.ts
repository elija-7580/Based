// BSD-159/BSD-74/BSD-77: Chats und Agent-Werkzeuge über die Worker-Schnittstelle (Host + Client über einen Testkanal,
// node:sqlite): Werkzeug-Änderungen sind ein Undo-Schritt, Transkripte überleben einen Neustart, Chat-Liste folgt.
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function setup(file: string) {
  const toHost = new Set<(e: { data: RequestMessage }) => void>();
  const toClient = new Set<(e: { data: Event }) => void>();
  const end: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const db = openNodeDatabase(file);
  const host = new StoreHost({
    post: (e) => { const c = structuredClone(e); setTimeout(() => toClient.forEach((f) => f({ data: c }))); },
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
  });
  hosts.push(host);
  let q = Promise.resolve();
  toHost.add((e) => { q = q.then(() => host.handle(e.data)); });
  return { host, client: new StoreClient(end) };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("Chat über den Store-Worker", () => {
  it("Werkzeug legt Seite an (ein Undo-Schritt), Transkript und Liste überleben einen Neustart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-chat-"));
    dirs.push(dir);
    const file = join(dir, "w.sqlite");
    const a = setup(file);
    await a.client.init({});
    const catalog = await a.client.chatToolSpecs();
    expect(catalog.write).toContain("create_page");
    const chat = await a.client.chatCreate();
    const r = await a.client.chatTool("create_page", { title: "From agent", markdown: "one\n\ntwo" });
    expect(r.isError).toBe(false);
    await settle();
    expect([...a.client.getState().titles.values()]).toContain("From agent");
    await a.client.chatSave(chat.id, 0, [{ type: "userMessage", text: "make it" }, { type: "toolUse", id: "c", name: "create_page", input: { title: "From agent" } }, { type: "toolResult", id: "c", output: r.text, isError: false }, { type: "usage", inputTokens: 10, outputTokens: 5, costUSD: 0.001, estimated: true }, { type: "result", text: "", isError: false }]);
    await settle();
    expect(a.client.getState().chats?.map((c) => c.title)).toEqual(["make it"]);
    // ⌘Z (Befehl undo) nimmt die Seite samt Inhalt zurück – in einem Schritt; der Chat bleibt
    expect(await a.client.command({ op: "undo" })).toBe("Agent: new page");
    await settle();
    expect([...a.client.getState().titles.values()]).not.toContain("From agent");
    expect((await a.client.chatLoad(chat.id)).events).toHaveLength(5);
    a.host.stop();

    const b = setup(file);
    await b.client.init({});
    const list = await b.client.chatList();
    expect(list.map((c) => [c.title, c.usage.inputTokens + c.usage.outputTokens])).toEqual([["make it", 15]]);
    const loaded = await b.client.chatLoad(chat.id);
    expect(loaded.events[1]).toEqual({ type: "toolUse", id: "c", name: "create_page", input: { title: "From agent" } });
    await b.client.chatDelete(chat.id);
    await settle();
    expect(b.client.getState().chats).toEqual([]);
    expect(await b.client.chatImportLegacy()).toEqual([]);
  });
});
