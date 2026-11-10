// BSD-226: Meeting-Notizen – Portierung von Swift MeetingTests plus Roundtrip gegen den Record-Korpus.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryPersistence, TRANSCRIPT_CHUNK_SIZE, WorkspaceStore, addMeetingContext, appendTranscript, applyMeetingSummary, applySpeakerTurns, citations,
  createMeeting, createPage, encodeRecord, findMeetingSection, meetingContaining, meetingContextText, meetingInfo, meetingNotesText, meetingSection,
  meetingTranscript, meetingVocabulary, mergeSpeakers, parseRecord, renameSpeaker, replaceTranscript, secondsFromTimecode, segmentsFromWords,
  splitCitations, stampNote, stampedNotes, timecode, transcriptChunks, transcriptText, unstampedNotes, updateMeeting, type Block, type TranscriptSegment,
} from "../src/index.js";

function store() {
  let now = 1000;
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "m", now: () => now });
  return { s, tick: (d: number) => (now += d) };
}

const kids = (s: WorkspaceStore, id: string) => s.children("b:" + id).map((c) => s.blocks.get(c)!);
const seg = (id: string, s: number, e: number, t: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({ id, s, e, t, ...extra });

describe("Meeting-Block", () => {
  it("legt Notizen und Zusammenfassung an und findet das Meeting von innen", () => {
    const { s } = store();
    const page = createPage(s, { title: "Weekly" });
    const m = createMeeting(s, { parent: "b:" + page, title: "Sync" });
    expect(s.blocks.get(m)?.type).toBe("meeting");
    expect(meetingInfo(s, m)?.status).toBe("ready");
    expect(kids(s, m).map((b) => b.props?.meetingSection)).toEqual(["notes", "summary"]);
    expect(meetingSection(s, m, "notes")).toBe(kids(s, m)[0]!.id);
    appendTranscript(s, m, [seg("a", 0, 1, "Hallo")]);
    expect(meetingContaining(s, transcriptChunks(s, m)[0]!.id)).toBe(m);
    expect(meetingContaining(s, page)).toBeUndefined();
  });

  it("Live-Segmente: Chunks zu 40, vorläufige werden ersetzt, leerer Text entfernt, nicht im Undo", () => {
    const { s } = store();
    const m = createMeeting(s, { parent: "w" });
    appendTranscript(s, m, [seg("a", 0, 1, "Hal", { sp: "me", tr: "microphone", p: true })]);
    appendTranscript(s, m, [seg("a", 0, 1.4, "Hallo zusammen", { sp: "me", tr: "microphone" })]);
    expect(meetingTranscript(s, m).map((x) => x.t)).toEqual(["Hallo zusammen"]);
    expect(transcriptChunks(s, m)).toHaveLength(1);

    const many = Array.from({ length: TRANSCRIPT_CHUNK_SIZE * 2 }, (_, i) => seg("s" + i, i + 2, i + 3, "w" + i));
    appendTranscript(s, m, many);
    expect(transcriptChunks(s, m)).toHaveLength(3);
    expect(meetingTranscript(s, m)).toHaveLength(1 + many.length);
    expect(meetingInfo(s, m)?.duration).toBe(TRANSCRIPT_CHUNK_SIZE * 2 + 2);

    // Ein Update eines Segments in einem älteren Chunk schreibt nur diesen einen Record.
    const before = new Map(transcriptChunks(s, m).map((c) => [c.id, JSON.stringify(c)]));
    let written: string[] = [];
    const off = s.observe((c) => { written = c.keys; });
    appendTranscript(s, m, [seg("s3", 5, 6, "fixed")]);
    off();
    const changedChunks = transcriptChunks(s, m).filter((c) => before.get(c.id) !== JSON.stringify(c));
    expect(changedChunks).toHaveLength(1);
    expect(written.filter((k) => k.startsWith("block:") && !k.includes(m))).toHaveLength(1);
    expect(meetingTranscript(s, m).filter((x) => x.id === "s3").map((x) => x.t)).toEqual(["fixed"]);
    expect(meetingTranscript(s, m)).toHaveLength(1 + many.length);

    appendTranscript(s, m, [seg("x", 90, 91, "äh", { p: true })]);
    appendTranscript(s, m, [seg("x", 0, 0, "")]);
    expect(meetingTranscript(s, m).some((x) => x.id === "x")).toBe(false);
    // Erkennung ist kein Undo-Schritt: auf dem Stapel liegt nur das Anlegen.
    expect((s as unknown as { undoStack: { name: string }[] }).undoStack.map((e) => e.name)).toEqual(["New meeting notes"]);
  });

  it("finales Transkript ersetzt Live-Text; Sprechertrennung, Umbenennen, Zusammenführen", () => {
    const { s } = store();
    const m = createMeeting(s, { parent: "w" });
    appendTranscript(s, m, [seg("live", 0, 1, "x", { p: true })]);
    replaceTranscript(s, m, [
      seg("1", 0, 2, "Wie war die Woche?", { sp: "me", tr: "microphone" }),
      seg("2", 2.2, 5, "Gut, das Release ist draußen.", { sp: "others", tr: "system" }),
      seg("3", 5.1, 7, "Bei mir auch.", { sp: "others", tr: "system" }),
    ], "test");
    expect(meetingTranscript(s, m).map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(meetingInfo(s, m)?.engine).toBe("test");
    applySpeakerTurns(s, m, [{ start: 0, end: 5.05, speaker: "spk_a" }, { start: 5.05, end: 8, speaker: "spk_b" }], new Set(["system"]));
    expect(meetingTranscript(s, m).map((x) => x.sp)).toEqual(["me", "spk_a", "spk_b"]);
    expect(meetingInfo(s, m)?.speakers?.map((x) => x.name)).toEqual(["Me", "Speaker 1", "Speaker 2"]);
    renameSpeaker(s, m, "spk_a", "Anna");
    mergeSpeakers(s, m, "spk_b", "spk_a");
    expect(meetingTranscript(s, m).map((x) => x.sp)).toEqual(["me", "spk_a", "spk_a"]);
    const info = meetingInfo(s, m);
    expect(info?.speakers?.map((x) => x.name)).toEqual(["Me", "Anna"]);
    expect(transcriptText(meetingTranscript(s, m), info)).toBe("[0:00] Me: Wie war die Woche?\n[0:02] Anna: Gut, das Release ist draußen. Bei mir auch.");
  });

  it("Zeitmarken und Zitate", () => {
    expect(timecode(5)).toBe("0:05");
    expect(timecode(754.9)).toBe("12:34");
    expect(timecode(3723)).toBe("1:02:03");
    expect(secondsFromTimecode("[12:34]")).toBe(754);
    expect(secondsFromTimecode("1:02:03")).toBe(3723);
    expect(secondsFromTimecode("12:75")).toBeUndefined();
    expect(secondsFromTimecode("[link]")).toBeUndefined();
    expect(citations("- Release fertig [2:05] und Budget [1:00:00] ok [x]").map((c) => c.seconds)).toEqual([125, 3600]);
    expect(splitCitations("Alles gut [0:07].")).toEqual([{ text: "Alles gut " }, { text: "[0:07]", seconds: 7 }, { text: "." }]);
  });

  it("Kontext, Vokabular, Notizen mit Zeit und Zusammenfassung", () => {
    const { s, tick } = store();
    const spec = createPage(s, { title: "Projekt Nordlicht" });
    s.transact("x", (tx) => tx.put({ kind: "block", data: { id: "t1", type: "text", parent: "b:" + spec, sk: "a0", createdAt: 0, updatedAt: 0,
      text: "Das Team um Katharina plant die API für BasedSync. Katharina übernimmt das KPI-Board." } }));
    const m = createMeeting(s, { parent: "w" });
    addMeetingContext(s, m, { kind: "page", pageID: spec });
    addMeetingContext(s, m, { kind: "page", pageID: spec });
    addMeetingContext(s, m, { kind: "text", text: "Agenda: Roadmap Q1" });
    updateMeeting(s, m, (x) => { x.attendees = ["Elija", "Katharina"]; x.vocabulary = ["Parakeet"]; });
    expect(meetingInfo(s, m)?.context).toHaveLength(2);
    const vocab = meetingVocabulary(s, m);
    expect(vocab.slice(0, 3)).toEqual(["Parakeet", "Elija", "Katharina"]);
    expect(vocab).toContain("Projekt Nordlicht");
    expect(vocab).toContain("API");
    expect(vocab).toContain("BasedSync");
    expect(vocab).not.toContain("Das");
    expect(vocab).not.toContain("Team");
    expect(meetingContextText(s, m)).toContain("Agenda: Roadmap Q1");

    const notes = findMeetingSection(s, m, "notes")!;
    const since = s.now();
    tick(5);
    s.transact("n", (tx) => tx.put({ kind: "block", data: { id: "n1", type: "text", parent: "b:" + notes, sk: "a0", createdAt: s.now(), updatedAt: s.now(), text: "Budget klären" } }));
    s.transact("n", (tx) => tx.put({ kind: "block", data: { id: "n0", type: "text", parent: "b:" + notes, sk: "Zz", createdAt: 0, updatedAt: 0, text: "alt" } }));
    expect(unstampedNotes(s, m, ["n1", "n0", spec], since)).toEqual(["n1"]);
    stampNote(s, "n1", 95);
    stampNote(s, "n1", 200); // bleibt beim ersten Stempel
    expect(meetingNotesText(s, m)).toBe("alt\n[1:35] Budget klären");
    expect(stampedNotes(s, m)).toEqual([{ id: "n1", time: 95, text: "Budget klären" }]);

    applyMeetingSummary(s, m, "## Zusammenfassung\nAlles gut [0:00]\n\n## Action items\n- [ ] Elija: Budget [1:35]", "claude");
    const summary = kids(s, findMeetingSection(s, m, "summary")!);
    expect(summary.map((b) => b.type)).toEqual(["heading2", "text", "heading2", "todo"]);
    expect(meetingInfo(s, m)?.summary).toBe("done");
    expect(meetingInfo(s, m)?.summaryEngine).toBe("claude");
    applyMeetingSummary(s, m, "Neu", "claude");
    expect(kids(s, findMeetingSection(s, m, "summary")!).map((b) => b.text)).toEqual(["Neu"]);
  });

  it("Wörter werden zu Äußerungen", () => {
    const W = (text: string, start: number, end: number) => ({ text, start, end });
    const words = [W("Hallo", 0, 0.4), W("zusammen.", 0.45, 0.9), W("Kurz", 2.5, 2.8), W("zum", 2.85, 3), W("Budget", 3.05, 3.5),
      W("für", 3.55, 3.7), W("Q1.", 3.75, 7.2), W("Passt", 7.3, 7.6), W("das?", 7.65, 8)];
    const segs = segmentsFromWords(words, { offset: 60, speaker: "me", track: "microphone" });
    expect(segs.map((x) => x.t)).toEqual(["Hallo zusammen.", "Kurz zum Budget für Q1.", "Passt das?"]);
    expect(segs.map((x) => x.s)).toEqual([60, 62.5, 67.3]);
    expect(new Set(segs.map((x) => x.id)).size).toBe(3);
  });
});

describe("Swift-Wire-Format", () => {
  const corpus = readFileSync(fileURLToPath(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url)), "utf8").split("\n").filter(Boolean);
  const meetingLines = corpus.filter((l) => /"type":"(meeting|meetingSection|transcript)"/.test(l));

  it("Meeting-Records aus Swift lesen, ändern und byte-gleich zurückschreiben (unbekannte Felder bleiben)", () => {
    expect(meetingLines.length).toBeGreaterThanOrEqual(4);
    const recs = meetingLines.map((l) => parseRecord(JSON.parse(l)));
    const s = new WorkspaceStore({ persistence: new MemoryPersistence(recs), node: "t", now: () => 784_100_000 });
    const m = [...s.blocks.values()].find((b) => b.type === "meeting")!;
    // Der Swift-Korpus hängt Chunk und Abschnitte neben das Meeting; hier nur lesen, was da ist.
    expect(meetingInfo(s, m.id)?.speakers?.map((x) => x.name)).toEqual(["Elija", "Gast"]);
    // Unveränderte Records serialisieren byte-gleich.
    for (const l of meetingLines) {
      const id = JSON.parse(l).data.id as string;
      expect(encodeRecord({ kind: "block", data: s.blocks.get(id)! })).toBe(l);
    }
    // Eine Änderung über die Ops lässt alle anderen Felder (auch unbekannte Abschnitte) unangetastet.
    renameSpeaker(s, m.id, "s2", "Gast A");
    const after = s.blocks.get(m.id)!;
    const a = JSON.parse(encodeRecord({ kind: "block", data: after })).data;
    const b = JSON.parse(meetingLines.find((l) => l.includes(m.id))!).data;
    expect(a.props.meeting.speakers[1].name).toBe("Gast A");
    a.props.meeting.speakers[1].name = "Gast";
    delete a.stamp; delete b.stamp; delete a.updatedAt; delete b.updatedAt; delete a.updatedBy; delete b.updatedBy;
    expect(a).toEqual(b);
  });

  it("neue Records der Ops parsen gegen das Schema und serialisieren kanonisch", () => {
    const { s } = store();
    const m = createMeeting(s, { parent: "w", title: "Call" });
    appendTranscript(s, m, [seg("1", 0, 1.5, "Hallo", { sp: "me", tr: "microphone" }), seg("2", 1.5, 3, "…", { p: true })]);
    applyMeetingSummary(s, m, "- Punkt [0:01]", "Scripted");
    for (const b of [s.blocks.get(m)!, ...s.descendants(m).map((id) => s.blocks.get(id)!)] as Block[]) {
      const line = encodeRecord({ kind: "block", data: b });
      expect(encodeRecord(parseRecord(JSON.parse(line)))).toBe(line);
    }
    const chunk = transcriptChunks(s, m)[0]!;
    expect(JSON.parse(encodeRecord({ kind: "block", data: chunk })).data.props.segments[0]).toEqual({ e: 1.5, id: "1", s: 0, sp: "me", t: "Hallo", tr: "microphone" });
  });
});
