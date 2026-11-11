// Kraft-Layout für den Seitengraph: Federn entlang der Kanten, Abstoßung zwischen nahen Knoten (über ein Raster,
// also O(n) je Schritt statt O(n²)), leichte Schwerkraft zur Mitte. Deterministisch: Startpositionen kommen aus der
// Knoten-ID, nie aus dem Zufall – derselbe Graph liegt immer gleich, und bekannte Knoten behalten ihren Platz, wenn
// der Graph sich ändert (`initial`). `run(budgetMs)` rechnet nur so lange, wie ein Frame Zeit hat.

export interface LayoutOptions {
  /** Wunschlänge einer Kante. */
  linkDistance?: number;
  /** Reichweite der Abstoßung. */
  repelRadius?: number;
  repelStrength?: number;
  gravity?: number;
  /** Startwert der „Temperatur“ (bei bekannten Positionen kleiner wählen). */
  alpha?: number;
  /**
   * Knoten mit bekanntem Platz (`initial`) bleiben genau dort; nur neue Knoten suchen sich ihren Platz. So bleibt
   * ein gemerktes Bild stehen, wenn Seiten dazukommen. `release()` (z. B. beim Ziehen) hebt das auf.
   */
  keepKnown?: boolean;
}

export interface Point { x: number; y: number }

/** FNV-1a – stabile 32-Bit-Zahl aus einer ID. */
export function hashID(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class ForceLayout {
  readonly x: Float32Array;
  readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly degree: Uint32Array;
  alpha: number;
  steps = 0;
  readonly linkDistance: number;
  readonly repelRadius: number;
  readonly repelStrength: number;
  readonly gravity: number;
  /** Festgehaltener Knoten (wird gezogen). */
  pinned = -1;
  /** 1 = Knoten bleibt an seinem Platz (`keepKnown`). */
  private frozen: Uint8Array | undefined;
  // Raster (wiederverwendet)
  private cellHead = new Int32Array(0);
  private readonly cellNext: Int32Array;
  private readonly cellX: Int32Array;
  private readonly cellY: Int32Array;

  static readonly ALPHA_MIN = 0.01;
  static readonly ALPHA_DECAY = 0.985;

  constructor(readonly ids: readonly string[], readonly links: readonly (readonly [number, number])[], opts: LayoutOptions = {}, initial?: ReadonlyMap<string, Point>) {
    const n = ids.length;
    this.linkDistance = opts.linkDistance ?? 46;
    this.repelRadius = opts.repelRadius ?? 96;
    this.repelStrength = opts.repelStrength ?? 700;
    this.gravity = opts.gravity ?? 0.012;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.degree = new Uint32Array(n);
    this.cellNext = new Int32Array(n);
    this.cellX = new Int32Array(n);
    this.cellY = new Int32Array(n);
    for (const [a, b] of links) { this.degree[a]! += 1; this.degree[b]! += 1; }
    // Startscheibe: Fläche wächst mit der Knotenzahl, damit die Dichte gleich bleibt.
    const radius = Math.sqrt(Math.max(1, n)) * this.linkDistance * 0.6;
    let known = 0;
    for (let i = 0; i < n; i++) {
      const p = initial?.get(ids[i]!);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        this.x[i] = p.x;
        this.y[i] = p.y;
        known += 1;
      } else {
        const h = hashID(ids[i]!);
        const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
        const r = Math.sqrt(((h >>> 16) + 0.5) / 0x10000) * radius;
        this.x[i] = Math.cos(angle) * r;
        this.y[i] = Math.sin(angle) * r;
      }
    }
    // Neue Knoten neben einen schon platzierten Nachbarn setzen (ruhiger als quer durch das Bild zu wandern).
    if (initial && known > 0 && known < n) {
      const placed = (i: number) => initial.has(ids[i]!);
      for (const [a, b] of links) {
        const pa = placed(a), pb = placed(b);
        if (pa === pb) continue;
        const from = pa ? a : b, to = pa ? b : a;
        const h = hashID(ids[to]!);
        const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
        this.x[to] = this.x[from]! + Math.cos(angle) * this.linkDistance;
        this.y[to] = this.y[from]! + Math.sin(angle) * this.linkDistance;
      }
    }
    if (opts.keepKnown && initial && known > 0 && known < n) {
      const frozen = new Uint8Array(n);
      for (let i = 0; i < n; i++) frozen[i] = initial.has(ids[i]!) ? 1 : 0;
      this.frozen = frozen;
    }
    this.alpha = opts.alpha ?? (n > 0 && known === n ? 0.05 : known > 0 ? 0.15 : 1);
  }

  /** Alle Knoten dürfen sich wieder bewegen (nach `keepKnown`). */
  release() {
    this.frozen = undefined;
  }

  get count(): number {
    return this.ids.length;
  }

  get settled(): boolean {
    return this.alpha < ForceLayout.ALPHA_MIN;
  }

  /** Wieder anstoßen (z. B. beim Ziehen eines Knotens). */
  reheat(alpha = 0.3) {
    if (this.alpha < alpha) this.alpha = alpha;
  }

  /** Ein Simulationsschritt. */
  step() {
    const n = this.ids.length;
    if (n === 0) { this.alpha = 0; return; }
    const { x, y, vx, vy } = this;
    const a = this.alpha;

    // Federn (wie d3-force: Stärke 1/min(Grad), Verteilung nach Grad – Naben bleiben ruhig)
    const L = this.linkDistance;
    for (const [s, t] of this.links) {
      let dx = x[t]! + vx[t]! - x[s]! - vx[s]!;
      let dy = y[t]! + vy[t]! - y[s]! - vy[s]!;
      if (dx === 0 && dy === 0) { dx = ((hashID(this.ids[s]!) & 0xff) - 127.5) * 1e-3; dy = ((hashID(this.ids[t]!) & 0xff) - 127.5) * 1e-3; }
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ds = this.degree[s]!, dt = this.degree[t]!;
      const k = ((dist - L) / dist) * a * (1 / Math.min(ds, dt));
      const bias = ds / (ds + dt);
      vx[t]! -= dx * k * bias;
      vy[t]! -= dy * k * bias;
      vx[s]! += dx * k * (1 - bias);
      vy[s]! += dy * k * (1 - bias);
    }

    // Abstoßung über ein gehashtes Raster mit Zellgröße = Reichweite: nur die 9 Zellen um einen Knoten zählen. Gehasht
    // statt als Feld, damit weit verstreute Knoten (Ausreißer) das Raster nicht aufblähen; Kollisionen im Hash werden
    // über die gemerkte Zelle jedes Knotens aussortiert.
    const R = this.repelRadius, R2 = R * R;
    let size = this.cellHead.length;
    if (size < 2 * n) {
      size = 1;
      while (size < 2 * n) size <<= 1;
      this.cellHead = new Int32Array(size);
    }
    const mask = size - 1;
    const head = this.cellHead, next = this.cellNext, cxs = this.cellX, cys = this.cellY;
    const hash = (cx: number, cy: number) => (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & mask;
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i]! / R), cy = Math.floor(y[i]! / R);
      cxs[i] = cx;
      cys[i] = cy;
      const h = hash(cx, cy);
      next[i] = head[h]!;
      head[h] = i;
    }
    const strength = this.repelStrength * a;
    for (let i = 0; i < n; i++) {
      const px = x[i]!, py = y[i]!;
      const cx = cxs[i]!, cy = cys[i]!;
      let fx = 0, fy = 0;
      for (let oy = cy - 1; oy <= cy + 1; oy++) {
        for (let ox = cx - 1; ox <= cx + 1; ox++) {
          for (let j = head[hash(ox, oy)]!; j >= 0; j = next[j]!) {
            if (j === i || cxs[j] !== ox || cys[j] !== oy) continue;
            let dx = px - x[j]!, dy = py - y[j]!;
            let d2 = dx * dx + dy * dy;
            if (d2 >= R2) continue;
            if (d2 < 1) {
              // gleiche Stelle: in eine feste, vom Paar abhängige Richtung schieben
              const h = hashID(this.ids[i]!) ^ (j * 2654435761);
              dx = (i < j ? 1 : -1) * (((h & 0xff) + 1) / 256);
              dy = (i < j ? 1 : -1) * ((((h >>> 8) & 0xff) + 1) / 256);
              d2 = 1;
            }
            // fällt zur Reichweite hin auf 0 ab (kein Sprung an der Kante)
            const w = strength * (1 - d2 / R2) / d2;
            fx += dx * w;
            fy += dy * w;
          }
        }
      }
      vx[i]! += fx;
      vy[i]! += fy;
    }

    // Schwerkraft, Dämpfung, Bewegung
    const g = this.gravity * a;
    const frozen = this.frozen;
    for (let i = 0; i < n; i++) {
      if (i === this.pinned || frozen?.[i]) { vx[i] = 0; vy[i] = 0; continue; }
      vx[i] = (vx[i]! - x[i]! * g) * 0.6;
      vy[i] = (vy[i]! - y[i]! * g) * 0.6;
      // Schrittweite begrenzen: ein Ausreißer springt nicht aus dem Bild
      const sp = Math.sqrt(vx[i]! * vx[i]! + vy[i]! * vy[i]!);
      const max = L * 2;
      if (sp > max) { vx[i] = (vx[i]! / sp) * max; vy[i] = (vy[i]! / sp) * max; }
      x[i]! += vx[i]!;
      y[i]! += vy[i]!;
    }
    this.alpha *= ForceLayout.ALPHA_DECAY;
    this.steps += 1;
  }

  /** Rechnet höchstens `budgetMs` (mindestens einen Schritt). Gibt zurück, ob das Layout zur Ruhe gekommen ist. */
  run(budgetMs: number, now: () => number = () => performance.now()): boolean {
    const end = now() + budgetMs;
    do {
      if (this.settled) return true;
      this.step();
    } while (now() < end);
    return this.settled;
  }

  /** Bis zur Ruhe rechnen (Tests, Vorab-Layout im Worker). */
  settle(maxSteps = 2000): number {
    let n = 0;
    while (!this.settled && n < maxSteps) { this.step(); n += 1; }
    return n;
  }

  positions(): Map<string, Point> {
    const out = new Map<string, Point>();
    for (let i = 0; i < this.ids.length; i++) out.set(this.ids[i]!, { x: this.x[i]!, y: this.y[i]! });
    return out;
  }

  /** Umschließendes Rechteck. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return layoutBounds(this.x, this.y, this.ids.length);
  }

  /** Knoten am Punkt (Radius in Graph-Koordinaten); der nächste gewinnt. */
  nodeAt(px: number, py: number, radius: number): number {
    return nodeAtPoint(this.x, this.y, this.ids.length, px, py, radius);
  }
}

/** Umschließendes Rechteck von Positionen. */
export function layoutBounds(x: ArrayLike<number>, y: ArrayLike<number>, n: number): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = x[i]!, py = y[i]!;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  if (n === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Knoten am Punkt (Radius in Graph-Koordinaten); der nächste gewinnt. */
export function nodeAtPoint(x: ArrayLike<number>, y: ArrayLike<number>, n: number, px: number, py: number, radius: number): number {
  let best = -1, bestD = radius * radius;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - px, dy = y[i]! - py;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { best = i; bestD = d; }
  }
  return best;
}
