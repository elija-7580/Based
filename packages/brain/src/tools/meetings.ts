// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Meeting Notes für Agenten (Matrix M2–M5): auflisten, Notizen/Zusammenfassung/Transkript lesen, Titel,
// Zusammenfassung, Sprechernamen und Kontext ändern. Aufnehmen und Abspielen bleiben am Gerät (M6, M7).
import {
  addMeetingContext, applyMeetingSummary, findMeetingSection, isTrashed, meetingInfo, meetingNotesText, meetingSummaryTexts, meetingTranscript,
  plainText, removeMeetingContext, renameSpeaker, setMeetingTitle, timecode, transcriptParagraphs, updateMeeting,
} from "@based/core";
import { limitSchema, needStr, obj, offsetSchema, optNum, optStr, paged, S, str, stringMap, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";

const SWIFT_EPOCH_S = 978_307_200;
const day = (swift: number | undefined) => (swift === undefined ? "" : new Date((swift + SWIFT_EPOCH_S) * 1000).toISOString().slice(0, 16).replace("T", " "));
const length = (s: number | undefined) => (s === undefined ? "" : `${Math.max(1, Math.round(s / 60))} min`);

export function meetingTools(ctx: ToolCtx): ToolDef[] {
  const { store } = ctx;
  const meeting = (id: string) => {
    const info = meetingInfo(store, id);
    if (!info || isTrashed(store, id)) throw new ToolError(`No meeting with id ${id} (list_meetings shows them).`);
    return info;
  };
  const speakerName = (info: ReturnType<typeof meeting>, id: string | undefined) => info.speakers?.find((s) => s.id === id)?.name ?? (id === "me" ? "Me" : id === "others" ? "Others" : id ?? "Unknown");
  return [
    {
      group: "pages", write: false,
      spec: { name: "list_meetings", description: "Meetings with date, length, state and the page they are on, newest first.", inputSchema: obj({ limit: limitSchema, offset: offsetSchema }) },
      run: (a) => {
        const all = [...store.blocks.values()].filter((b) => b.type === "meeting" && !isTrashed(store, b.id))
          .sort((x, y) => (y.props?.meeting?.startedAt ?? y.createdAt) - (x.props?.meeting?.startedAt ?? x.createdAt));
        if (all.length === 0) return "No meetings yet.";
        return paged(all.map((b) => {
          const m = b.props?.meeting ?? { status: "ready" as const };
          const page = store.containingPage(b.id);
          const has = [findMeetingSection(store, b.id, "summary") && meetingSummaryTexts(store, b.id).length ? "summary" : "", meetingTranscript(store, b.id, false).length ? "transcript" : ""].filter(Boolean).join(", ");
          return `- ${plainText(b.text) || "Untitled meeting"} (id: ${b.id}) — ${[day(m.startedAt ?? b.createdAt), length(m.duration), m.status, has].filter(Boolean).join(" · ")}${page ? ` — on “${ctx.title(page)}” (${page})` : ""}`;
        }), Math.max(1, optNum(a, "limit", 50)), optNum(a, "offset", 0));
      },
    },
    {
      group: "pages", write: false,
      spec: {
        name: "read_meeting",
        description: "One meeting: info, notes and summary; part=transcript reads the transcript with timecodes and speakers (paged, it can be long). Notes are ordinary blocks: write them with edit_blocks {in=<notes section id>}.",
        inputSchema: obj({ id: str("Meeting id"), part: { type: "string", enum: ["overview", "transcript"] }, limit: limitSchema, offset: offsetSchema }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        const info = meeting(id);
        if (optStr(a, "part") === "transcript") {
          const paras = transcriptParagraphs(meetingTranscript(store, id, false));
          if (paras.length === 0) return "No transcript.";
          return paged(paras.map((p) => `[${timecode(p.start)}] ${speakerName(info, p.speaker)}: ${p.text}`), Math.max(1, optNum(a, "limit", 80)), optNum(a, "offset", 0));
        }
        const b = store.blocks.get(id)!;
        const notes = findMeetingSection(store, id, "notes"), summary = findMeetingSection(store, id, "summary");
        const segments = meetingTranscript(store, id, false).length;
        const out = [
          `# ${plainText(b.text) || "Untitled meeting"} (id: ${id})`,
          [day(info.startedAt ?? b.createdAt), length(info.duration), info.status].filter(Boolean).join(" · "),
          info.speakers?.length ? `Speakers: ${info.speakers.map((s) => `${s.name} (${s.id})`).join(", ")}` : "",
          info.context?.length ? `Context: ${info.context.map((c) => `${c.kind === "page" && c.pageID ? `page “${ctx.title(c.pageID)}”` : c.title || c.kind} (${c.id})`).join(", ")}` : "",
          "", `## Notes${notes ? ` (section id: ${notes})` : ""}`, meetingNotesText(store, id) || "(none)",
          "", `## Summary${summary ? ` (section id: ${summary})` : ""}`, meetingSummaryTexts(store, id).join("\n") || "(none)",
          "", segments ? `Transcript: ${segments} segments (read_meeting with part: transcript).` : "No transcript.",
        ];
        return out.filter((l, i) => l !== "" || out[i - 1] !== "").join("\n");
      },
    },
    {
      group: "pages", write: true,
      spec: {
        name: "update_meeting",
        description: "Change a meeting: title, summary (Markdown, replaces the summary), speaker names, context pages.",
        inputSchema: obj({
          id: str("Meeting id"), title: S, summary: str("Markdown"),
          speakers: stringMap("speaker id or current name → new name"),
          add_context: { type: "array", items: S, description: "Page ids to attach as context" },
          remove_context: { type: "array", items: S, description: "Context ids (read_meeting shows them)" },
        }, ["id"]),
      },
      run: (a) => {
        const id = needStr(a, "id");
        const info = meeting(id);
        const page = store.containingPage(id);
        if (page) ctx.writable(page);
        const renames = Object.entries((a.speakers as Record<string, string> | undefined) ?? {}).map(([ref, name]) => {
          const s = info.speakers?.find((x) => x.id === ref) ?? info.speakers?.find((x) => x.name.toLowerCase() === ref.toLowerCase());
          const sid = s?.id ?? (["me", "others"].includes(ref.toLowerCase()) ? ref.toLowerCase() : undefined);
          if (!sid) throw new ToolError(`No speaker “${ref}”. Speakers: ${(info.speakers ?? []).map((x) => `${x.name} (${x.id})`).join(", ") || "me, others"}`);
          if (!name.trim()) throw new ToolError("A speaker name can't be empty.");
          return [sid, name.trim()] as const;
        });
        const add = ((a.add_context as string[] | undefined) ?? []).map((p) => ctx.page(p).id);
        const remove = (a.remove_context as string[] | undefined) ?? [];
        for (const c of remove) if (!info.context?.some((x) => x.id === c)) throw new ToolError(`No context item ${c}.`);
        const log: string[] = [];
        const title = optStr(a, "title");
        if (title !== undefined) { setMeetingTitle(store, id, title); log.push("title"); }
        const summary = optStr(a, "summary");
        if (summary !== undefined) {
          applyMeetingSummary(store, id, summary);
          updateMeeting(store, id, (m) => { m.summary = "done"; }, { name: "Meeting summary" });
          log.push("summary");
        }
        for (const [sid, name] of renames) renameSpeaker(store, id, sid, name);
        if (renames.length) log.push(`${renames.length} speaker name${renames.length === 1 ? "" : "s"}`);
        for (const p of add) addMeetingContext(store, id, { kind: "page", pageID: p });
        for (const c of remove) removeMeetingContext(store, id, c);
        if (add.length || remove.length) log.push("context");
        return log.length ? `Updated meeting: ${log.join(", ")}` : "Nothing to change.";
      },
    },
  ];
}
