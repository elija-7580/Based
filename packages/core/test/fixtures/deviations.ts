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

/** Datei (relativ zu fixtures/) → Fallname → Abweichung. */
export const DEVIATIONS: Record<string, Record<string, Deviation>> = {
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
    "parse: Einrückung nach Code (Swift: Code-Block fällt weg)": {
      reason: "BSD-183: Code-Block vor eingerückter Zeile bleibt erhalten",
      output: (swift) =>
        withBlocks(swift, [b("code", "x", [], { language: "plain text" }), b("text", "indented after code"), b("text", "next")]),
    },
  },
};
