// BSD-154: Sortierschlüssel für eine Geschwisterliste aus dem Editor. Behält so viele vorhandene Schlüssel
// wie möglich (längste aufsteigende Teilfolge nach (sk, id), wie der Store sortiert) und vergibt nur für
// verschobene oder neue Blöcke neue Schlüssel – so ändert Tippen nie die Reihenfolge-Felder anderer Records.
import { keysBetween } from "@based/core";

const before = (a: { sk: string; id: string }, b: { sk: string; id: string }) => a.sk < b.sk || (a.sk === b.sk && a.id < b.id);

/** `current[i]`: vorhandener Schlüssel des i-ten Blocks unter demselben Elternteil, sonst undefined. */
export function assignSortKeys(ids: readonly string[], current: readonly (string | undefined)[]): string[] {
  const n = ids.length;
  const items = ids.map((id, i) => ({ id, sk: current[i] }));
  // Längste aufsteigende Teilfolge (O(n log n)) über die Blöcke mit Schlüssel.
  const tails: number[] = [];
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const it = items[i]!;
    if (it.sk === undefined) continue;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(items[tails[mid]!] as { sk: string; id: string }, it as { sk: string; id: string })) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) keep.add(i);
  // Zwischen zwei behaltenen Schlüsseln mit gleichem sk passt nichts: den rechten neu vergeben.
  for (let changed = true; changed;) {
    changed = false;
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!keep.has(i)) continue;
      if (last >= 0 && i - last > 1 && items[last]!.sk! >= items[i]!.sk!) {
        keep.delete(i);
        changed = true;
        break;
      }
      last = i;
    }
  }
  const out = new Array<string>(n);
  let i = 0;
  while (i < n) {
    if (keep.has(i)) {
      out[i] = items[i]!.sk!;
      i++;
      continue;
    }
    let j = i;
    while (j < n && !keep.has(j)) j++;
    const lo = i > 0 ? out[i - 1] : undefined;
    const hi = j < n ? items[j]!.sk : undefined;
    const keys = keysBetween(j - i, lo, hi);
    for (let k = i; k < j; k++) out[k] = keys[k - i]!;
    i = j;
  }
  return out;
}
