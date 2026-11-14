// BSD-407 Teil 5: Meeting im Block-Editor. „/meet“ legt dieselben Records an wie der alte Editor (Meeting, Abschnitte
// notes/summary) plus eine leere erste Notiz, in einem Undo-Schritt. Notizen, Zusammenfassung und Transkript gehören
// nicht zum Seitenfluss: Pfeile und ⌫ gehen nicht hinein oder heraus.
import { describe, expect, it } from "vitest";
import {
  blockCommands as cmd, findMeetingSection, insertMeetingAfter, meetingInfo, MemoryPersistence, plainText, WorkspaceStore, type Block, type WireRecord,
} from "../src/index.js";

const STAMP = { millis: 1, counter: 0, node: "x" };
const blk = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, stamp: STAMP, ...extra } as Block,
});
const store = (...records: WireRecord[]) => new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" });
const kids = (s: WorkspaceStore, id: string) => s.children("b:" + id).filter((c) => s.blocks.get(c)?.trashedAt === undefined);

describe("insertMeetingAfter", () => {
  it("legt hinter einem vollen Block ein Meeting mit Abschnitten und leerer erster Notiz an – ein Undo-Schritt", () => {
    const s = store(blk("P", "page", "w", "a0", { text: "Page" }), blk("A", "text", "b:P", "a0", { text: "Before" }), blk("B", "text", "b:P", "a1", { text: "After" }));
    const r = insertMeetingAfter(s, "A")!;
    expect(kids(s, "P")).toEqual(["A", r.meetingID, "B"]);
    const m = s.blocks.get(r.meetingID)!;
    expect(m.type).toBe("meeting");
    expect(meetingInfo(s, r.meetingID)).toEqual({ status: "ready" });
    expect(plainText(m.text)).toMatch(/^Meeting notes — /);
    const notes = findMeetingSection(s, r.meetingID, "notes")!;
    expect(findMeetingSection(s, r.meetingID, "summary")).toBeDefined();
    expect(kids(s, r.meetingID).map((c) => s.blocks.get(c)!.props?.meetingSection)).toEqual(["notes", "summary"]);
    expect(kids(s, notes)).toEqual([r.noteID]);
    expect(s.blocks.get(r.noteID)!.type).toBe("text");
    s.undo();
    expect(s.blocks.get(r.meetingID)?.trashedAt ?? (s.blocks.has(r.meetingID) ? "live" : undefined)).not.toBe("live");
    expect(kids(s, "P")).toEqual(["A", "B"]);
  });

  it("ersetzt einen leeren Block an seiner Stelle", () => {
    const s = store(blk("P", "page", "w", "a0", { text: "Page" }), blk("A", "text", "b:P", "a0", { text: "Before" }), blk("E", "text", "b:P", "a1"), blk("B", "text", "b:P", "a2", { text: "After" }));
    const r = insertMeetingAfter(s, "E", { replace: true })!;
    expect(kids(s, "P")).toEqual(["A", r.meetingID, "B"]);
    expect(s.blocks.get("E")?.trashedAt ?? (s.blocks.has("E") ? "live" : "gone")).not.toBe("live");
  });
});

describe("Meeting im Seitenfluss", () => {
  const seed = () => store(
    blk("P", "page", "w", "a0", { text: "Page" }),
    blk("A", "text", "b:P", "a0", { text: "Above" }),
    blk("M", "meeting", "b:P", "a1", { text: "Sync", props: { meeting: { status: "ready" } } }),
    blk("N", "meetingSection", "b:M", "a0", { props: { meetingSection: "notes" } }),
    blk("N1", "text", "b:N", "a0", { text: "First note" }),
    blk("N2", "text", "b:N", "a1", { text: "Second note" }),
    blk("S", "meetingSection", "b:M", "a1", { props: { meetingSection: "summary" } }),
    blk("S1", "text", "b:S", "a0", { text: "Summary line" }),
    blk("T", "transcript", "b:M", "a2", { props: { segments: [] } }),
    blk("Z", "text", "b:P", "a2"),
  );

  it("Seitenreihenfolge und Nachbarn gehen am Meeting vorbei, nicht hinein", () => {
    const s = seed();
    expect(cmd.visibleOrder(s, "P")).toEqual(["A", "M", "Z"]);
    expect(cmd.nextVisible(s, "A")).toBe("M");
    expect(cmd.previousVisible(s, "Z")).toBe("M");
  });

  it("in den Notizen bleiben Pfeile im Abschnitt", () => {
    const s = seed();
    expect(cmd.nextVisible(s, "N1")).toBe("N2");
    expect(cmd.nextVisible(s, "N2")).toBeUndefined();
    expect(cmd.previousVisible(s, "N1")).toBeUndefined();
  });

  it("⌫ in der leeren Zeile unter dem Meeting zieht nichts in die Notizen, sondern wählt das Meeting", () => {
    const s = seed();
    const f = cmd.deleteBackward(s, { blockId: "Z", from: 0, to: 0 });
    expect(f).toEqual({ blockId: "M", selected: true });
    expect(plainText(s.blocks.get("S1")!.text)).toBe("Summary line");
    expect(kids(s, "S")).toEqual(["S1"]);
  });

  it("Enter am Ende der letzten Notiz legt die neue Notiz im Abschnitt an", () => {
    const s = seed();
    const f = cmd.splitBlock(s, "N2", 11);
    expect(f && "blockId" in f ? s.blocks.get(f.blockId)!.parent : undefined).toBe("b:N");
    expect(kids(s, "N")).toHaveLength(3);
  });
});
