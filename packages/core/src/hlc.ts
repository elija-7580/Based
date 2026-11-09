// Hybride logische Uhr (HLC), portiert aus BasedCore Model/Identifiers.swift (Stamp, StampClock).
// Verifiziert über fixtures/hlc/hlc.json (BSD-151, Teil 1).

export interface Stamp {
  millis: number;
  counter: number;
  node: string;
}

export const ZERO_STAMP: Readonly<Stamp> = Object.freeze({ millis: 0, counter: 0, node: "" });
const UINT32_MAX = 0xffff_ffff;

/** Ordnung: millis, dann counter, dann node. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.millis !== b.millis) return a.millis < b.millis ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

/** Sortierbare Textform `0000000000000005-000000-node` (wie Swift `Stamp.description`). */
export function stampToString(s: Stamp): string {
  return String(s.millis).padStart(16, "0") + "-" + String(s.counter).padStart(6, "0") + "-" + s.node;
}

/** Umkehrung von `stampToString`; `undefined` bei ungültigem Text. */
export function parseStamp(text: string): Stamp | undefined {
  const first = text.indexOf("-");
  if (first < 0) return undefined;
  const second = text.indexOf("-", first + 1);
  if (second < 0) return undefined;
  const m = text.slice(0, first), c = text.slice(first + 1, second);
  if (!/^[+-]?\d+$/.test(m) || !/^\+?\d+$/.test(c)) return undefined;
  const millis = Number(m), counter = Number(c);
  if (!Number.isSafeInteger(millis) || counter > UINT32_MAX) return undefined;
  return { millis, counter, node: text.slice(second + 1) };
}

/** Lokale Uhr eines Geräts. `wallClock` ist für Tests austauschbar. */
export class StampClock {
  /** Fremdstempel weiter als 1 h in der Zukunft werden ignoriert (BSD-72). */
  static readonly maxDrift = 3_600_000;
  wallClock: () => number = () => Date.now();
  private last: Stamp;

  constructor(readonly node: string, last: Stamp = ZERO_STAMP) {
    this.last = { ...last };
  }

  get current(): Stamp {
    return { ...this.last };
  }

  /** Nächster Stempel für eine lokale Änderung. */
  now(): Stamp {
    const wall = this.wallClock();
    if (wall > this.last.millis) this.last = { millis: wall, counter: 0, node: this.node };
    else if (this.last.counter === UINT32_MAX) this.last = { millis: this.last.millis + 1, counter: 0, node: this.node };
    else this.last = { millis: this.last.millis, counter: this.last.counter + 1, node: this.node };
    return { ...this.last };
  }

  /** Fremden Stempel beachten, damit die nächste lokale Änderung gewinnt. `false` = zu weit in der Zukunft. */
  observe(remote: Stamp): boolean {
    if (remote.millis > this.wallClock() + StampClock.maxDrift) return false;
    if (remote.millis > this.last.millis || (remote.millis === this.last.millis && remote.counter > this.last.counter)) {
      this.last = { millis: remote.millis, counter: remote.counter, node: this.node };
    }
    return true;
  }
}
