// HTML lesen (Swift BasedCore Interop/HTMLImport.swift: HTMLNode, HTMLParser) und Hilfen für Text und URLs.
// Nachsichtiger Scanner über Unicode-Skalare, schließt <p>/<li> implizit wie Browser.

/** Swift `CharacterSet.whitespacesAndNewlines` (Zs, Tab, Zeilenumbrüche). */
const WS = /[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029]/u;
/** Swift `CharacterSet.newlines`. */
const NL = /[\n\v\f\r\u0085\u2028\u2029]/u;
const ALPHA = /\p{Alphabetic}/u;
const WHITE = /\p{White_Space}/u;

function trimSet(s: string, set: RegExp): string {
  const cps = Array.from(s);
  let a = 0, b = cps.length;
  while (a < b && set.test(cps[a]!)) a++;
  while (b > a && set.test(cps[b - 1]!)) b--;
  return cps.slice(a, b).join("");
}
/** Swift `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export const trimWS = (s: string) => trimSet(s, WS);
/** Swift `trimmingCharacters(in: .newlines)`. */
export const trimNewlines = (s: string) => trimSet(s, NL);
/** Swift `trimmingCharacters(in: .whitespaces)` (ohne Zeilenumbrüche). */
export const trimSpaces = (s: string) => trimSet(s, /[\p{Zs}\t]/u);
export const isBlank = (s: string) => trimWS(s).length === 0;

/** Swift `Character`s (Graphem-Cluster); robust gegen große Texte, siehe ../graphemes.ts. */
export { graphemes } from "../graphemes.js";

export class HTMLNode {
  tag: string;
  attrs: Map<string, string>;
  children: HTMLNode[];
  text: string;

  constructor(tag: string, attrs: Map<string, string> = new Map(), children: HTMLNode[] = [], text = "") {
    this.tag = tag; this.attrs = attrs; this.children = children; this.text = text;
  }

  /** Klassen in Dokumentreihenfolge (Swift: Set; bei mehreren Treffern nimmt der Port den ersten). */
  get classList(): string[] {
    const seen: string[] = [];
    for (const c of (this.attrs.get("class") ?? "").split(" ")) if (c && !seen.includes(c)) seen.push(c);
    return seen;
  }
  has(cls: string) { return this.classList.includes(cls); }
  get isText() { return this.tag === ""; }
  get elements() { return this.children.filter((c) => c.tag !== ""); }
  attr(name: string) { return this.attrs.get(name); }

  /** Tiefensuche, der Knoten selbst zuerst. */
  first(match: (n: HTMLNode) => boolean): HTMLNode | undefined {
    if (match(this)) return this;
    for (const c of this.children) {
      const f = c.first(match);
      if (f) return f;
    }
    return undefined;
  }
  all(match: (n: HTMLNode) => boolean): HTMLNode[] {
    const out: HTMLNode[] = [];
    const walk = (n: HTMLNode) => { if (match(n)) out.push(n); n.children.forEach(walk); };
    walk(this);
    return out;
  }

  /** Text, Leerraum zusammengefasst, `<br>` als Leerzeichen. */
  get textContent(): string {
    let s = "";
    const walk = (n: HTMLNode) => { if (n.tag === "") s += n.text; else if (n.tag === "br") s += " "; else n.children.forEach(walk); };
    walk(this);
    return trimWS(collapse(s));
  }

  /** Text wie geschrieben, `<br>` als Zeilenumbruch. */
  get rawText(): string {
    let s = "";
    const walk = (n: HTMLNode) => {
      if (n.tag === "") s += n.text; else if (n.tag === "br") s += "\n"; else if (n.tag !== "style" && n.tag !== "script") n.children.forEach(walk);
    };
    walk(this);
    return s;
  }

  get outerHTML(): string {
    if (this.tag === "") return escapeHTML(this.text);
    if (this.tag === "#root") return this.innerHTML;
    let s = "<" + this.tag;
    for (const k of [...this.attrs.keys()].sort(swiftLess)) s += " " + k + "=\"" + escapeHTML(this.attrs.get(k)!).replaceAll("\"", "&quot;") + "\"";
    if (VOID_TAGS.has(this.tag)) return s + "/>";
    return s + ">" + this.innerHTML + "</" + this.tag + ">";
  }
  get innerHTML(): string {
    if (RAW_TAGS.has(this.tag)) return this.children.map((c) => c.text).join("");
    return this.children.map((c) => c.outerHTML).join("");
  }

  /** Inline-Stil, z. B. `style("width")` für `style="width:240px"`. */
  style(property: string): string | undefined {
    const st = this.attrs.get("style");
    if (st === undefined) return undefined;
    for (const decl of st.split(";")) {
      if (!decl) continue;
      const i = decl.indexOf(":");
      if (i <= 0 || i === decl.length - 1) continue;
      const key = trimSpaces(decl.slice(0, i)), value = trimSpaces(decl.slice(i + 1));
      if (key.toLowerCase() === property) return value;
    }
    return undefined;
  }
}

/** Swift-String-Ordnung (Unicode-Skalare). */
function swiftLess(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!), y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

export const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link", "col", "source", "wbr", "area", "base", "embed", "param", "track"]);
export const RAW_TAGS = new Set(["script", "style", "textarea", "title"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’",
  lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", times: "×", middot: "·", bull: "•", rarr: "→", larr: "←", euro: "€",
};

function scalar(n: number): string | undefined {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
  return String.fromCodePoint(n);
}

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  const cs = Array.from(s);
  let out = "";
  let i = 0;
  while (i < cs.length) {
    if (cs[i] === "&") {
      let semi = -1;
      for (let k = i; k < Math.min(cs.length, i + 12); k++) if (cs[k] === ";") { semi = k; break; }
      if (semi >= 0) {
        const name = cs.slice(i + 1, semi).join("");
        let rep: string | undefined;
        if (name.startsWith("#x") || name.startsWith("#X")) {
          const h = name.slice(2);
          rep = /^\+?[0-9a-fA-F]+$/.test(h) ? scalar(parseInt(h, 16)) : undefined;
          if (rep !== undefined && parseInt(h, 16) > 0xffffffff) rep = undefined;
        } else if (name.startsWith("#") && name !== "#39") {
          const d = name.slice(1);
          rep = /^\+?[0-9]+$/.test(d) ? scalar(Number(d)) : undefined;
        } else {
          rep = Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : undefined;
        }
        if (rep !== undefined) { out += rep; i = semi + 1; continue; }
      }
    }
    out += cs[i];
    i++;
  }
  return out;
}

export const escapeHTML = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Leerraum (Leerzeichen, \n, \t, \r) zu einem Leerzeichen; „\r\n“ ist in Swift ein Zeichen und bleibt. */
export function collapse(s: string): string {
  let out = "";
  let lastSpace = false;
  const cs = Array.from(s);
  for (let i = 0; i < cs.length; i++) {
    const ch = cs[i]!;
    if (ch === "\r" && cs[i + 1] === "\n") { out += "\r\n"; i++; lastSpace = false; continue; }
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      if (!lastSpace) out += " ";
      lastSpace = true;
    } else { out += ch; lastSpace = false; }
  }
  return out;
}

export function parseHTML(html: string): HTMLNode {
  const s = Array.from(html);
  const stack: HTMLNode[] = [new HTMLNode("#root")];
  let i = 0;
  let text = "";
  const top = () => stack[stack.length - 1]!;

  const flushText = () => {
    if (!text) return;
    top().children.push(new HTMLNode("", new Map(), [], decodeEntities(text)));
    text = "";
  };
  const close = (tag: string) => {
    let idx = -1;
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.tag === tag) { idx = k; break; }
    if (idx <= 0) return;
    while (stack.length > idx) {
      const n = stack.pop()!;
      top().children.push(n);
    }
  };
  const starts = (p: string, k: number) => {
    let j = k;
    for (const c of p) { if (j >= s.length || s[j] !== c) return false; j++; }
    return true;
  };
  const isWhite = (c: string | undefined) => c !== undefined && WHITE.test(c);

  while (i < s.length) {
    const c = s[i]!;
    if (c !== "<") { text += c; i++; continue; }
    if (starts("<!--", i)) {
      flushText();
      let j = i + 4;
      while (j < s.length && !starts("-->", j)) j++;
      i = j + 3; continue;
    }
    if (i + 1 < s.length && (s[i + 1] === "!" || s[i + 1] === "?")) {
      flushText();
      while (i < s.length && s[i] !== ">") i++;
      i++; continue;
    }
    const closing = i + 1 < s.length && s[i + 1] === "/";
    let j = i + (closing ? 2 : 1);
    let name = "";
    while (j < s.length && (ALPHA.test(s[j]!) || (s[j]! >= "0" && s[j]! <= "9" && s[j]!.length === 1) || s[j] === "-")) { name += s[j]; j++; }
    if (!name) { text += c; i++; continue; }
    name = name.toLowerCase();
    flushText();
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (j < s.length && s[j] !== ">") {
      if (s[j] === "/") { selfClosing = true; j++; continue; }
      if (isWhite(s[j])) { j++; continue; }
      let key = "";
      while (j < s.length && !isWhite(s[j]) && s[j] !== "=" && s[j] !== ">" && s[j] !== "/") { key += s[j]; j++; }
      let value = "";
      while (j < s.length && isWhite(s[j])) j++;
      if (j < s.length && s[j] === "=") {
        j++;
        while (j < s.length && isWhite(s[j])) j++;
        if (j < s.length && (s[j] === "\"" || s[j] === "'")) {
          const q = s[j]; j++;
          while (j < s.length && s[j] !== q) { value += s[j]; j++; }
          j++;
        } else {
          while (j < s.length && !isWhite(s[j]) && s[j] !== ">") { value += s[j]; j++; }
        }
      }
      if (key) attrs.set(key.toLowerCase(), decodeEntities(value));
      selfClosing = false;
    }
    i = j + 1;
    if (closing) { close(name); continue; }
    const node = new HTMLNode(name, attrs);
    if (VOID_TAGS.has(name) || selfClosing) { top().children.push(node); continue; }
    if (RAW_TAGS.has(name)) {
      let k = i;
      while (k < s.length && !(s[k] === "<" && starts("</" + name, k))) k++;
      node.children = [new HTMLNode("", new Map(), [], s.slice(i, Math.min(k, s.length)).join(""))];
      top().children.push(node);
      while (k < s.length && s[k] !== ">") k++;
      i = k + 1;
      continue;
    }
    if (name === "li" && top().tag === "li") close("li");
    if (name === "p" && top().tag === "p") close("p");
    stack.push(node);
  }
  flushText();
  while (stack.length > 1) { const n = stack.pop()!; top().children.push(n); }
  return stack[0]!;
}

// MARK: URLs (Swift SafeURL, PageLink)

export const LINK_SCHEMES = new Set(["http", "https", "mailto", "based"]);

/** Schema (klein) oder undefined für relative Verweise; Steuerzeichen und Leerraum im Schema werden ignoriert. */
export function urlScheme(s: string): string | undefined {
  let scheme = "";
  for (const u of s) {
    const v = u.codePointAt(0)!;
    if (v <= 0x20 || v === 0x7f) continue;
    if (u === ":") return scheme ? scheme.toLowerCase() : undefined;
    if (u === "/" || u === "?" || u === "#") return undefined;
    if (!/^[A-Za-z0-9+\-.]$/.test(u)) return undefined;
    scheme += u;
  }
  return undefined;
}

/** `s`, wenn relativ oder mit erlaubtem Schema, sonst `#` (Swift `SafeURL.sanitize`). */
export function sanitizeURL(s: string, allowDataImages = false): string {
  const t = trimWS(s);
  const scheme = urlScheme(t);
  if (scheme === undefined) return t;
  if (LINK_SCHEMES.has(scheme)) return t;
  if (allowDataImages && scheme === "data") {
    const lower = t.toLowerCase();
    if (lower.startsWith("data:image/") && !lower.startsWith("data:image/svg")) return t;
  }
  return "#";
}

export const pageURL = (id: string) => `based://page/${id}`;

/** Grobe Nachbildung von Foundation `URL(string:)`: RFC-3986-Zerlegung, ungültige Zeichen → keine URL. */
function parseURL(s: string): { scheme?: string; host?: string; path: string; fragment?: string } | undefined {
  if (!s || /[\s"<>\\^`{|}]/u.test(s) || /[^\x21-\x7e]/.test(s)) return undefined;
  const m = /^(?:([A-Za-z][A-Za-z0-9+\-.]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/.exec(s);
  if (!m) return undefined;
  const r: { scheme?: string; host?: string; path: string; fragment?: string } = { path: m[3] ?? "" };
  if (m[1] !== undefined) r.scheme = m[1];
  if (m[2] !== undefined) {
    const auth = m[2].replace(/^.*@/, "").replace(/:\d*$/, "");
    if (auth) r.host = auth;
  }
  if (m[4] !== undefined) r.fragment = m[4];
  return r;
}

function lastPathComponent(path: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  try { return decodeURIComponent(parts[parts.length - 1]!); } catch { return parts[parts.length - 1]!; }
}

/** Seiten-ID aus `based://page/<id>`, Notion-URL (`…-<32 hex>`) oder roher ID (Swift `PageLink.id(from:)`). */
export function pageIDFromLink(raw: string): string | undefined {
  const s = trimWS(raw);
  let candidate = s;
  const u = parseURL(s);
  if (u) {
    if (u.scheme === "based") {
      candidate = u.host === "page" || u.host === "block" ? lastPathComponent(u.path) : (u.host ?? lastPathComponent(u.path));
    } else if (u.fragment) {
      candidate = u.fragment;
    } else if (lastPathComponent(u.path) && u.scheme !== undefined) {
      candidate = lastPathComponent(u.path);
    }
  }
  const m = /[0-9a-fA-F]{32}$/.exec(candidate);
  if (m) candidate = m[0];
  const hex = candidate.replaceAll("-", "").toLowerCase();
  if (hex.length !== 32 || !/^[0-9a-f]+$/.test(hex)) return candidate ? candidate : undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
