// BSD-482: Eine eben angelegte Seite bekommt die Schreibmarke im Titel (wie Notion) – nur beim ersten Zeigen dieser
// Seite, damit normales Öffnen (Seitenleiste, ⌘K, Zurück) keinen Fokus stiehlt.
//
// BSD-645: Zwischen „neue Seite“ und dem Fokus im Titel vergeht Zeit (Worker legt an, Seite lädt). Was man darin tippt,
// ging verloren oder landete im Titel der vorigen Seite. `beginFreshPage` fängt diese Tasten auf, der neue Titel
// übernimmt sie (`takeTypedAhead`): Zeichen und ⌫ für den Titel, nach Enter für die erste Zeile des Textes.

let pending: string | undefined;

/**
 * Neue Seite vormerken: Das Titelfeld dieser Seite holt sich beim ersten Zeigen den Fokus. Mit `token` (aus
 * `beginFreshPage`) gehört ihr auch das Getippte dieses Anlegens – BSD-654: ein inzwischen begonnenes neueres Anlegen
 * (zweimal ⌥⌘N) behält sein Getipptes und den Fokus.
 */
export function markFreshPage(id: string, token?: number): void {
  if (token !== undefined) {
    if (!session || session.token !== token) return;
    session.id = id;
  }
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
 * Titel in den Text. Kürzel (⌘/Strg), Esc, Tab, Pfeile und ein zweites Enter beenden das Fenster –
 * dann gilt wieder, wo der Fokus ist.
 */
export function typeAheadStep(t: TypedAhead, e: KeyLike): TypeAheadStep {
  // BSD-654: Tote Tasten (´ dann e) und Eingabemethoden: das alte Feld hat keinen Fokus mehr, also abwarten – was danach
  // als Zeichen kommt, wird aufgefangen; ein zusammengesetztes Zeichen kann dabei verloren gehen, nie in eine fremde Seite.
  if (MODIFIERS.has(e.key) || e.key === "Dead" || e.key === "Process" || e.isComposing) return "pass";
  if (e.metaKey || e.ctrlKey) return "stop";
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

/** Ein Anlegen: sein Getipptes, die Seite (sobald angelegt) und wie man das Auffangen beendet. */
interface Session {
  token: number;
  typed: TypedAhead;
  id?: string;
  release?: () => void;
  /** Feld, das beim Start den Fokus hatte (für ein gescheitertes Anlegen). */
  before?: HTMLElement;
  beforeValue?: string;
}

let session: Session | undefined;
let nextToken = 1;

function stopCapture(s: Session | undefined = session): void {
  s?.release?.();
  if (s) s.release = undefined;
}

/** Bearbeitbares Feld (Titel, Textfeld, Editor)? Dort dürfen aufgefangene Zeichen nicht mehr ankommen. */
function editable(el: Element | null): el is HTMLElement {
  if (!el || typeof HTMLElement === "undefined" || !(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit"].includes(el.type));
}

/**
 * Eine neue Seite wird gleich angelegt: Tasten ab jetzt auffangen, bis der neue Titel sie übernimmt
 * (`takeTypedAhead`), `cancelFreshPage` kommt, man klickt oder das Fenster abläuft. Gibt das Token dieses Anlegens
 * zurück (für `markFreshPage`/`cancelFreshPage`).
 * BSD-654: Ein Feld der vorigen Seite verliert sofort den Fokus – Zeichen ohne gewöhnlichen Tastendruck (tote Taste,
 * Eingabemethode, Emoji-Auswahl, Diktat) landen sonst dort. Text, der trotzdem als „beforeinput“ kommt, wird
 * aufgefangen, solange nicht das neue Feld den Fokus hat.
 */
export function beginFreshPage(target: Window = window): number {
  stopCapture();
  const t: TypedAhead = { title: "" };
  const s: Session = { token: nextToken++, typed: t };
  session = s;
  const doc = (target as Partial<Window>).document;
  const active = doc?.activeElement ?? null;
  if (editable(active)) {
    s.before = active;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) s.beforeValue = active.value;
    active.blur();
  }
  const onKey = (e: KeyboardEvent) => {
    const step = typeAheadStep(t, e);
    if (step === "take") {
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (step === "stop") stopCapture(s);
  };
  const onInput = (e: Event) => {
    const ie = e as InputEvent;
    if (!ie.cancelable) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (ie.inputType === "insertText" && ie.data) t[t.body === undefined ? "title" : "body"] += ie.data;
  };
  // Chromium gibt dem Feld mit der alten Auswahl bei Text aus einer Eingabemethode den Fokus zurück: gleich wieder weg.
  const onFocus = (e: Event) => {
    if (s.before && e.target === s.before) s.before.blur();
  };
  // … und fügt den Text trotzdem dort ein (Eingabemethode, kein abbrechbares beforeinput). Dann: das alte Feld behält
  // seinen Wert (die vorige Seite wird nicht umbenannt), der Text kommt zum Getippten.
  const onChanged = (e: Event) => {
    const el = s.before;
    if (!el || e.target !== el || !(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) || s.beforeValue === undefined) return;
    e.stopImmediatePropagation();
    el.value = s.beforeValue;
    const ie = e as InputEvent;
    if (ie.inputType?.startsWith("insert") && ie.data) t[t.body === undefined ? "title" : "body"] += ie.data;
  };
  const onPointer = () => stopCapture(s);
  const timer = setTimeout(() => stopCapture(s), WINDOW_MS);
  target.addEventListener("keydown", onKey, CAPTURE);
  target.addEventListener("beforeinput", onInput, CAPTURE);
  target.addEventListener("pointerdown", onPointer, CAPTURE);
  target.addEventListener("focusin", onFocus, CAPTURE);
  target.addEventListener("input", onChanged, CAPTURE);
  s.release = () => {
    clearTimeout(timer);
    target.removeEventListener("keydown", onKey, CAPTURE);
    target.removeEventListener("beforeinput", onInput, CAPTURE);
    target.removeEventListener("pointerdown", onPointer, CAPTURE);
    target.removeEventListener("focusin", onFocus, CAPTURE);
    target.removeEventListener("input", onChanged, CAPTURE);
  };
  return s.token;
}

/** Anlegen ist gescheitert: nichts mehr auffangen, Getipptes verwerfen, Fokus zurück. Ein neueres Anlegen bleibt. */
export function cancelFreshPage(token?: number): void {
  const s = session;
  if (!s || (token !== undefined && s.token !== token)) return;
  stopCapture(s);
  session = undefined;
  if (s.before?.isConnected && (!document.activeElement || document.activeElement === document.body)) s.before.focus();
}

/**
 * Der neue Titel ist da: das Getippte (falls etwas) einmal hergeben – nur der Seite, zu der es gehört (BSD-654). Kam
 * schon Enter, fängt es weiter auf (der Text der Seite ist evtl. noch nicht bereit) und `body` wächst weiter, bis
 * `stopTypedAhead` kommt; sonst endet das Auffangen.
 */
export function takeTypedAhead(id?: string): TypedAhead | undefined {
  const s = session;
  if (!s || (id !== undefined && s.id !== id)) return undefined;
  const t = s.typed;
  if (t.body === undefined) {
    stopCapture(s);
    session = undefined;
  } else s.typed = { title: "" }; // einmal hergeben; das Auffangen läuft bis stopTypedAhead weiter
  return t.title || t.body !== undefined ? t : undefined;
}

/** Der Text der Seite hat die Schreibmarke: ab jetzt gehen die Tasten wieder dorthin, wo der Fokus ist. */
export function stopTypedAhead(id?: string): void {
  const s = session;
  if (!s || (id !== undefined && s.id !== id)) return;
  stopCapture(s);
  session = undefined;
}
