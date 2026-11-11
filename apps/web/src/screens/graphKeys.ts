// BSD-238 Teil 3: Graph per Tastatur – Pfeiltaste wählt den nächsten Knoten in dieser Richtung (Kegel von ±60°,
// nahe und gerade voraus zuerst). Rein, ohne DOM: Koordinaten kommen aus dem Layout.
export type GraphDirection = "up" | "down" | "left" | "right";

const DIR: Record<GraphDirection, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Index des nächsten Knotens von `from` aus in Richtung `dir` (oder -1). */
export function graphStep(xs: ArrayLike<number>, ys: ArrayLike<number>, from: number, dir: GraphDirection): number {
  const [dx, dy] = DIR[dir];
  const x0 = xs[from]!, y0 = ys[from]!;
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (i === from) continue;
    const vx = xs[i]! - x0, vy = ys[i]! - y0;
    const dist = Math.hypot(vx, vy);
    if (dist < 1e-6) continue;
    const cos = (vx * dx + vy * dy) / dist;
    if (cos < 0.5) continue; // außerhalb ±60°
    const score = dist * (2 - cos);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
