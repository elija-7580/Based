// BSD-551: der geführte Einstieg (screens/WelcomeTour.tsx) – reine Teile ohne DOM, getestet in welcomeTour.test.ts.

export type TourStep = "basics" | "data" | "meetings" | "beta";

/** Die Schritte vor der Wahl („How do you want to start?“); Meeting-Notizen nur, wenn sie nicht ausgeblendet sind. */
export function tourSteps(o: { meetings: boolean }): TourStep[] {
  return ["basics", "data", ...(o.meetings ? (["meetings"] as const) : []), "beta"];
}

/**
 * Was eine Taste im Einstieg tut: → weiter, ← zurück, Escape wie „Skip“, Return weiter – Return aber nicht, wenn ein
 * Knopf oder Link den Fokus hat (der drückt sich selbst), und nichts, solange man in ein Feld tippt.
 */
export function tourKey(
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  target: { tagName?: string; isContentEditable?: boolean } | null,
): "next" | "back" | "skip" | undefined {
  if (e.metaKey || e.ctrlKey || e.altKey) return undefined;
  const tag = target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable === true) return undefined;
  if (e.key === "ArrowRight" && !e.shiftKey) return "next";
  if (e.key === "ArrowLeft" && !e.shiftKey) return "back";
  if (e.key === "Enter" && tag !== "button" && tag !== "a") return "next";
  if (e.key === "Escape") return "skip";
  return undefined;
}
