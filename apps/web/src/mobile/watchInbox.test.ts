// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { describe, expect, it } from "vitest";
import { drainWatchInbox, isWatchInboxItem, type WatchInboxBridge, type WatchInboxItem, type WatchInboxTarget } from "./watchInbox.js";

function world(items: WatchInboxItem[], content: Record<string, string> = {}) {
  const inbox = new Map(items.map((i) => [i.id, i]));
  const log: string[] = [];
  let ledger: string[] = [];
  let n = 0;
  const bridge: WatchInboxBridge = {
    pending: async () => [...inbox.values()],
    read: async (id) => new TextEncoder().encode(content[id] ?? "audio"),
    done: async (id) => { inbox.delete(id); log.push(`done ${id}`); },
  };
  const target: WatchInboxTarget = {
    createCapture: async (at, text) => { const id = `p${++n}`; log.push(`page ${id} ${at}${text === undefined ? "" : ` "${text}"`}`); return id; },
    importAudio: async (page, f) => { log.push(`audio ${page} ${f.name} ${f.mime} ${f.duration}s ${f.data.size}b`); return true; },
    ledger: { get: () => ledger, set: (ids) => { ledger = ids; } },
    discard: async (page) => { log.push(`discard ${page}`); },
  };
  return { bridge, target, log, inbox, ledger: () => ledger, setLedger: (l: string[]) => { ledger = l; } };
}

const voice = (id: string, at: number, dur = 4.5): WatchInboxItem => ({ id, at, dur, ext: "m4a" });

describe("Eingang der Apple Watch (apps/mobile → Workspace)", () => {
  it("Sprachnotiz: Seite mit der Zeit der Uhr, Aufnahme als Spur, dann aus dem Eingang – älteste zuerst", async () => {
    const w = world([voice("BBBBBBBB-2", 200), voice("AAAAAAAA-1", 100)]);
    expect(await drainWatchInbox(w.bridge, w.target)).toEqual(["p1", "p2"]);
    expect(w.log).toEqual([
      "page p1 100000", "audio p1 voice-note-AAAAAAAA.m4a audio/mp4 4.5s 5b", "done AAAAAAAA-1",
      "page p2 200000", "audio p2 voice-note-BBBBBBBB.m4a audio/mp4 4.5s 5b", "done BBBBBBBB-2",
    ]);
    expect(w.inbox.size).toBe(0);
    expect(w.ledger()).toEqual(["AAAAAAAA-1", "BBBBBBBB-2"]);
  });

  it("Diktat: Seite mit dem Text; leerer Text wird verworfen", async () => {
    const w = world([{ id: "t1", at: 10, dur: 0, ext: "txt" }, { id: "t2", at: 20, dur: 0, ext: "txt" }], { t1: " Call the roofer \n", t2: "  " });
    expect(await drainWatchInbox(w.bridge, w.target)).toEqual(["p1"]);
    expect(w.log).toEqual(['page p1 10000 "Call the roofer"', "done t1", "done t2"]);
  });

  it("schon erledigte Kennung (Abbruch zwischen Seite und Löschen): keine zweite Seite", async () => {
    const w = world([voice("a", 1)]);
    w.setLedger(["a"]);
    expect(await drainWatchInbox(w.bridge, w.target)).toEqual([]);
    expect(w.log).toEqual(["done a"]);
  });

  it("Aufnahme lässt sich nicht speichern: Seite weg, Eintrag bleibt im Eingang; die übrigen laufen weiter", async () => {
    const w = world([voice("a", 1), voice("b", 2)]);
    const save = w.target.importAudio!;
    w.target.importAudio = async (page, f) => (page === "p1" ? false : save(page, f));
    expect(await drainWatchInbox(w.bridge, w.target)).toEqual(["p2"]);
    expect(w.log.slice(0, 2)).toEqual(["page p1 1000", "discard p1"]);
    expect([...w.inbox.keys()]).toEqual(["a"]);
    expect(w.ledger()).toEqual(["b"]);
  });

  it("ohne Meeting-Dienst bleiben Sprachnotizen liegen, Diktate kommen an; Fehler beim Lesen kosten nichts", async () => {
    const w = world([voice("a", 1), { id: "t", at: 2, dur: 0, ext: "txt" }], { t: "Idea" });
    w.target.importAudio = undefined;
    expect(await drainWatchInbox(w.bridge, w.target)).toEqual(["p1"]);
    expect([...w.inbox.keys()]).toEqual(["a"]);

    const broken = world([voice("x", 1)]);
    broken.bridge.read = async () => { throw new Error("gone"); };
    expect(await drainWatchInbox(broken.bridge, broken.target)).toEqual([]);
    expect([...broken.inbox.keys()]).toEqual(["x"]);
    expect(broken.log).toEqual([]);
  });

  it("nimmt nur wohlgeformte Einträge", () => {
    expect(isWatchInboxItem({ id: "a", at: 1, dur: 0, ext: "m4a" })).toBe(true);
    for (const bad of [null, {}, { id: "", at: 1, dur: 0, ext: "m4a" }, { id: "a", at: "1", dur: 0, ext: "m4a" }, { id: "a", at: NaN, dur: 0, ext: "m4a" }]) {
      expect(isWatchInboxItem(bad)).toBe(false);
    }
  });
});
