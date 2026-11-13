// BSD-209: Kleiner, schneller Syntax-Hervorheber für Codeblöcke (Swift `SyntaxHighlighter`): Schlüsselwörter,
// Strings, Kommentare, Zahlen, Typen, Funktionsaufrufe, Properties. Kein Parser, ein Durchlauf von links nach rechts –
// billig beim Tippen und nie ein Fehler bei kaputtem Code. Bereiche in UTF-16 (= JS-String-Indizes, wie NSString).

export type SyntaxKind = "keyword" | "string" | "comment" | "number" | "type" | "function" | "property";

export interface SyntaxToken {
  /** UTF-16-Offset (JS-String-Index). */
  from: number;
  length: number;
  kind: SyntaxKind;
}

interface Grammar {
  keywords: ReadonlySet<string>;
  lineComments: readonly string[];
  blockComment?: readonly [string, string];
  stringQuotes: string;
  capitalizedAreTypes: boolean;
}

const C_LIKE = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "true", "false",
  "null", "new", "try", "catch", "finally", "throw", "class", "struct", "enum", "const", "static", "public", "private",
  "protected", "import", "void"];

const g = (keywords: readonly string[], lineComments: readonly string[], blockComment?: readonly [string, string], opts: { quotes?: string; types?: boolean } = {}): Grammar => ({
  keywords: new Set(keywords), lineComments, ...(blockComment ? { blockComment } : {}), stringQuotes: opts.quotes ?? "\"'", capitalizedAreTypes: opts.types ?? true,
});

const SWIFT = g([...C_LIKE, "let", "var", "func", "guard", "in", "extension", "protocol", "self", "Self", "nil", "init", "deinit",
  "where", "async", "await", "throws", "rethrows", "inout", "some", "any", "as", "is", "defer", "fileprivate", "internal", "open",
  "final", "override", "mutating", "weak", "unowned", "lazy", "typealias", "associatedtype", "actor", "nonisolated", "repeat",
  "fallthrough", "subscript", "operator"], ["//"], ["/*", "*/"]);
const C_FAMILY = g([...C_LIKE, "let", "var", "function", "func", "fn", "def", "in", "of", "this", "super", "extends", "implements",
  "interface", "type", "async", "await", "yield", "export", "from", "as", "undefined", "typeof", "instanceof", "delete", "package",
  "go", "defer", "chan", "map", "range", "select", "struct", "impl", "trait", "mut", "pub", "use", "mod", "match", "loop", "where",
  "self", "Self", "int", "long", "float", "double", "char", "bool", "boolean", "string", "auto", "unsigned", "signed", "sizeof",
  "namespace", "using", "template", "typename", "virtual", "override", "readonly", "abstract", "final", "val", "fun", "object",
  "when", "nil", "None", "elif", "lambda"], ["//"], ["/*", "*/"], { quotes: "\"'`" });
const PYTHON = g(["def", "class", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "return", "import", "from",
  "as", "with", "try", "except", "finally", "raise", "pass", "break", "continue", "lambda", "yield", "None", "True", "False",
  "global", "nonlocal", "assert", "del", "async", "await", "self", "match", "case"], ["#"]);
const RUBY = g(["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return",
  "yield", "nil", "true", "false", "self", "require", "case", "when", "then", "begin", "rescue", "ensure", "and", "or", "not",
  "function", "NULL", "TRUE", "FALSE", "defmodule", "defp", "fn"], ["#"]);
const SHELL = g(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "return",
  "export", "local", "echo", "cd", "sudo", "true", "false", "FROM", "RUN", "CMD", "COPY", "ADD", "ENV", "WORKDIR", "EXPOSE",
  "ENTRYPOINT", "ARG"], ["#"], undefined, { types: false });
const SQL_WORDS = ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create",
  "table", "index", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit",
  "as", "distinct", "null", "is", "in", "primary", "key", "default", "union", "all", "case", "when", "then", "else", "end", "with",
  "returning", "exists"];
const SQL = g([...SQL_WORDS, ...SQL_WORDS.map((w) => w.toUpperCase())], ["--"], ["/*", "*/"], { types: false });
const JSON_G = g(["true", "false", "null"], [], undefined, { types: false });
const CSS_G = g(["important", "media", "import", "from", "to", "and", "not"], ["//"], ["/*", "*/"], { types: false });
const FALLBACK = g(C_LIKE, ["//", "#"], ["/*", "*/"]);

const BY_LANGUAGE = new Map<string, Grammar | null>();
const set = (names: string, gr: Grammar | null) => names.split(" ").forEach((n) => BY_LANGUAGE.set(n, gr));
set("swift", SWIFT);
set("javascript js typescript ts jsx tsx java kotlin c c++ cpp c# csharp go rust dart scala php objective-c groovy graphql solidity", C_FAMILY);
set("python py", PYTHON);
set("ruby rb elixir r", RUBY);
set("bash shell sh zsh docker dockerfile makefile yaml yml toml nix", SHELL);
set("sql", SQL);
set("json", JSON_G);
set("css scss less", CSS_G);
for (const n of ["html", "xml", "markdown", "mermaid", "plain text", "text", "", "diff"]) BY_LANGUAGE.set(n, null);

function grammar(language: string | undefined): Grammar | null {
  const key = (language ?? "").toLowerCase();
  const hit = BY_LANGUAGE.get(key);
  return hit === undefined ? FALLBACK : hit;
}

const isIdentStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 64;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdent = (c: number) => isIdentStart(c) || isDigit(c);

/** Tokens für `code` in `language` (Klartext und unbekannte Klartext-Sprachen: keine). */
export function syntaxTokens(code: string, language: string | undefined): SyntaxToken[] {
  const gr = grammar(language);
  if (!gr) return [];
  const n = code.length;
  const out: SyntaxToken[] = [];
  const quotes = new Set([...gr.stringQuotes].map((q) => q.charCodeAt(0)));
  let i = 0;
  while (i < n) {
    const c = code.charCodeAt(i);
    if (gr.lineComments.some((lc) => code.startsWith(lc, i))) {
      let j = i;
      while (j < n && code.charCodeAt(j) !== 10) j++;
      out.push({ from: i, length: j - i, kind: "comment" });
      i = j;
      continue;
    }
    if (gr.blockComment && code.startsWith(gr.blockComment[0], i)) {
      const [open, close] = gr.blockComment;
      let j = i + open.length;
      while (j < n && !code.startsWith(close, j)) j++;
      j = Math.min(n, j + close.length);
      out.push({ from: i, length: j - i, kind: "comment" });
      i = j;
      continue;
    }
    if (quotes.has(c)) {
      let j = i + 1;
      while (j < n && code.charCodeAt(j) !== c) {
        if (code.charCodeAt(j) === 92) { j += 2; continue; } // Backslash
        if (code.charCodeAt(j) === 10 && c !== 96) break; // Zeilenende beendet ' und ", nicht `…`
        j++;
      }
      j = Math.min(n, j + 1);
      out.push({ from: i, length: j - i, kind: "string" });
      i = j;
      continue;
    }
    if (isDigit(c) && (i === 0 || !isIdent(code.charCodeAt(i - 1)))) {
      let j = i + 1;
      while (j < n && (isIdent(code.charCodeAt(j)) || code.charCodeAt(j) === 46)) j++; // 0x1F, 1_000, 3.14, 1e9
      out.push({ from: i, length: j - i, kind: "number" });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(code.charCodeAt(j))) j++;
      const word = code.slice(i, j);
      let k = j;
      while (k < n && code.charCodeAt(k) === 32) k++;
      if (gr.keywords.has(word) || (c === 64 && word.length > 1)) out.push({ from: i, length: j - i, kind: "keyword" });
      else if (k < n && code.charCodeAt(k) === 40) out.push({ from: i, length: j - i, kind: "function" });
      else if (gr.capitalizedAreTypes && c >= 65 && c <= 90 && word.length > 1) out.push({ from: i, length: j - i, kind: "type" });
      else if (i > 0 && code.charCodeAt(i - 1) === 46) out.push({ from: i, length: j - i, kind: "property" });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** Sprachen im Auswahlmenü des Codeblocks (Schlüssel = gespeicherte `language`, wie Swift/Notion). */
export const CODE_LANGUAGES: readonly { id: string; name: string; aliases?: readonly string[] }[] = [
  { id: "text", name: "Plain text", aliases: ["plain text", "plaintext", "txt"] },
  { id: "bash", name: "Bash", aliases: ["shell", "sh", "zsh"] },
  { id: "c", name: "C" },
  { id: "cpp", name: "C++", aliases: ["c++"] },
  { id: "csharp", name: "C#", aliases: ["c#", "cs"] },
  { id: "css", name: "CSS", aliases: ["scss", "less"] },
  { id: "diff", name: "Diff" },
  { id: "dockerfile", name: "Docker", aliases: ["docker"] },
  { id: "go", name: "Go" },
  { id: "graphql", name: "GraphQL" },
  { id: "html", name: "HTML" },
  { id: "java", name: "Java" },
  { id: "javascript", name: "JavaScript", aliases: ["js", "jsx"] },
  { id: "json", name: "JSON" },
  { id: "kotlin", name: "Kotlin" },
  { id: "markdown", name: "Markdown", aliases: ["md"] },
  { id: "mermaid", name: "Mermaid" },
  { id: "php", name: "PHP" },
  { id: "python", name: "Python", aliases: ["py"] },
  { id: "ruby", name: "Ruby", aliases: ["rb"] },
  { id: "rust", name: "Rust", aliases: ["rs"] },
  { id: "sql", name: "SQL" },
  { id: "swift", name: "Swift" },
  { id: "toml", name: "TOML" },
  { id: "typescript", name: "TypeScript", aliases: ["ts", "tsx"] },
  { id: "xml", name: "XML" },
  { id: "yaml", name: "YAML", aliases: ["yml"] },
];

const LANGUAGE_IDS: ReadonlyMap<string, string> = new Map(CODE_LANGUAGES.flatMap((l) => [[l.id, l.id] as const, ...(l.aliases ?? []).map((a) => [a, l.id] as const)]));

/**
 * BSD-343: Kurzname oder Schreibweise einer Sprache („js“, „TS“, „py“, „yml“, „c++“) → Schlüssel aus CODE_LANGUAGES,
 * damit die Sprachwahl im Codeblock nicht leer bleibt. Unbekanntes bleibt unverändert (wird nicht verworfen).
 */
export function codeLanguageID(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return LANGUAGE_IDS.get(raw.trim().toLowerCase()) ?? raw;
}
