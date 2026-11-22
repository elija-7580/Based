// BSD-482: Eine eben angelegte Seite bekommt die Schreibmarke im Titel (wie Notion) – nur beim ersten Zeigen dieser
// Seite, damit normales Öffnen (Seitenleiste, ⌘K, Zurück) keinen Fokus stiehlt.
//
// BSD-645: Zwischen „neue Seite“ und dem Fokus im Titel vergeht Zeit (Worker legt an, Seite lädt). Was man darin tippt,
// ging verloren oder landete im Titel der vorigen Seite. `beginFreshPage` fängt diese Tasten auf, der neue Titel
// übernimmt sie (`takeTypedAhead`): Zeichen und ⌫ für den Titel, nach Enter für die erste Zeile des Textes.

let pending: string | undefined;

/** Neue Seite vormerken: Das Titelfeld dieser Seite holt sich beim ersten Zeigen den Fokus. */
export function markFreshPage(id: string): void {
  pending = id;
}

/** Ist diese Seite gerade neu angelegt? Gibt einmal `true` und vergisst sie dann. */
export function takeFreshPage(id: string): boolean {
  if (pending !== id) return false;
  pending = undefined;
  return true;
}

/** Im Fenster Getipptes: Titel und – wenn Enter kam – die erste Zeile des Textes. */
export interface TypedAhead {
  title: string;
  body?: string;
}

/** Was mit einem Tastendruck im Fenster passiert: aufnehmen, durchlassen (Fenster bleibt offen) oder Fenster schließen. */
export type TypeAheadStep = "take" | "pass" | "stop";

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "isComposing">;

const MODIFIERS = new Set(["Shift", "Alt", "AltGraph", "Meta", "Control", "CapsLock", "Fn"]);

/**
 * Einen Tastendruck auf das Getippte anwenden. Zeichen und ⌫ gehen in die laufende Zeile, das erste Enter wechselt vom
 * Titel in den Text. Kürzel (⌘/Strg), Esc, Tab, Pfeile, Eingabemethoden (IME) und ein zweites Enter beenden das Fenster –
 * dann gilt wieder, wo der Fokus ist.
 */
export function typeAheadStep(t: TypedAhead, e: KeyLike): TypeAheadStep {
  if (MODIFIERS.has(e.key)) return "pass";
  if (e.isComposing || e.metaKey || e.ctrlKey) return "stop";
  const line = t.body === undefined ? "title" : "body";
  if (e.key === "Backspace") {
    if (t[line]) t[line] = [...t[line]!].slice(0, -1).join("");
    else if (line === "body") return "stop";
    return "take";
  }
  if (e.key === "Enter") {
    if (line === "body") return "stop";
    t.body = "";
    return "take";
  }
  if ([...e.key].length !== 1) return "stop";
  t[line] = (t[line] ?? "") + e.key;
  return "take";
}

/** Länger wartet niemand auf eine neue Seite; danach gelten die Tasten wieder, wo der Fokus ist. */
const WINDOW_MS = 3000;

const CAPTURE = { capture: true } as const;

let typed: TypedAhead | undefined;
let release: (() => void) | undefined;

function stopCapture(): void {
  release?.();
  release = undefined;
}

/**
 * Eine neue Seite wird gleich angelegt: Tasten ab jetzt auffangen, bis der neue Titel sie übernimmt
 * (`takeTypedAhead`), `cancelFreshPage` kommt, man klickt oder das Fenster abläuft.
 */
export function beginFreshPage(target: Window = window): void {
  stopCapture();
  const t: TypedAhead = { title: "" };
  typed = t;
  const onKey = (e: KeyboardEvent) => {
    const step = typeAheadStep(t, e);
    if (step === "take") {
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (step === "stop") stopCapture();
  };
  const onPointer = () => stopCapture();
  const timer = setTimeout(stopCapture, WINDOW_MS);
  target.addEventListener("keydown", onKey, CAPTURE);
  target.addEventListener("pointerdown", onPointer, CAPTURE);
  release = () => {
    clearTimeout(timer);
    target.removeEventListener("keydown", onKey, CAPTURE);
    target.removeEventListener("pointerdown", onPointer, CAPTURE);
  };
}

/** Anlegen ist gescheitert: nichts mehr auffangen, Getipptes verwerfen. */
export function cancelFreshPage(): void {
  stopCapture();
  typed = undefined;
}

/**
 * Der neue Titel ist da: das Getippte (falls etwas) einmal hergeben. Kam schon Enter, fängt es weiter auf (der Text der
 * Seite ist evtl. noch nicht bereit) und `body` wächst weiter, bis `stopTypedAhead` kommt; sonst endet das Auffangen.
 */
export function takeTypedAhead(): TypedAhead | undefined {
  const t = typed;
  typed = undefined;
  if (t?.body === undefined) stopCapture();
  return t && (t.title || t.body !== undefined) ? t : undefined;
}

/** Der Text der Seite hat die Schreibmarke: ab jetzt gehen die Tasten wieder dorthin, wo der Fokus ist. */
export function stopTypedAhead(): void {
  stopCapture();
}
