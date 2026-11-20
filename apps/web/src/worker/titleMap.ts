// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// Titel-Tabelle der Shell (ShellState.titles): React braucht bei jeder Änderung ein neues Objekt, aber eine Kopie aller
// Einträge je Titeländerung kostete bei 120 000 Titeln (20 000 Seiten + Datenbankzeilen) ~20 ms im Hauptthread – bei
// jeder Taste im Seitentitel und in jeder Titelzelle. Hier teilen sich die Stände eine Grundtabelle; jeder neue Stand
// trägt nur eine kleine Schicht mit den Änderungen. Wird die Schicht zu groß, wird zusammengelegt (selten, linear).

const GONE: unique symbol = Symbol("gone");

/** Unveränderliche Map mit billigen Änderungen (`with`). Werte sind nie `undefined`. */
export class LayeredMap<K, V> implements ReadonlyMap<K, V> {
  readonly size: number;
  private flatCache: Map<K, V> | undefined;

  private constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly layer: ReadonlyMap<K, V | typeof GONE>,
    size: number,
  ) {
    this.size = size;
  }

  static of<K, V>(entries: Iterable<readonly [K, V]> = []): LayeredMap<K, V> {
    const base = new Map<K, V>(entries);
    return new LayeredMap<K, V>(base, new Map(), base.size);
  }

  get(key: K): V | undefined {
    const v = this.layer.get(key);
    return v === undefined ? this.base.get(key) : v === GONE ? undefined : v;
  }

  has(key: K): boolean {
    const v = this.layer.get(key);
    return v === undefined ? this.base.has(key) : v !== GONE;
  }

  /**
   * Neuer Stand mit den Änderungen (`undefined` = entfernen); dieser bleibt, wie er ist. Kosten: Größe der Schicht,
   * nicht der Tabelle – bis die Schicht ein Achtel der Grundtabelle (mindestens 1 024) übersteigt.
   */
  with(changes: Iterable<readonly [K, V | undefined]>): LayeredMap<K, V> {
    const layer = new Map(this.layer);
    let size = this.size;
    for (const [k, v] of changes) {
      const cur = layer.get(k);
      const had = cur === undefined ? this.base.has(k) : cur !== GONE;
      if (v === undefined) {
        if (!had) continue;
        size -= 1;
        if (this.base.has(k)) layer.set(k, GONE);
        else layer.delete(k);
      } else {
        if (!had) size += 1;
        if (this.base.get(k) === v) layer.delete(k);
        else layer.set(k, v);
      }
    }
    const next = new LayeredMap(this.base, layer, size);
    if (layer.size <= Math.max(1024, this.base.size >> 3)) return next;
    const flat = next.flat();
    return new LayeredMap<K, V>(flat, new Map(), flat.size);
  }

  /** Alle Einträge als gewöhnliche Map (einmal je Stand gebaut, nur für Durchläufe). */
  private flat(): Map<K, V> {
    if (this.flatCache) return this.flatCache;
    // Ohne Schicht ist die Grundtabelle schon der Stand (sie wird nie verändert, nur zum Lesen herausgegeben).
    if (this.layer.size === 0 && this.base instanceof Map) return (this.flatCache = this.base);
    const out = new Map<K, V>();
    for (const [k, v] of this.base) {
      const l = this.layer.get(k);
      if (l === undefined) out.set(k, v);
      else if (l !== GONE) out.set(k, l);
    }
    for (const [k, l] of this.layer) if (l !== GONE && !this.base.has(k)) out.set(k, l);
    this.flatCache = out;
    return out;
  }

  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.flat().forEach((v, k) => fn.call(thisArg, v, k, this));
  }

  entries() {
    return this.flat().entries();
  }

  keys() {
    return this.flat().keys();
  }

  values() {
    return this.flat().values();
  }

  [Symbol.iterator]() {
    return this.flat()[Symbol.iterator]();
  }
}
