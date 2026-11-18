// Bewusste Abweichungen des TS-Ports von den Golden Fixtures (Swift-Verhalten, das TS absichtlich NICHT nachbildet).
// Die Fixture-Dateien selbst bleiben unverändert (sie werden aus Swift erzeugt); der Runner vergleicht für die
// hier aufgeführten Fälle gegen `output(swift)` statt gegen das Swift-Ergebnis. Jeder Eintrag nennt den Backlog-Eintrag.

export interface Deviation {
  /** Backlog-Eintrag und kurze Begründung. */
  reason: string;
  /** Erwartetes TS-Ergebnis, abgeleitet vom Swift-Ergebnis des Falls. */
  output: (swift: unknown) => unknown;
}

type Block = { type: string; text: string; children: Block[]; props?: Record<string, unknown> };
const b = (type: string, text = "", children: Block[] = [], props?: Record<string, unknown>): Block =>
  props ? { type, text, children, props } : { type, text, children };
const withBlocks = (swift: unknown, blocks: Block[]) => ({ ...(swift as object), blocks });

const mapBlocks = (swift: unknown, f: (x: Block) => Block) => {
  const walk = (list: Block[]): Block[] => list.map((x) => f({ ...x, children: walk(x.children) }));
  return withBlocks(swift, walk((swift as { blocks: Block[] }).blocks));
};

/** Datei (relativ zu fixtures/) → Fallname → Abweichung. */
export const DEVIATIONS: Record<string, Record<string, Deviation>> = {
  "export/export.utc.json": {
    // Swift schreibt „<tag>“ aus dem Text unverändert ins Markdown – ein Leser (und der Import) nimmt es als HTML.
    "Markdown: p-root": {
      reason: "Prüfung Pass 37 (Markdown-Export escapt HTML-artige Tags): „<tag>“ im Text wird „\\<tag>“",
      output: (swift) => (swift as string).replace(/(\*\*fett\*\*.*?) <tag>/, "$1 \\<tag>"),
    },
  },
  "import/markdown.utc.json": {
    // Swift entnimmt mit `out.popLast()` den Vorgänger einer eingerückten Zeile auch dann, wenn er keine Kinder
    // haben kann – der Block geht verloren (Datenverlust beim Import).
    "parse: Einrückung und Trenner": {
      reason: "BSD-183: dritter Trenner (___) vor eingerückter Liste bleibt erhalten",
      output: (swift) =>
        withBlocks(swift, [
          b("text", "para", [b("text", "indented child")]),
          b("divider"),
          b("divider"),
          b("divider"),
          b("bulletedList", "indented list", [b("bulletedList", "child")]),
        ]),
    },
    "parse: Listen": {
      reason: "BSD-563 (Import-Prüfung): „* [X]“ und eigene Aufgaben-Zustände („- [/]“) sind Aufgaben, kein Aufzählungspunkt mit „[X]“ im Text",
      output: (swift) => mapBlocks(swift, (x) => (x.type === "bulletedList" && x.text === "[X] DONE" ? { ...x, type: "todo", text: "DONE", props: { checked: true } } : x)),
    },
    "parse: Zitat und Hinweise": {
      reason: "BSD-563 (Import-Prüfung): eigene Hinweis-Arten („> [!unknown] x“, in Obsidian erlaubt) werden ein neutraler Hinweis statt eines Zitats mit „[!unknown]“",
      output: (swift) => mapBlocks(swift, (x) => (x.type === "quote" && x.text === "[!unknown] x" ? { ...x, type: "callout", text: "x", props: { icon: "💡", color: "grayBackground" } } : x)),
    },
    "Einzelne Markdown- und CSV-Dateien": {
      reason: "BSD-563 (Import-Prüfung): eine .txt-Datei heißt als Seite „Readme“, nicht „Readme.txt“",
      output: (swift) => JSON.parse(JSON.stringify(swift).replace('"text":"Readme.txt"', '"text":"Readme"')) as unknown,
    },
    "parse: Einrückung nach Code (Swift: Code-Block fällt weg)": {
      reason: "BSD-183: Code-Block vor eingerückter Zeile bleibt erhalten",
      output: (swift) =>
        withBlocks(swift, [b("code", "x", [], { language: "plain text" }), b("text", "indented after code"), b("text", "next")]),
    },
  },
};
