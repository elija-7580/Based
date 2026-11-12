// BSD-313: Eingabe der Coding-Konsole wie in Claude Code – reine Logik (testbar ohne DOM):
// „/“ am Anfang öffnet die Slash-Befehle des Agenten, „@“ vor dem Cursor sucht Dateien im Arbeitsordner,
// ⇧Tab schaltet durch die Modi des Agenten.
import type { AcpCommand } from "@based/brain";

/** Eingabe nach „/“, solange der Befehlsname getippt wird (noch kein Leerzeichen); sonst `undefined`. */
export function slashQuery(text: string): string | undefined {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1]! : undefined;
}

/** Befehle, deren Name mit der Eingabe beginnt, dann die, die sie enthalten (Name oder Beschreibung). */
export function filterCommands(commands: readonly AcpCommand[], query: string): AcpCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = commands.filter((c) => !starts.includes(c) && (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)));
  return [...starts, ...rest];
}

/** „@…“ direkt vor dem Cursor (am Anfang oder nach Leerraum): Start und Suchtext; sonst `undefined`. */
export function atQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : undefined;
}

/** Gewählte Datei: „@suche“ verschwindet aus dem Text (die Datei wird ein Chip), Cursor an die Stelle. */
export function removeAt(text: string, at: { start: number; query: string }): { text: string; caret: number } {
  const end = at.start + 1 + at.query.length;
  return { text: text.slice(0, at.start) + text.slice(end), caret: at.start };
}

/** Nächster Modus (⇧Tab), am Ende wieder vorn; ohne Modi `undefined`. */
export function nextMode(modes: readonly { id: string }[], current: string | undefined): string | undefined {
  if (modes.length === 0) return undefined;
  const i = modes.findIndex((m) => m.id === current);
  return modes[(i + 1) % modes.length]!.id;
}
