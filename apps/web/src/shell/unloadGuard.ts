// BSD-336 (entschieden von Elija am 12.11.): Neuladen oder Schließen mitten in einem Befehl verlöre ihn – der Store-Tab
// speichert erst, wenn die Anfrage bei ihm angekommen ist. Solange eine Änderung unterwegs ist (meist Millisekunden),
// fragt das Fenster kurz nach; sonst nie.
export interface UnloadGuardTarget {
  addEventListener(type: "beforeunload", fn: (e: BeforeUnloadEvent) => void): void;
  removeEventListener(type: "beforeunload", fn: (e: BeforeUnloadEvent) => void): void;
}

export function installUnloadGuard(win: UnloadGuardTarget, unsaved: () => number): () => void {
  const fn = (e: BeforeUnloadEvent) => {
    if (unsaved() <= 0) return;
    e.preventDefault();
    // Ältere WebKit-Versionen fragen nur mit gesetztem returnValue nach.
    e.returnValue = "";
  };
  win.addEventListener("beforeunload", fn);
  return () => win.removeEventListener("beforeunload", fn);
}
