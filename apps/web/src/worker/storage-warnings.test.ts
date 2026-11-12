// BSD-330: fällt eine Nebendatei (history.sqlite, ydocs.sqlite, Dateien) in den Speicher zurück, obwohl der Workspace
// dauerhaft liegt, steht das im Status und als Hinweis – nie still.
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

function setup(storageWarnings?: string[], persistent = true) {
  const dir = mkdtempSync(join(tmpdir(), "based-storage-warn-"));
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
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent, ...(storageWarnings ? { storageWarnings } : {}) }),
    defer: (fn) => setTimeout(fn, 0),
  });
  hosts.push(host);
  let q = Promise.resolve();
  toHost.add((e) => { q = q.then(() => host.handle(e.data)); });
  return new StoreClient(end);
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("Speicher-Warnungen der Nebendateien (BSD-330)", () => {
  it("Status und Hinweis nennen die Datei, die nur im Speicher liegt", async () => {
    const client = setup(["Version history is kept in memory only (history.sqlite: busy)."]);
    await client.init({});
    await settle();
    expect(client.getState().status.storageWarnings).toEqual(["Version history is kept in memory only (history.sqlite: busy)."]);
    expect(client.getState().status.persistent).toBe(true);
    expect(client.getState().notice?.message).toBe("Version history is kept in memory only (history.sqlite: busy). It is lost when you reload — see Settings → Diagnostics.");
  });

  it("ohne Warnung kein Hinweis; liegt der ganze Workspace im Speicher, sagt das schon der Status", async () => {
    const ok = setup();
    await ok.init({});
    await settle();
    expect(ok.getState().status.storageWarnings).toBeUndefined();
    expect(ok.getState().notice).toBeUndefined();
    const mem = setup(["Version history is kept in memory only (x)."], false);
    await mem.init({});
    await settle();
    expect(mem.getState().status.storageWarnings).toBeUndefined();
    expect(mem.getState().notice).toBeUndefined();
  });
});
