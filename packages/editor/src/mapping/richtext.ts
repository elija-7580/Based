// BSD-154: richText (Records) ⇄ Inline-Inhalt von BlockNote. Läufe mit Erwähnung werden zum Inline-Typ
// `mention`, Läufe mit `eq` zu `inlineEquation`, Links zu BlockNote-Links. Farben: `red` = Textfarbe,
// `redBackground` = Hintergrund (wie TColor in Swift).
import { canonicalStringify, type RichText, type TextRun } from "@based/core";
import { INLINE, type BNInline, type BNStyles, type BNText } from "./bn.js";

type Marks = NonNullable<TextRun["m"]>;
type Mention = NonNullable<TextRun["mention"]>;

/** TColor → BlockNote-Farben (Text oder Hintergrund). */
export function colorToBN(color: string | undefined | null): { textColor: string; backgroundColor: string } {
  if (!color || color === "default") return { textColor: "default", backgroundColor: "default" };
  if (color.endsWith("Background")) return { textColor: "default", backgroundColor: color.slice(0, -"Background".length) };
  return { textColor: color, backgroundColor: "default" };
}

/** BlockNote-Farben → TColor (Hintergrund gewinnt, Based kennt nur eine Farbe je Block). */
export function colorFromBN(textColor: unknown, backgroundColor: unknown): string | undefined {
  if (typeof backgroundColor === "string" && backgroundColor !== "default" && backgroundColor !== "") return backgroundColor + "Background";
  if (typeof textColor === "string" && textColor !== "default" && textColor !== "") return textColor;
  return undefined;
}

function marksToStyles(m: Marks | undefined): BNStyles {
  const s: BNStyles = {};
  if (!m) return s;
  if (m.b) s.bold = true;
  if (m.i) s.italic = true;
  if (m.u) s.underline = true;
  if (m.s) s.strike = true;
  if (m.c) s.code = true;
  const c = colorToBN(m.color);
  if (c.textColor !== "default") s.textColor = c.textColor;
  if (c.backgroundColor !== "default") s.backgroundColor = c.backgroundColor;
  return s;
}

function stylesToMarks(s: BNStyles | undefined, link?: string): Marks | undefined {
  const m: Marks = {};
  if (s?.bold) m.b = true;
  if (s?.italic) m.i = true;
  if (s?.underline) m.u = true;
  if (s?.strike) m.s = true;
  if (s?.code) m.c = true;
  const color = colorFromBN(s?.textColor, s?.backgroundColor);
  if (color) m.color = color;
  if (link) m.link = link;
  return Object.keys(m).length ? m : undefined;
}

/** Wert einer Erwähnung als String-Prop (Datum als kanonisches JSON). */
export function mentionToProps(mention: Mention): { kind: string; value: string } {
  const [kind, wrapped] = Object.entries(mention)[0] as [string, { _0: unknown }];
  const v = wrapped?._0;
  return { kind, value: typeof v === "string" ? v : canonicalStringify(v) };
}

export function mentionFromProps(kind: string, value: string): Mention | undefined {
  switch (kind) {
    case "page":
    case "user":
    case "link":
      return { [kind]: { _0: value } } as Mention;
    case "date":
      try {
        return { date: { _0: JSON.parse(value) } } as Mention;
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}

/** richText → BlockNote-Inline-Inhalt. */
export function richTextToInline(t: RichText | undefined): BNInline[] {
  if (t === undefined) return [];
  if (typeof t === "string") return t === "" ? [] : [{ type: "text", text: t, styles: {} }];
  const out: BNInline[] = [];
  for (const run of t) {
    if (run.mention) {
      out.push({ type: INLINE.mention, props: { ...mentionToProps(run.mention), text: run.t ?? "" } });
      continue;
    }
    if (run.eq !== undefined) {
      out.push({ type: INLINE.equation, props: { expression: run.eq, text: run.t ?? "" } });
      continue;
    }
    const text = run.t ?? "";
    if (text === "") continue;
    const styled: BNText = { type: "text", text, styles: marksToStyles(run.m) };
    const href = run.m?.link;
    if (href) {
      const last = out[out.length - 1];
      if (last && last.type === "link" && (last as { href: string }).href === href) (last as { content: BNText[] }).content.push(styled);
      else out.push({ type: "link", href, content: [styled] });
    } else out.push(styled);
  }
  return out;
}

/** BlockNote-Inline-Inhalt → richText (kanonisch: zusammengefasst, reiner Text als String, leer = undefined). */
export function inlineToRichText(content: unknown): RichText | undefined {
  if (typeof content === "string") return canonicalRichText(content);
  if (!Array.isArray(content)) return undefined;
  const runs: TextRun[] = [];
  for (const item of content as BNInline[]) {
    if (typeof item === "string") {
      runs.push({ t: item });
      continue;
    }
    if (item.type === "text") {
      const ti = item as BNText;
      const m = stylesToMarks(ti.styles);
      runs.push(m ? { t: ti.text, m } : { t: ti.text });
    } else if (item.type === "link") {
      const li = item as { href: string; content: BNText[] | string };
      const kids = typeof li.content === "string" ? [{ type: "text", text: li.content, styles: {} } as BNText] : li.content;
      for (const k of kids) runs.push({ t: k.text, m: stylesToMarks(k.styles, li.href)! });
    } else if (item.type === INLINE.mention) {
      const p = (item as { props: Record<string, unknown> }).props;
      const mention = mentionFromProps(String(p.kind ?? ""), String(p.value ?? ""));
      if (!mention) continue;
      const text = String(p.text ?? "");
      runs.push(text === "" ? { mention } : { t: text, mention });
    } else if (item.type === INLINE.equation) {
      const p = (item as { props: Record<string, unknown> }).props;
      const text = String(p.text ?? "");
      runs.push(text === "" ? { eq: String(p.expression ?? "") } : { t: text, eq: String(p.expression ?? "") });
    }
  }
  return canonicalRichText(runs);
}

/** Gleiche Bedeutung → gleiche Form: Läufe mit gleichen Marken zusammenfassen, ohne Marken als String. */
export function canonicalRichText(t: RichText | undefined): RichText | undefined {
  if (t === undefined) return undefined;
  if (typeof t === "string") return t === "" ? undefined : t;
  const out: TextRun[] = [];
  for (const run of t) {
    const r: TextRun = { ...run };
    if (r.m && Object.keys(r.m).length === 0) delete r.m;
    const plain = r.mention === undefined && r.eq === undefined;
    if (plain && (r.t ?? "") === "") continue;
    const last = out[out.length - 1];
    if (plain && last && last.mention === undefined && last.eq === undefined && canonicalStringify(last.m ?? {}) === canonicalStringify(r.m ?? {})
      && Object.keys(last).every((k) => k === "t" || k === "m") && Object.keys(r).every((k) => k === "t" || k === "m")) {
      out[out.length - 1] = { ...last, t: (last.t ?? "") + (r.t ?? "") };
      continue;
    }
    out.push(r);
  }
  if (out.length === 0) return undefined;
  if (out.every((r) => Object.keys(r).every((k) => k === "t"))) return out.map((r) => r.t ?? "").join("");
  return out;
}
