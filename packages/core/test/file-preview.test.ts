// BSD-260 Teil 12: Vorschau von Text-, Code- und CSV-Dateien (Kern). Die Oberfläche zeigt nur an, was hier gelesen wird.
import { describe, expect, it } from "vitest";
import { decodeTextBytes, parseDelimited, previewFile, previewKind, previewLanguage, sniffDelimiter } from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("Dateivorschau (BSD-260 Teil 12)", () => {
  it("Art nach Endung und MIME-Typ", () => {
    expect(previewKind("Bild.PNG")).toBe("image");
    expect(previewKind("logo.svg")).toBe("image");
    expect(previewKind("a.pdf")).toBe("pdf");
    expect(previewKind("talk.m4a")).toBe("audio");
    expect(previewKind("clip.mov")).toBe("video");
    expect(previewKind("Umsatz.csv")).toBe("csv");
    expect(previewKind("data.tsv")).toBe("csv");
    expect(previewKind("export", "text/csv; charset=utf-8")).toBe("csv");
    expect(previewKind("main.rs")).toBe("text");
    expect(previewKind("Dockerfile")).toBe("text");
    expect(previewKind("notes", "text/plain")).toBe("text");
    expect(previewKind("archive.zip")).toBe("none");
    expect(previewKind("tool.exe", "application/octet-stream")).toBe("none");
  });

  it("Sprache für die Hervorhebung", () => {
    expect(previewLanguage("src/app.tsx")).toBe("typescript");
    expect(previewLanguage("script.PY")).toBe("python");
    expect(previewLanguage("config.yml")).toBe("yaml");
    expect(previewLanguage("README.md")).toBe("markdown");
    expect(previewLanguage("Dockerfile")).toBe("dockerfile");
    expect(previewLanguage("notes.txt")).toBe("text");
    expect(previewLanguage("unknown.xyz")).toBe("text");
  });

  it("Text: UTF-8, BOM, UTF-16, Windows-1252, Binärdaten", () => {
    expect(decodeTextBytes(utf8("Grüße"))).toEqual({ text: "Grüße", encoding: "utf-8" });
    expect(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("ä")]))).toEqual({ text: "ä", encoding: "utf-8" });
    expect(decodeTextBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xe4, 0x00]))).toEqual({ text: "Aä", encoding: "utf-16le" });
    expect(decodeTextBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toEqual({ text: "A", encoding: "utf-16be" });
    // „Müller;€“ aus Excel unter Windows (cp1252: ü = FC, € = 80)
    expect(decodeTextBytes(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x3b, 0x80]))).toEqual({ text: "Müller;€", encoding: "windows-1252" });
    expect(decodeTextBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))).toBeUndefined();
  });

  it("Angelesene Datei: abgeschnittenes UTF-8-Zeichen am Ende ist kein Windows-1252", () => {
    const bytes = utf8("a".repeat(10) + "€€€");
    const p = previewFile({ name: "x.txt", bytes }, { maxBytes: 12 }); // mitten im ersten €
    expect(p).toMatchObject({ kind: "text", encoding: "utf-8", truncated: true, text: "a".repeat(10) });
    const full = previewFile({ name: "x.txt", bytes });
    expect(full).toMatchObject({ kind: "text", text: "a".repeat(10) + "€€€", truncated: false, language: "text" });
  });

  it("Trennzeichen erkennen: Komma, Semikolon (deutsches Excel), Tab, senkrechter Strich", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(sniffDelimiter("Name;Betrag\nMüller;1,50\nSchmidt;2,75\n")).toBe(";");
    expect(sniffDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(sniffDelimiter("a|b|c\n1|2|3\n")).toBe("|");
    expect(sniffDelimiter("\"x, y\";z\n\"1, 2\";3\n")).toBe(";");
    expect(sniffDelimiter("eins\nzwei\n")).toBe(",");
    expect(sniffDelimiter("a,b\n", "liste.tsv")).toBe("\t");
  });

  it("CSV zerlegen: Anführungszeichen, Zeilenumbruch im Feld, CRLF, leere Zeilen", () => {
    const { rows, more } = parseDelimited("﻿a,b\r\n\"x, \"\"y\"\"\",\"zwei\nZeilen\"\r\n\r\n3,\n", ",");
    expect(rows).toEqual([["a", "b"], ["x, \"y\"", "zwei\nZeilen"], ["3", ""]]);
    expect(more).toBe(false);
    expect(parseDelimited("1\n2\n3\n", ",", 2)).toEqual({ rows: [["1"], ["2"]], more: true });
  });

  it("CSV-Vorschau: Kopfzeile, Zeilen-/Spaltengrenze, Semikolon-Datei aus Excel", () => {
    const csv = "Name;Betrag;Datum\r\nMüller;1,50;2026-01-02\r\nSchmidt;2,75;2026-01-03\r\n";
    const bytes = new Uint8Array([...csv].map((c) => (c === "ü" ? 0xfc : c.charCodeAt(0))));
    expect(previewFile({ name: "Umsatz.csv", bytes })).toEqual({
      kind: "csv", header: ["Name", "Betrag", "Datum"], rows: [["Müller", "1,50", "2026-01-02"], ["Schmidt", "2,75", "2026-01-03"]],
      delimiter: ";", encoding: "windows-1252", truncated: false,
    });
    const many = "n\n" + Array.from({ length: 500 }, (_, i) => String(i)).join("\n");
    const p = previewFile({ name: "n.csv", bytes: utf8(many) }, { maxRows: 10 });
    expect(p).toMatchObject({ kind: "csv", header: ["n"], truncated: true });
    expect(p.kind === "csv" && p.rows.length).toBe(10);
    const wide = previewFile({ name: "w.csv", bytes: utf8("a,b,c,d\n1,2,3,4\n") }, { maxColumns: 2 });
    expect(wide).toMatchObject({ header: ["a", "b"], rows: [["1", "2"]], truncated: true });
  });

  it("CSV angelesen: die letzte halbe Zeile fällt weg", () => {
    const text = "a,b\n" + Array.from({ length: 100 }, (_, i) => `${i},wert ${i}`).join("\n");
    const p = previewFile({ name: "t.csv", bytes: utf8(text) }, { maxBytes: 60 });
    expect(p.kind).toBe("csv");
    if (p.kind !== "csv") return;
    expect(p.truncated).toBe(true);
    for (const r of p.rows) expect(r).toEqual([r[0], `wert ${r[0]}`]);
  });

  it("Bilder, PDF, Binärdaten: keine Textvorschau", () => {
    expect(previewFile({ name: "a.png", bytes: new Uint8Array([1, 2]) })).toEqual({ kind: "image" });
    expect(previewFile({ name: "a.pdf", bytes: new Uint8Array([1, 2]) })).toEqual({ kind: "pdf" });
    expect(previewFile({ name: "kaputt.txt", bytes: new Uint8Array([0x41, 0x00, 0x42]) })).toEqual({ kind: "none" });
  });
});
