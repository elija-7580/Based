// BSD-270: Kürzel erst zeigen, wenn ⌘ (bzw. Strg) allein lange gehalten wird – wie in der Claude-Code-App. Rein bis
// auf die Uhr (setTimeout/clearTimeout kommen von außen, damit Tests sie vorspulen können). Kein Aufblitzen bei normalen
// Kombinationen: jede andere Taste, ein Klick oder Fensterwechsel bricht ab bzw. blendet aus.

export interface HoldKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

export interface HoldOptions {
  /** Taste, die gehalten wird: "Meta" (Apple) oder "Control". */
  modifier: "Meta" | "Control";
  delayMs?: number;
  onChange: (visible: boolean) => void;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export const HOLD_DELAY_MS = 500;

export interface HoldDetector {
  keydown(e: HoldKeyEvent): void;
  keyup(e: HoldKeyEvent): void;
  /** Klick, Fokusverlust, Fenster versteckt: sofort aus. */
  cancel(): void;
  readonly visible: boolean;
}

export function holdDetector(o: HoldOptions): HoldDetector {
  const set = o.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clear = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let visible = false;
  const show = (v: boolean) => {
    if (v === visible) return;
    visible = v;
    o.onChange(v);
  };
  const stop = () => {
    if (timer !== undefined) clear(timer);
    timer = undefined;
  };
  const cancel = () => {
    stop();
    show(false);
  };
  return {
    get visible() { return visible; },
    keydown(e) {
      if (e.key === o.modifier) {
        if (e.repeat || timer !== undefined || visible) return;
        // nur ⌘ allein (kein ⇧/⌥ schon gedrückt)
        if (e.shiftKey || e.altKey) return;
        timer = set(() => { timer = undefined; show(true); }, o.delayMs ?? HOLD_DELAY_MS);
        return;
      }
      // eine andere Taste: abbrechen bzw. ausblenden (die Kombination führt die Aktion aus)
      cancel();
    },
    keyup(e) {
      if (e.key === o.modifier || !(o.modifier === "Meta" ? e.metaKey : e.ctrlKey)) cancel();
    },
    cancel,
  };
}

/** Anzeige eines Kürzels: „⌘K“ auf Apple, „Ctrl+K“ sonst. */
export function shortcutLabel(key: string, opts: { apple: boolean; shift?: boolean }): string {
  const k = key.length === 1 ? key.toUpperCase() : key;
  return opts.apple ? `${opts.shift ? "⇧" : ""}⌘${k}` : `Ctrl+${opts.shift ? "Shift+" : ""}${k}`;
}
