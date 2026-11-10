// BSD-225: „Ask AI“ im Editor über die Chat-Engines (BSD-159): eigener System-Prompt, ein Turn ohne Werkzeuge. Was
// gesendet wird, bestimmt aiPrompt (getestet); Seitentext nur als begrenzter Kontext.
import type { EditorAI } from "@based/editor";

export const EDITOR_AI_SYSTEM = "You write inside a notes app. Reply only with the text to insert, as Markdown, in the language of the page or selection. No preamble, no closing remarks, no code fences around the whole answer.";

export function aiPrompt(r: { prompt: string; selection?: string | undefined; page: string }): string {
  const parts = [`Instruction: ${r.prompt.trim()}`];
  if (r.selection?.trim()) parts.push(`Selected text:\n${r.selection.trim()}`);
  else if (r.page.trim()) parts.push(`The page so far (context only, do not repeat it):\n${r.page.trim().slice(0, 4000)}`);
  return parts.join("\n\n");
}

/** Antwort säubern: ein umschließender ```-Block (Markdown) wird entfernt. */
export function cleanAIText(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(t);
  return (m ? m[1]! : t).trim();
}

export function editorAI(write: (system: string, prompt: string, signal: AbortSignal) => Promise<string>, available?: () => boolean): EditorAI {
  return { write: async (r, signal) => cleanAIText(await write(EDITOR_AI_SYSTEM, aiPrompt(r), signal)), ...(available ? { available } : {}) };
}
