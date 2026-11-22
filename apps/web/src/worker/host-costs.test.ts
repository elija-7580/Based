// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// Laufzeit-Analyse 20.11.2026, Store-Worker: Datenbankzeilen bauen die Seitenleiste nicht neu, und im Leerlauf läuft
// kein Takt (Versionsverlauf nur, solange Seiten auf eine Version warten).
import { createDatabase, createPage, type Block, type WireRecord } from "@based/core";
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreHost } from "./host.js";
import type { Event, RequestMessage } from "./protocol.js";

let hosts: StoreHost[] = [];
afterEach(() => {
  hosts.forEach((h) => h.stop());
  hosts = [];
  vi.useRealTimers();
});

async function setup() {
  const events: Event[] = [];
  const db = openNodeDatabase(":memory:");
  const host = new StoreHost({
    post: (e) => events.push(e),
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => fn(),
    migrateDelayMs: 1e9,
  });
  hosts.push(host);
  let seq = 1;
  const call = async (m: Omit<RequestMessage, "id">) => {
    await host.handle({ ...m, id: seq++ } as RequestMessage);
    const r = [...events].reverse().find((e) => e.type === "reply") as { ok: boolean; result?: unknown; error?: string } | undefined;
    if (r && !r.ok) throw new Error(r.error);
    return r?.result;
  };
  await call({ type: "init" } as never);
  return { host, events, call, store: host.ws!.store };
}

const outlines = (events: Event[]) => events.filter((e) => e.type === "outline").length;

describe("Store-Worker: Kosten je Änderung", () => {
  it("neue, verschobene und umbenannte Zeilen schicken keine neue Gliederung; Papierkorb schon; Titel stimmen", async () => {
    const { events, call, store } = await setup();
    const made = createDatabase(store, { parent: "w", title: "Tasks", sampleRows: 0 });
    await call({ type: "openPage", pageID: made.blockID } as never);
    const before = outlines(events);
    const stampNow = () => store.clock.now();
    const row: Block = { id: "ROW1", type: "page", parent: "d:" + made.databaseID, sk: "a0", text: "First", createdAt: store.now(), updatedAt: store.now(), stamp: stampNow() } as Block;
    const apply = (b: Block) => call({ type: "applyLocal", pageID: made.blockID, upserts: [{ kind: "block", data: b } as WireRecord], deletions: [] } as never);
    await apply(row);
    await apply({ ...row, sk: "b0", stamp: stampNow() });
    await apply({ ...row, sk: "b0", text: "Renamed", props: { icon: "🙂" }, stamp: stampNow() });
    expect(outlines(events)).toBe(before);
    const titles = events.filter((e): e is Extract<Event, { type: "titles" }> => e.type === "titles");
    expect(titles.at(-1)?.titles).toEqual({ ROW1: "Renamed" });
    // Papierkorb: die Zeile steht in der Liste des Papierkorbs – das ist Struktur
    await apply({ ...row, sk: "b0", text: "Renamed", trashedAt: store.now(), stamp: stampNow() });
    expect(outlines(events)).toBe(before + 1);
    const outline = [...events].reverse().find((e): e is Extract<Event, { type: "outline" }> => e.type === "outline")!.outline;
    expect(outline.trash.map((t) => t.id)).toContain("ROW1");
    // endgültig gelöscht: Titel weg, Papierkorb leer
    await call({ type: "applyLocal", pageID: made.blockID, upserts: [], deletions: ["block:ROW1"] } as never);
    expect(outlines(events)).toBe(before + 2);
    expect(events.filter((e): e is Extract<Event, { type: "titles" }> => e.type === "titles").at(-1)?.titles).toEqual({ ROW1: "" });
  });

  it("eine Zeile ohne Papierkorb-Umweg löschen nimmt ihren Titel aus der Tabelle", async () => {
    const { events, call, store } = await setup();
    const made = createDatabase(store, { parent: "w", title: "Tasks", sampleRows: 0 });
    const row: Block = { id: "ROW2", type: "page", parent: "d:" + made.databaseID, sk: "a0", text: "Two", createdAt: store.now(), updatedAt: store.now(), stamp: store.clock.now() } as Block;
    await call({ type: "applyLocal", pageID: made.blockID, upserts: [{ kind: "block", data: row } as WireRecord], deletions: [] } as never);
    const before = outlines(events);
    await call({ type: "applyLocal", pageID: made.blockID, upserts: [], deletions: ["block:ROW2"] } as never);
    expect(outlines(events)).toBe(before);
    expect(events.filter((e): e is Extract<Event, { type: "titles" }> => e.type === "titles").at(-1)?.titles).toEqual({ ROW2: "" });
  });

  it("eine Inline-Datenbank in den Papierkorb legen nimmt sie aus der Seitenleiste (vorher erst bei der nächsten Strukturänderung)", async () => {
    const { host, events, store } = await setup();
    const page = createPage(store, { title: "Host page" });
    const made = createDatabase(store, { parent: "b:" + page, title: "Inline", inline: true, sampleRows: 0 });
    host.flush();
    const last = () => [...events].reverse().find((e): e is Extract<Event, { type: "outline" }> => e.type === "outline")!.outline;
    expect(last().children[page]).toEqual([made.blockID]);
    store.deleteBlocks([made.blockID]);
    host.flush();
    expect(last().children[page] ?? []).toEqual([]);
    expect(last().trash.map((t) => t.id)).toEqual([made.blockID]);
  });

  it("Versionsverlauf: kein Takt im Leerlauf, einer solange eine Seite auf ihre Version wartet", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { host, call, store } = await setup();
    const timer = () => (host as unknown as { historyTimer: unknown }).historyTimer;
    expect(timer()).toBeUndefined();
    const page = await call({ type: "command", command: { op: "createPage", title: "Notes" } } as never) as string;
    expect(timer()).toBeDefined();
    // nach einer Minute Pause entsteht die Version; danach wartet nichts mehr, der Takt endet
    vi.advanceTimersByTime(90_000);
    expect(host.history!.list(page).versions.length).toBeGreaterThan(0);
    expect(timer()).toBeUndefined();
    expect(store.blocks.has(page)).toBe(true);
  });
});
