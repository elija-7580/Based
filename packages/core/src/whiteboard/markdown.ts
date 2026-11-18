// Markdown auf dem Board (Elija 18.11.: „In den Boards auch Markdown verwenden können – ganz wichtig.“).
// Text, Zettel und Formen speichern weiter reinen Text; die Fläche liest ihn als Markdown und zeichnet ihn formatiert.
// Bewusst ein kleiner, zeilenweiser Leser statt CommonMark: auf einem Board ist jeder Zeilenumbruch ein Umbruch
// (wie im Eingabefeld), und das Ergebnis muss pro Bild billig sein. Hier nur reine Logik (testbar), gezeichnet wird
// in packages/editor/src/whiteboard/render.ts.

/** Ein Stück Text mit einheitlicher Auszeichnung. */
export interface MdRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** ==markiert== */
  mark?: boolean;
  /** Ziel eines Links ([Text](Ziel) oder eine nackte https-Adresse). */
  link?: string;
}

export type MdBlock =
  | { type: "p"; runs: MdRun[]; line: number }
  | { type: "h"; level: 1 | 2 | 3; runs: MdRun[]; line: number }
  /** Listeneintrag; `depth` aus der Einrückung (2 Leerzeichen oder ein Tab je Stufe). `checked` nur bei Aufgaben. */
  | { type: "li"; ordered: boolean; marker: string; depth: number; checked?: boolean; runs: MdRun[]; line: number }
  | { type: "quote"; runs: MdRun[]; line: number }
  /** Eine Zeile eines Codeblocks (``` … ```); `first`/`last` für den Hintergrund. */
  | { type: "code"; text: string; first: boolean; last: boolean; line: number }
  | { type: "hr"; line: number }
  | { type: "blank"; line: number };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

const depthOf = (indent: string) => {
  let cols = 0;
  for (const c of indent) cols += c === "\t" ? 2 : 1;
  return Math.min(6, Math.floor(cols / 2));
};

/** Text als Markdown lesen: ein Block je Zeile (Codeblöcke: je Zeile ein Code-Block). */
export function parseMarkdown(text: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = text.split("\n");
  let fence: string | undefined;
  let fenceStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, "");
    if (fence !== undefined) {
      if (raw.trimStart().startsWith(fence)) {
        // Schließende Zaunzeile: der letzte Code-Block bekommt das Ende; ein leerer Block bleibt als eine leere Zeile.
        const last = out[out.length - 1];
        if (last && last.type === "code" && out.length - 1 >= fenceStart) last.last = true;
        else out.push({ type: "code", text: "", first: true, last: true, line: i });
        fence = undefined;
        continue;
      }
      out.push({ type: "code", text: raw.replace(/\t/g, "  "), first: out.length === fenceStart, last: false, line: i });
      continue;
    }
    const f = FENCE.exec(raw);
    if (f) { fence = f[1]!; fenceStart = out.length; continue; }
    if (raw.trim() === "") { out.push({ type: "blank", line: i }); continue; }
    if (HR.test(raw)) { out.push({ type: "hr", line: i }); continue; }
    let m = HEADING.exec(raw);
    if (m) { out.push({ type: "h", level: Math.min(3, m[1]!.length) as 1 | 2 | 3, runs: parseInline(m[2]!), line: i }); continue; }
    m = TASK.exec(raw);
    if (m) { out.push({ type: "li", ordered: false, marker: "", depth: depthOf(m[1]!), checked: m[2] !== " ", runs: parseInline(m[3]!), line: i }); continue; }
    m = BULLET.exec(raw);
    if (m) { out.push({ type: "li", ordered: false, marker: "•", depth: depthOf(m[1]!), runs: parseInline(m[2]!), line: i }); continue; }
    m = ORDERED.exec(raw);
    if (m) { out.push({ type: "li", ordered: true, marker: `${Number(m[2])}.`, depth: depthOf(m[1]!), runs: parseInline(m[3]!), line: i }); continue; }
    m = QUOTE.exec(raw);
    if (m) { out.push({ type: "quote", runs: parseInline(m[1]!), line: i }); continue; }
    out.push({ type: "p", runs: parseInline(raw), line: i });
  }
  // Nicht geschlossener Zaun (wird gerade getippt): bis zum Ende Code.
  if (fence !== undefined) {
    const last = out[out.length - 1];
    if (last && last.type === "code" && out.length - 1 >= fenceStart) last.last = true;
  }
  return out;
}

type Style = Omit<MdRun, "text">;
const PAIRS: readonly [string, keyof Style][] = [["**", "bold"], ["__", "bold"], ["~~", "strike"], ["==", "mark"], ["*", "italic"], ["_", "italic"]];
const URL = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;

/** Auszeichnungen innerhalb einer Zeile lesen: **fett**, *kursiv*, `Code`, ~~durch~~, ==markiert==, [Link](Ziel). */
export function parseInline(src: string, style: Style = {}): MdRun[] {
  const out: MdRun[] = [];
  let buf = "";
  const flush = () => { if (buf) { push(out, { ...style, text: buf }); buf = ""; } };
  let i = 0;
  outer: while (i < src.length) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length && /[\\`*_~=[\]()#>+\-.!|]/.test(src[i + 1]!)) { buf += src[i + 1]; i += 2; continue; }
    if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n += 1;
      const tick = "`".repeat(n);
      const close = src.indexOf(tick, i + n);
      if (close > i + n - 1 && close !== -1) {
        let body = src.slice(i + n, close);
        if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ")) body = body.slice(1, -1);
        flush();
        push(out, { ...style, code: true, text: body });
        i = close + n;
        continue;
      }
    }
    if (c === "[") {
      const end = closingBracket(src, i);
      if (end !== -1 && src[end + 1] === "(") {
        const close = src.indexOf(")", end + 2);
        if (close !== -1) {
          const target = src.slice(end + 2, close).trim().split(/\s+/)[0] ?? "";
          const label = src.slice(i + 1, end);
          flush();
          for (const r of parseInline(label || target, { ...style, link: target })) push(out, r);
          i = close + 1;
          continue;
        }
      }
    }
    if (c === "h" && !style.link && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const u = URL.exec(src.slice(i));
      if (u) { flush(); push(out, { ...style, link: u[0], text: u[0] }); i += u[0].length; continue; }
    }
    for (const [d, key] of PAIRS) {
      if (!src.startsWith(d, i) || style[key]) continue;
      // Öffnen nur vor einem Nicht-Leerzeichen; „_“ nicht mitten im Wort (snake_case bleibt Text).
      const after = src[i + d.length];
      if (after === undefined || /\s/.test(after)) continue;
      if (d[0] === "_" && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]!)) continue;
      const close = findClose(src, d, i + d.length);
      if (close === -1) continue;
      flush();
      for (const r of parseInline(src.slice(i + d.length, close), { ...style, [key]: true })) push(out, r);
      i = close + d.length;
      continue outer;
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

function closingBracket(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "\\") { j += 1; continue; }
    if (src[j] === "[") depth += 1;
    else if (src[j] === "]" && --depth === 0) return j;
  }
  return -1;
}

function findClose(src: string, d: string, from: number): number {
  for (let j = from; j <= src.length - d.length; j++) {
    if (src[j] === "\\") { j += 1; continue; }
    if (src[j] === "`") { const k = src.indexOf("`", j + 1); if (k !== -1) { j = k; continue; } }
    if (!src.startsWith(d, j) || j === from) continue;
    if (/\s/.test(src[j - 1]!)) continue;
    // „*“ darf nicht das erste Zeichen eines „**“ sein (sonst schließt *a **b** c* zu früh).
    if (d.length === 1 && src[j + 1] === d && src[j - 1] !== d) { j += 1; continue; }
    if (d[0] === "_" && /[\p{L}\p{N}]/u.test(src[j + d.length] ?? "")) continue;
    // „***x***“: das doppelte Zeichen schließt am Ende der Reihe, das innere einfache bleibt für kursiv.
    if (d.length === 2) while (src[j + 2] === d[0]) j += 1;
    return j;
  }
  return -1;
}

const same = (a: MdRun, b: MdRun) => a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.strike === b.strike && a.mark === b.mark && a.link === b.link;
function push(out: MdRun[], r: MdRun) {
  if (r.text === "") return;
  const clean: MdRun = { text: r.text };
  for (const k of ["bold", "italic", "code", "strike", "mark"] as const) if (r[k]) clean[k] = true;
  if (r.link) clean.link = r.link;
  const last = out[out.length - 1];
  if (last && same(last, clean)) last.text += clean.text; else out.push(clean);
}

/** Schreibt der Text überhaupt Markdown? (Sonst bleibt die Fläche beim schnellen, schlichten Zeichnen.) */
export function hasMarkdown(text: string): boolean {
  return /[*_`~=[#>]|^\s*([-+]|\d+[.)])\s|https?:\/\/|^\s*(---|\*\*\*|___)\s*$/m.test(text);
}

/** Aufgabe in Zeile `line` abhaken bzw. wieder öffnen; unverändert, wenn dort keine Aufgabe steht. */
export function toggleTask(text: string, line: number): string {
  const lines = text.split("\n");
  const l = lines[line];
  if (l === undefined) return text;
  const m = /^(\s*[-*+]\s+\[)([ xX])(\].*)$/.exec(l);
  if (!m) return text;
  lines[line] = `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}`;
  return lines.join("\n");
}

/** Text ohne Auszeichnung (Suche, Vorlesen, Agenten-Umriss). */
export function markdownPlain(text: string): string {
  return parseMarkdown(text).map((b) => {
    switch (b.type) {
      case "blank": case "hr": return "";
      case "code": return b.text;
      case "li": return `${b.checked === undefined ? (b.ordered ? `${b.marker} ` : "• ") : b.checked ? "☑ " : "☐ "}${b.runs.map((r) => r.text).join("")}`;
      default: return b.runs.map((r) => r.text).join("");
    }
  }).join("\n");
}

/**
 * Was Enter in einer Listenzeile tippt: die Fortsetzung („- “, „2. “, „- [ ] “) oder – auf einer leeren Listenzeile –
 * das Ende der Liste. `undefined`: keine Liste, normales Enter.
 */
export function continueList(line: string): { insert: string } | { end: true } | undefined {
  const m = /^(\s*)([-*+]\s+\[[ xX]\]|[-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(line) ?? /^(\s*)([-*+]\s+\[[ xX]\]|[-*+]|\d{1,9}[.)])()$/.exec(line);
  if (!m) {
    const q = /^(\s{0,3}>\s?)(.*)$/.exec(line);
    if (!q) return undefined;
    return q[2]!.trim() === "" ? { end: true } : { insert: q[1]! };
  }
  if ((m[4] ?? "").trim() === "") return { end: true };
  const mark = m[2]!;
  const num = /^(\d+)([.)])$/.exec(mark);
  const next = num ? `${Number(num[1]) + 1}${num[2]}` : /\[[ xX]\]$/.test(mark) ? mark.replace(/\[[ xX]\]$/, "[ ]") : mark;
  return { insert: `${m[1]}${next}${m[3] || " "}` };
}
