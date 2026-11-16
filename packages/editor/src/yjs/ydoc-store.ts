// Ablage der Y-Zustände je Dokument-Wurzel (Gerät: Store-Worker, Tests: Speicher). Früher Teil von session.ts
// (DocSession, BlockNote) – mit BSD-407 Teil 4c eigene Datei, weil CollabBinder und TextSession sie weiter brauchen.

/** Origin beim Laden eines gespeicherten Zustands. */
export const LOAD_ORIGIN = { source: "based-load" } as const;

/** Ablage der Y-Zustände (eine Datei/Zeile je Wurzel). */
export interface YDocStore {
  load(rootID: string): Uint8Array | undefined;
  save(rootID: string, state: Uint8Array): void;
  /**
   * BSD-220: Zustand vorab (asynchron) holen, z. B. aus dem Store-Worker; danach liefert `load` ihn synchron. Der
   * Editor wartet darauf, bevor er die Sitzung öffnet. Fehler gelten als „kein Zustand“ (die Records sind die Quelle).
   */
  prepare?(rootID: string): Promise<void>;
}

export class MemoryYDocStore implements YDocStore {
  private readonly states = new Map<string, Uint8Array>();
  load(rootID: string) {
    return this.states.get(rootID);
  }
  save(rootID: string, state: Uint8Array) {
    this.states.set(rootID, state);
  }
}
