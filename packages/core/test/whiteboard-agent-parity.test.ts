// Elija 18.11.: Agenten können auf dem Board alles, was ein Mensch kann – Farben, Stellen, Größen, Drehen, Feststecken,
// Ebenen, freies Zeichnen, Bilder und Dateien, Hintergrund. Hier: das Skript (planBoardScript) und der Umriss.
import { describe, expect, it } from "vitest";
import { boardFileParts, boardOutline, decodeInk, pathToStrokes, planBoardScript, sniffImageSize, sniffMime, sniffPdfPages, type BoardFileInfo, type WBConnector, type WBShape } from "../src/index.js";

const ids = () => { let n = 0; return () => `new${++n}`; };
const note = (id: string, x: number, text: string, style?: WBShape["style"]): WBShape => ({ id, kind: "note", z: "a" + id.length, x, y: 0, w: 168, h: 150, rot: 0, text, ...(style ? { style } : {}) });
const IMG = "based-asset:" + "a".repeat(64), PDF = "based-asset:" + "b".repeat(64);
const files = (ref: string): BoardFileInfo | undefined =>
  ref === IMG ? { ref, name: "photo.png", mime: "image/png", size: 1000, width: 960, height: 480 }
    : ref === PDF ? { ref, name: "paper.pdf", mime: "application/pdf", size: 5000, pages: [{ width: 595, height: 842 }, { width: 595, height: 842 }] } : undefined;

describe("Skript: Stil und Stelle", () => {
  it("Farben, feste Stelle, Größe, Drehung, Feststecken auf neuen Objekten", () => {
    const plan = planBoardScript("note a: hi {color=green at=100,50 size=200x120 rot=10 pin=true}\nbox b: x {color=red fill=blue shape=oval}\ntext t: plain {color=purple}", [], ids());
    expect(plan.errors).toEqual([]);
    const [a, b, t] = plan.add as WBShape[];
    expect(a).toMatchObject({ kind: "note", x: 100, y: 50, w: 200, h: 120, rot: 10, style: { color: "green", pin: true, agent: true } });
    expect(b!.style).toMatchObject({ shape: "oval", color: "red", fill: "blue" });
    expect(t!.style).toMatchObject({ color: "purple" });
    // Ohne at= kommt Neues rechts neben das fest Gesetzte.
    expect(b!.x).toBeGreaterThan(300);
  });
  it("falsche Farbe oder Attribute: Zeile übersprungen mit Grund, der Rest gilt", () => {
    const plan = planBoardScript("note a: x {color=yellow}\nnote b: ok\ntext c: y {fill=red}\nbox d: z {wobble=1}", [], ids());
    expect(plan.add).toHaveLength(1);
    expect(plan.errors.join("\n")).toMatch(/yellow.*not one of/);
    expect(plan.errors.join("\n")).toMatch(/text has no fill/);
    expect(plan.errors.join("\n")).toMatch(/unknown attribute “wobble”/);
  });
  it("Markdown-Text mit Klammern bleibt Text", () => {
    const plan = planBoardScript("note a: - [ ] task and [link](https://x.dev) {curly}", [], ids());
    expect((plan.add[0] as WBShape).text).toBe("- [ ] task and [link](https://x.dev) {curly}");
  });
  it("set ändert Stil, Stelle, Größe und Ebene bestehender Objekte; Verbindungen: Farbe und Linie", () => {
    const a = note("aaaa1111", 0, "A", { color: "blue" }), b = note("bbbb2222", 300, "B");
    const c: WBConnector = { id: "cccc3333", kind: "connector", z: "a9", from: { id: a.id, side: "auto" }, to: { id: b.id, side: "auto" }, shape: "curved" };
    const plan = planBoardScript("set aaaa {color=red at=10,20 size=100x90 z=front}\nset bbbb: renamed {pin=true}\nset cccc {color=green line=elbow}", [a, b, c], ids());
    expect(plan.errors).toEqual([]);
    expect(plan.patch.get(a.id)).toMatchObject({ style: { color: "red" }, x: 10, y: 20, w: 100, h: 90 });
    expect(String(plan.patch.get(a.id)!.z) > "a9").toBe(true);
    expect(plan.patch.get(b.id)).toMatchObject({ text: "renamed", style: { pin: true } });
    expect(plan.patch.get(c.id)).toMatchObject({ shape: "elbow", style: { color: "green" } });
  });
  it("Verbindung mit Farbe und Linie, Rahmen mit Farbe, Hintergrund", () => {
    const plan = planBoardScript("note a: 1\nnote b: 2\na -> b: go {color=red line=straight}\nframe f: Group { a b } {color=green}\nbackground grid", [], ids());
    expect(plan.errors).toEqual([]);
    const conn = plan.add.find((o) => o.kind === "connector") as WBConnector;
    expect(conn).toMatchObject({ shape: "straight", style: { color: "red" }, label: "go" });
    expect(plan.add.find((o) => o.kind === "frame")!.style).toMatchObject({ color: "green" });
    expect(plan.background).toBe("grid");
  });
});

describe("Skript: kopieren und Rahmen verschieben", () => {
  const frame: WBShape = { id: "ffff0000", kind: "frame", z: "a0", x: 0, y: 0, w: 500, h: 300, rot: 0, text: "F" };
  const a = { ...note("aaaa1111", 20, "A"), y: 60 }, b = { ...note("bbbb2222", 250, "B"), y: 60 };
  const c: WBConnector = { id: "cccc3333", kind: "connector", z: "a9", from: { id: a.id, side: "auto" }, to: { id: b.id, side: "auto" }, shape: "curved", label: "then" };
  const outside = note("dddd4444", 900, "D");
  it("copy wie ⌘D, mit at=, ein Rahmen mit Inhalt und Verbindung; Name für Pfeile nutzbar", () => {
    const plan = planBoardScript("copy dddd as d2\ncopy ffff as f2 {at=0,600}\nd2 -> aaaa", [frame, a, b, c, outside], ids());
    expect(plan.errors).toEqual([]);
    const d2 = plan.add.find((o) => o.id === plan.names.get("d2")) as WBShape;
    expect(d2).toMatchObject({ x: 916, y: 16, text: "D", style: { agent: true } });
    const f2 = plan.add.filter((o) => o.kind !== "connector" && (o as WBShape).y >= 600) as WBShape[];
    expect(f2.map((o) => o.kind).sort()).toEqual(["frame", "note", "note"]);
    const lines = plan.add.filter((o) => o.kind === "connector") as WBConnector[];
    expect(lines).toHaveLength(2); // die mitkopierte Verbindung und d2 -> aaaa
    expect(lines.some((l) => l.label === "then" && f2.some((o) => o.id === l.from.id))).toBe(true);
  });
  it("copy von einem anderen Board kommt neben das Vorhandene; unbekanntes Board wird gemeldet", () => {
    const plan = planBoardScript("copy dddd as x {from=other}\ncopy dddd as y {from=nope}", [frame], ids(), { boardObjects: (id) => (id === "other" ? [outside] : undefined) });
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]).toMatch(/no board nope/);
    expect((plan.add[0] as WBShape).x).toBeGreaterThan(500);
  });
  it("set Rahmen {at=…} nimmt seinen Inhalt mit", () => {
    const plan = planBoardScript("set ffff {at=100,1000}", [frame, a, b, c, outside], ids());
    expect(plan.patch.get(a.id)).toEqual({ x: 120, y: 1060 });
    expect(plan.patch.get(b.id)).toEqual({ x: 350, y: 1060 });
    expect(plan.patch.has(outside.id)).toBe(false);
  });
});

describe("Skript: freies Zeichnen", () => {
  it("SVG-Pfad wird ein Strich je Teilpfad, mit Farbe und Breite; at=0,0 heißt Board-Koordinaten", () => {
    const plan = planBoardScript("ink s: M 100 100 L 200 100 M 100 150 Q 150 200 200 150 {color=red width=thick at=0,0}", [], ids());
    expect(plan.errors).toEqual([]);
    const strokes = plan.add as WBShape[];
    expect(strokes).toHaveLength(2);
    expect(strokes[0]).toMatchObject({ kind: "ink", style: { color: "red", width: 4.4, agent: true } });
    // Die Stelle folgt den Pfad-Koordinaten (Rand = halbe Breite des Stifts).
    expect(strokes[0]!.x).toBeGreaterThan(90);
    expect(strokes[0]!.x).toBeLessThan(100);
    const pts = decodeInk(strokes[1]!.ink!);
    expect(pts.length).toBeGreaterThan(5);
    expect(strokes[0]!.style!.bw).toBe(strokes[0]!.w);
  });
  it("Textmarker und Punktliste; ohne at= daneben gesetzt", () => {
    const old = note("aaaa1111", 0, "A");
    const plan = planBoardScript("ink h: 0,0 50,0 100,10 {tool=highlighter color=mint}", [old], ids());
    expect(plan.errors).toEqual([]);
    const s = plan.add[0] as WBShape;
    expect(s.style).toMatchObject({ tool: "hl", color: "mint", width: 16 });
    expect(s.x).toBeGreaterThan(168);
  });
  it("Pfad-Fehler werden genannt", () => {
    const plan = planBoardScript("ink a: M 0 0 L 10\nink b: 1,2,3\nink c: M 0 0 L 1 1 {color=mint}", [], ids());
    expect(plan.add).toHaveLength(0);
    expect(plan.errors).toHaveLength(3);
  });
  it("pathToStrokes: relative Befehle, H/V, Bogen, Z", () => {
    const [s] = pathToStrokes("m10 10 h 20 v 20 h -20 z");
    expect(s).toEqual([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 10 }]);
    const [arc] = pathToStrokes("M0 0 A 50 50 0 0 1 100 0", 10);
    expect(arc!.at(-1)).toEqual({ x: 100, y: 0 });
    expect(Math.min(...arc!.map((p) => p.y))).toBeLessThan(-40); // Halbkreis nach oben
  });
});

describe("Skript: Bilder und Dateien", () => {
  it("Bild in seiner Form, PDF eine Seite je Objekt, page= wählt eine Seite", () => {
    const plan = planBoardScript(`image i: ${IMG}\nfile p: ${PDF.slice(12)} {at=0,1000}\nfile q: ${PDF} {page=2}`, [], ids(), { files });
    expect(plan.errors).toEqual([]);
    const img = plan.add.find((o) => o.kind === "image") as WBShape;
    expect(img).toMatchObject({ w: 480, h: 240, ref: IMG, style: { name: "photo.png", agent: true } });
    const pages = plan.add.filter((o) => o.kind === "file") as WBShape[];
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({ x: 0, y: 1000, style: { view: "pdf", page: 1 } });
    expect(pages[1]!.y).toBeGreaterThan(pages[0]!.y + pages[0]!.h);
    expect(pages[2]!.style).toMatchObject({ page: 2 });
  });
  it("unbekannte Datei und Bild/Datei verwechselt: mit Grund übersprungen", () => {
    const plan = planBoardScript(`image a: based-asset:${"c".repeat(64)}\nimage b: ${PDF}`, [], ids(), { files });
    expect(plan.add).toHaveLength(0);
    expect(plan.errors[0]).toMatch(/list_files or upload_file/);
    expect(plan.errors[1]).toMatch(/not an image/);
  });
  it("Umriss zeigt Stil, Datei-Adresse und Hintergrund", () => {
    const plan = planBoardScript(`image i: ${IMG} {at=0,0}\nnote n: hi {color=red at=600,0}`, [], ids(), { files });
    const out = boardOutline(plan.add, () => undefined, "lines");
    expect(out).toContain("background lines");
    expect(out).toContain(`image "photo.png" ${IMG} @0,0 480x240 {agent}`);
    expect(out).toContain('note "hi" @600,0 168x150 {color=red agent}');
  });
});

describe("Dateien erkennen", () => {
  it("PNG, GIF, JPEG: Art und Maße aus den ersten Bytes", () => {
    const png = new Uint8Array(32); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); png.set([0, 0, 3, 0x20, 0, 0, 1, 0x90], 16);
    expect(sniffMime(png)).toBe("image/png");
    expect(sniffImageSize(png)).toEqual({ width: 800, height: 400 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]);
    expect(sniffImageSize(gif)).toEqual({ width: 10, height: 20 });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 70, 3, 0, 0, 0, 0]);
    expect(sniffImageSize(jpg)).toEqual({ width: 70, height: 50 });
  });
  it("PDF: Seitenzahl und Seitenmaß", () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Pages /Count 3 /MediaBox [0 0 612 792] >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n4 0 obj << /Type /Page >>");
    expect(sniffPdfPages(pdf)).toEqual([{ width: 612, height: 792 }, { width: 612, height: 792 }, { width: 612, height: 792 }]);
    expect(boardFileParts({ ref: "r", name: "x.pdf", mime: "application/pdf", size: 1, pages: sniffPdfPages(pdf)! })).toHaveLength(3);
  });
});
