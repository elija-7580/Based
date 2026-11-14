// BSD-225 / BSD-407 Teil 6.6: Was beide Editoren für „Ask AI“ von der Shell brauchen (ohne BlockNote, bleibt nach Teil 4).

/** Was der Editor von der Shell für AI braucht. */
export interface EditorAI {
  /** Text (Markdown) zur Anweisung; `selection` = markierter Text, `page` = Text der Seite als Kontext. */
  write(request: { prompt: string; selection?: string | undefined; page: string }, signal: AbortSignal): Promise<string>;
  /** Ist ein Modell eingerichtet? Nur dann öffnet die Leertaste auf leerer Zeile das Feld (/AI und Formatleiste immer). */
  available?: (() => boolean) | undefined;
}

export const SELECTION_ACTIONS = [
  { label: "Improve writing", prompt: "Improve the writing of the selected text. Keep its meaning and language." },
  { label: "Fix spelling & grammar", prompt: "Fix spelling and grammar in the selected text. Change nothing else." },
  { label: "Make shorter", prompt: "Make the selected text shorter. Keep the key points." },
  { label: "Summarize", prompt: "Summarize the selected text in a few sentences." },
] as const;
