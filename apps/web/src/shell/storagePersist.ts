// ADR 0017, Stufe A3: dauerhaften Web-Speicher anfragen. Ohne Anfrage ist der Speicher einer Website „best effort“:
// der Browser darf ihn räumen (Platzmangel; Safari nach sieben Tagen Safari-Nutzung ohne Besuch der Seite). Mit
// `navigator.storage.persist()` nimmt der Browser die Seite davon aus – er entscheidet selbst und fragt nicht nach.
// In der Mac-App (Tauri) gehört der Speicher der App; dort wird nichts angefragt und nichts angezeigt.
// Angefragt wird nach der ersten echten Eingabe (Browser bewerten die Anfrage nach der Nutzung der Seite).

export type KeepState = "unknown" | "kept" | "notKept" | "unsupported";

interface StorageLike { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> }

/** Fragt an (bzw. liest nur, wenn `ask` false ist). Fehler gelten als „nicht zugesagt“, nie als Absturz. */
export async function resolveKeep(storage: StorageLike | undefined, ask: boolean): Promise<KeepState> {
  if (!storage?.persisted || !storage.persist) return "unsupported";
  try {
    if (await storage.persisted()) return "kept";
    if (!ask) return "notKept";
    return (await storage.persist()) ? "kept" : "notKept";
  } catch {
    return "notKept";
  }
}

/** Zeile in Einstellungen → Sync & server. `undefined`: nichts zeigen (noch unbekannt, oder der Browser kennt es nicht). */
export function keepRow(state: KeepState, hasServer: boolean): { value: string; hint: string } | undefined {
  if (state === "kept") return { value: "Protected", hint: "This browser keeps your workspace until you delete it yourself." };
  if (state !== "notKept") return undefined;
  return {
    value: "Not protected",
    hint: hasServer
      ? "Browsers may clear unused data. Your server keeps a copy."
      : "Browsers may clear unused data. Connect a server or export an archive.",
  };
}

let state: KeepState = "unknown";
const listeners = new Set<() => void>();
const set = (s: KeepState) => {
  if (s === state) return;
  state = s;
  for (const fn of [...listeners]) fn();
};

export const browserKeep = {
  get: (): KeepState => state,
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/**
 * Einmal je Start: Stand lesen, nach der ersten Eingabe anfragen. `win` für Tests austauschbar. Gibt die Abmeldung
 * zurück. Nicht in der Desktop-App aufrufen.
 */
export function installBrowserKeep(win: Pick<Window, "addEventListener" | "removeEventListener"> & { navigator: { storage?: StorageLike } }): () => void {
  const storage = win.navigator.storage;
  void resolveKeep(storage, false).then(set);
  let asked = false;
  const onInput = () => {
    if (asked) return;
    asked = true;
    off();
    if (state !== "kept") void resolveKeep(storage, true).then(set);
  };
  const off = () => {
    win.removeEventListener("pointerdown", onInput, true);
    win.removeEventListener("keydown", onInput, true);
  };
  win.addEventListener("pointerdown", onInput, true);
  win.addEventListener("keydown", onInput, true);
  return off;
}
