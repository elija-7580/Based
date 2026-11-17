// Elija 17.11.: eine Seite wählen „wie mit ⌘K“ – zum Beispiel für eine Seite auf dem Board. Wer wählen lässt, ruft
// `pickPage()`; die App zeigt dafür Quick Find (dieselbe Suche, dieselbe Bedienung) und liefert die gewählte Seite
// (oder `undefined`, wenn abgebrochen).
type Pending = { resolve: (id: string | undefined) => void };

let pending: Pending | undefined;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };

export function pickPage(): Promise<string | undefined> {
  pending?.resolve(undefined);
  return new Promise((done) => {
    const me: Pending = {
      resolve: (id) => {
        if (pending === me) { pending = undefined; emit(); }
        done(id);
      },
    };
    pending = me;
    emit();
  });
}

export const pagePick = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  get: (): Pending | undefined => pending,
};
