import { CORE_VERSION } from "@based/core";

// Phase 0: leere Hülle. Shell, Editor und Datenbanken folgen in Phase 2 (ADR 0011).
export function App() {
  return (
    <main data-testid="based-root">
      <h1>Based</h1>
      <p>Kern {CORE_VERSION}</p>
    </main>
  );
}
