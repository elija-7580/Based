// Schrittanzeige (docs/design/elements.md, Abschnitt 4): zeigt in einem geführten Ablauf (Einstieg, BSD-551), wo man
// steht – eine Reihe Punkte, nicht anklickbar. Erledigte und aktueller Schritt in Tinte, kommende `selected`; der
// aktuelle ist eine kurze Pille. Keine Bewegung. Screenreader hören „Step 2 of 5“.
export interface BasedStepsProps {
  /** Zahl der Schritte (2–7). */
  count: number;
  /** Aktueller Schritt, ab 0. */
  current: number;
  testID?: string;
}

export function stepsLabel(current: number, count: number): string {
  return `Step ${Math.min(Math.max(current, 0), count - 1) + 1} of ${count}`;
}

export function BasedSteps({ count, current, testID }: BasedStepsProps) {
  return (
    <span className="based-steps" role="img" aria-label={stepsLabel(current, count)} data-testid={testID}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="based-steps-dot" data-state={i < current ? "done" : i === current ? "current" : "next"} />
      ))}
    </span>
  );
}
