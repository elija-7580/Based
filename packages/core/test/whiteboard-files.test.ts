// BSD-266: Dateien auf dem Board – Einordnung in die drei Stufen und lesbare Vorschau von Text, Logs und Chats.
import { describe, expect, it } from "vitest";
import { boardFileView, textPreview } from "../src/index.js";

describe("boardFileView", () => {
  it("ordnet nach Art und Endung ein", () => {
    expect(boardFileView("photo.jpg", "image/jpeg")).toBe("image");
    expect(boardFileView("slides.pdf", "")).toBe("pdf");
    expect(boardFileView("report.html", "text/html")).toBe("html");
    expect(boardFileView("clip.mov", "video/quicktime")).toBe("video");
    expect(boardFileView("memo.m4a", "audio/mp4")).toBe("audio");
    expect(boardFileView("session.jsonl", "")).toBe("text");
    expect(boardFileView("run.log", "application/octet-stream")).toBe("text");
    expect(boardFileView("notes.md", "text/markdown; charset=utf-8")).toBe("text");
    expect(boardFileView("data.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("card");
  });
  it("SVG wird als Text gezeigt, nie als Bild oder HTML ausgeführt", () => {
    expect(boardFileView("logo.svg", "image/svg+xml")).toBe("text");
  });
});

describe("textPreview", () => {
  it("Chat-Log (eine Wortmeldung je Zeile) wird ein Gespräch", () => {
    const log = [
      JSON.stringify({ role: "user", content: "Fix the sync bug" }),
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Looking at\nthe queue." }, { type: "tool_use", name: "Bash" }] }),
      JSON.stringify({ type: "summary", leafUuid: "x" }),
    ].join("\n");
    const p = textPreview(log, "session.jsonl");
    expect(p.chat).toBe(true);
    expect(p.lines).toEqual([{ role: "user", text: "Fix the sync bug" }, { role: "assistant", text: "Looking at the queue. [tool: Bash]" }]);
  });
  it("Agent-Log mit verschachtelter Nachricht (type + message)", () => {
    const log = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "hello" }] } }),
    ].join("\n");
    expect(textPreview(log, "agent.jsonl").lines).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "[thinking] hello" }]);
  });
  it("JSON mit messages-Liste wird ein Gespräch; gewöhnliches JSON bleibt Text", () => {
    expect(textPreview(JSON.stringify({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }), "chat.json").chat).toBe(true);
    const plain = textPreview('{\n  "name": "based"\n}', "package.json");
    expect(plain.chat).toBe(false);
    expect(plain.lines.map((l) => l.text)).toEqual(["{", '  "name": "based"', "}"]);
  });
  it("gewöhnliches Log: Zeile für Zeile, Tabs als Leerzeichen, begrenzt, mit Hinweis auf mehr", () => {
    const p = textPreview(Array.from({ length: 500 }, (_, i) => `12:00:${i}\tINFO step ${i}`).join("\n"), "run.log");
    expect(p.chat).toBe(false);
    expect(p.lines).toHaveLength(120);
    expect(p.lines[0]!.text).toBe("12:00:0  INFO step 0");
    expect(p.more).toBe(true);
  });
  it("abgeschnittener Anfang: die halbe letzte Zeile fällt weg, überlange Zeilen werden gekürzt", () => {
    const p = textPreview("first\nsecond\nhalf a li", "notes.txt", true);
    expect(p.lines.map((l) => l.text)).toEqual(["first", "second"]);
    expect(p.more).toBe(true);
    expect(textPreview("x".repeat(5000), "a.txt").lines[0]!.text.length).toBe(600);
  });
});
