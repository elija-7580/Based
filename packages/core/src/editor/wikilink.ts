// BSD-90 Teil 2 / BSD-407 Teil 3: „[[Titel]]“ fertig getippt (wie Obsidian) wird zur Seiten-Erwähnung. Rein, ohne DOM:
// der Editor fragt beim zweiten „]“, ob der Text vor der Schreibmarke auf „[[Titel]“ endet.

/** Text vor der Schreibmarke endet auf „[[Titel]“ (das zweite „]“ kommt gerade) → Titel und Anfang von „[[“. */
export function wikilinkBefore(text: string): { title: string; start: number } | undefined {
  const m = /\[\[([^[\]\n]{1,200})\]$/.exec(text);
  const title = m?.[1]?.trim();
  return m && title ? { title, start: m.index } : undefined;
}
