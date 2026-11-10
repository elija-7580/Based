// Nachrichten, die während einer laufenden Antwort geschickt werden, warten hier und gehen danach der Reihe nach
// raus (Swift `ChatPromptQueue`, BSD-48). Der nächste Turn beginnt erst, wenn der vorige ganz fertig (gespeichert)
// ist – Antworten vertauschen sich nie. „Send now“ zieht eine wartende Nachricht vor und stoppt die laufende Antwort.

export interface QueuedPrompt<P> {
  id: string;
  /** Was der Chat für die wartende Nachricht zeigt. */
  text: string;
  payload: P;
}

export interface RunningTurn {
  /** Erfüllt sich, wenn der Turn vollständig beendet und gespeichert ist (wirft nie). */
  done: Promise<void>;
  cancel(): void;
}

export class PromptQueue<P> {
  /** Wartende Nachrichten, älteste zuerst. */
  waiting: QueuedPrompt<P>[] = [];
  isBusy = false;
  /** Nach jeder Änderung (Warteliste oder busy). */
  onChange: (() => void) | undefined;
  private current: RunningTurn | undefined;
  private generation = 0;
  private n = 0;

  /** `start` beginnt einen Turn (undefined = nichts zu senden; die Schlange geht weiter). */
  constructor(private readonly start: (payload: P) => RunningTurn | undefined) {}

  /** Sendet sofort, wenn frei; sonst einreihen. Gibt die ID des wartenden Eintrags zurück, oder undefined bei Sofortstart. */
  submit(text: string, payload: P): string | undefined {
    this.n += 1;
    const item: QueuedPrompt<P> = { id: "q" + this.n, text, payload };
    if (this.isBusy) {
      this.waiting = [...this.waiting, item];
      this.onChange?.();
      return item.id;
    }
    this.run(item);
    return undefined;
  }

  /** Eine wartende Nachricht zurücknehmen. */
  remove(id: string) {
    this.waiting = this.waiting.filter((x) => x.id !== id);
    this.onChange?.();
  }

  /** Eine wartende Nachricht als Nächstes senden und die laufende Antwort unterbrechen. */
  sendNow(id: string) {
    const item = this.waiting.find((x) => x.id === id);
    if (!item) return;
    this.waiting = [item, ...this.waiting.filter((x) => x.id !== id)];
    this.onChange?.();
    if (this.current) this.current.cancel();
    else if (!this.isBusy) this.next();
  }

  /** Die laufende Antwort stoppen; wartende Nachrichten bleiben und folgen. */
  stopCurrent() {
    this.current?.cancel();
  }

  clear() {
    this.waiting = [];
    this.onChange?.();
  }

  /** Chat gewechselt: Wartende fallen weg, die laufende Antwort geht im Hintergrund weiter, blockiert aber nicht mehr. */
  detach() {
    this.waiting = [];
    this.generation += 1;
    this.current = undefined;
    this.isBusy = false;
    this.onChange?.();
  }

  private next() {
    const [item, ...rest] = this.waiting;
    if (!item) {
      this.isBusy = false;
      this.onChange?.();
      return;
    }
    this.waiting = rest;
    this.run(item);
  }

  private run(item: QueuedPrompt<P>) {
    const turn = this.start(item.payload);
    if (!turn) {
      this.next();
      return;
    }
    this.generation += 1;
    const mine = this.generation;
    this.current = turn;
    this.isBusy = true;
    this.onChange?.();
    void turn.done.catch(() => undefined).then(() => {
      if (mine !== this.generation) return;
      this.current = undefined;
      this.next();
    });
  }
}
