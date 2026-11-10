// BSD-195/196/160: Aufträge über die Worker-Schnittstelle (Host + Client über einen Testkanal, node:sqlite) – zuerst
// gespeichert, nach Neustart fortgesetzt, Plan = ein Undo-Schritt (⌘Z), Liste folgt per `agents`-Ereignis.
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RulesPlannerEngine, TaskRunner } from "@based/brain";
import { StoreClient } from "./client.js";
import { clientTaskBackend } from "../tasks/runtime.js";
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

describe("Aufträge über den Store-Worker", () => {
  it("Auftrag zuerst gespeichert, nach Neustart fortgesetzt; Plan ist ein ⌘Z-Schritt; Liste folgt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-tasks-"));
    dirs.push(dir);
    const file = join(dir, "w.sqlite");
    const a = setup(file);
    await a.client.init({});
    await a.client.agentSnapshot();
    // ohne Modell: gespeichert, wartet
    const noModel = new TaskRunner({ backend: clientTaskBackend(a.client), engine: () => undefined, today: () => "2026-11-10" });
    const t = await noModel.submit("Write a page about tea");
    await noModel.idle();
    await settle();
    expect(a.client.getState().agents?.tasks.map((x) => [x.title, x.data.state, x.data.waiting])).toEqual([["Write a page about tea", "received", "no model set up"]]);
    a.host.stop();

    const b = setup(file);
    await b.client.init({});
    const r = new TaskRunner({ backend: clientTaskBackend(b.client), engine: () => new RulesPlannerEngine(), today: () => "2026-11-10" });
    await r.resume();
    await settle();
    const snap = b.client.getState().agents ?? (await b.client.agentSnapshot());
    expect(snap.tasks[0]!.data.state).toBe("done");
    expect([...b.client.getState().titles.values()]).toContain("Write a page about tea");
    expect(snap.runs.some((x) => x.data.kind === "main" && x.data.taskID === t.id)).toBe(true);
    expect(await b.client.command({ op: "undo" })).toBe("Main agent: Creates a page");
    await settle();
    expect([...b.client.getState().titles.values()]).not.toContain("Write a page about tea");
  });
});
