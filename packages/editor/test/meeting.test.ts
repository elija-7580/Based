// @vitest-environment jsdom
// BSD-226: Meeting-Block im Editor – eigener Block, Abschnitte/Transkript bleiben außerhalb des Seiten-Dokuments,
// Notizen als eigenes Dokument auf dem Notiz-Abschnitt, Einfügen über das Slash-Menü legt die Records an.
import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import {
  appendTranscript, createMeeting, findMeetingSection, meetingInfo, meetingTranscript, MemoryPersistence, plainText, WorkspaceStore, type Block, type WireRecord,
} from "@based/core";
import { docBlockIDs, projectDoc } from "../src/mapping/blocks.js";
import { CUSTOM } from "../src/mapping/bn.js";
import { basedSchema, createConverter, type BasedEditor } from "../src/schema/schema.js";
import { insertMeeting } from "../src/ui/PageEditor.js";
import { DocSession } from "../src/yjs/session.js";

const converter = createConverter();
const T = 800_000_000;
const blk = (id: string, type: string, parent: string, sk: string, extra: Record<string, unknown> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, createdAt: T, updatedAt: T, ...extra } as Block });

function store(extra: WireRecord[] = []) {
  let t = T;
  return new WorkspaceStore({
    persistence: new MemoryPersistence([blk("p", "page", "w", "a0", { text: "Seite" }), blk("a", "text", "b:p", "a0", { text: "" }), ...extra]),
    node: "t", now: () => (t += 1),
  });
}

const mounted: BasedEditor[] = [];
function mount(session: DocSession): BasedEditor {
  const editor = BlockNoteEditor.create(withCollaboration({
    schema: basedSchema(),
    collaboration: { fragment: session.fragment, user: { name: "t", color: "var(--muted)" } },
  })) as unknown as BasedEditor;
  const div = document.createElement("div");
  document.body.appendChild(div);
  editor.mount(div);
  mounted.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of mounted.splice(0)) e.unmount();
});
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("Meeting-Block", () => {
  it("Projektion: eigener Block ohne Kinder; Abschnitte und Transkript gehören nicht zum Seiten-Dokument", () => {
    const s = store();
    const m = createMeeting(s, { parent: "b:p", title: "Sync" });
    appendTranscript(s, m, [{ id: "1", s: 0, e: 1, t: "Hallo" }]);
    const doc = projectDoc(s, "p");
    expect(doc.map((b) => b.type)).toEqual(["paragraph", CUSTOM.meeting]);
    expect(doc[1]!.children).toEqual([]);
    expect([...docBlockIDs(s, "p")].sort()).toEqual(["a", m].sort());
  });

  it("Seite bearbeiten lässt Meeting-Records unangetastet; Notizen sind ein eigenes Dokument", async () => {
    const s = store();
    const m = createMeeting(s, { parent: "b:p", title: "Sync" });
    appendTranscript(s, m, [{ id: "1", s: 0, e: 1, t: "Hallo" }]);
    const before = JSON.stringify(s.blocks.get(m));
    const page = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(page);
    await tick();
    ed.updateBlock("a", { content: "Neu" } as never);
    page.flush();
    expect(plainText(s.blocks.get("a")?.text)).toBe("Neu");
    expect(JSON.stringify(s.blocks.get(m))).toBe(before);
    expect(meetingTranscript(s, m).map((x) => x.t)).toEqual(["Hallo"]);

    const notesID = findMeetingSection(s, m, "notes")!;
    const notes = new DocSession(s, notesID, { converter, debounceMs: 0 });
    const ned = mount(notes);
    await tick();
    ned.replaceBlocks(ned.document.map((b) => b.id), [{ type: "paragraph", content: "Budget klären" } as never]);
    notes.flush();
    const kids = s.children("b:" + notesID).map((id) => s.blocks.get(id)!);
    expect(kids.map((b) => plainText(b.text))).toEqual(["Budget klären"]);
    // Live-Transkript (Store von außen) stört die Seite nicht.
    appendTranscript(s, m, [{ id: "2", s: 1, e: 2, t: "Welt" }]);
    expect(ed.document.map((b) => b.type)).toEqual(["paragraph", CUSTOM.meeting]);
    page.close();
    notes.close();
  });

  it("/meet: Records mit Abschnitten, Block an der Schreibmarke, Absatz danach", async () => {
    const s = store();
    const page = new DocSession(s, "p", { converter, debounceMs: 0 });
    const ed = mount(page);
    await tick();
    ed.setTextCursorPosition("a");
    const id = insertMeeting(ed, page);
    page.flush();
    const rec = s.blocks.get(id)!;
    expect(rec.type).toBe("meeting");
    expect(rec.parent).toBe("b:p");
    expect(meetingInfo(s, id)?.status).toBe("ready");
    expect(plainText(rec.text)).toMatch(/^Meeting notes — /);
    expect(s.children("b:" + id).map((c) => s.blocks.get(c)?.props?.meetingSection)).toEqual(["notes", "summary"]);
    expect(ed.document.map((b) => b.type)).toEqual([CUSTOM.meeting, "paragraph"]);
    expect(s.blocks.has("a")).toBe(false);
    page.close();
  });
});
