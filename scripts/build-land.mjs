// Erzeugt packages/database-ui/src/map/land.ts aus world-atlas@2 land-110m.json (TopoJSON, Natural Earth 1:110m).
// Aufruf: node scripts/build-land.mjs <pfad/zu/land-110m.json> [<pfad/zu/LICENSE>]
// Ohne Abhängigkeiten: TopoJSON-Bögen (delta-kodiert, quantisiert) werden hier selbst dekodiert.
import { readFileSync, writeFileSync } from "node:fs";

const [src, licensePath] = process.argv.slice(2);
if (!src) throw new Error("Pfad zu land-110m.json fehlt");
const topo = JSON.parse(readFileSync(src, "utf8"));
const { scale, translate } = topo.transform;
const arcs = topo.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
});
const arcPoints = (i) => (i >= 0 ? arcs[i] : arcs[~i].slice().reverse());
const ring = (ids) => {
  const pts = [];
  for (const id of ids) { const a = arcPoints(id); pts.push(...(pts.length ? a.slice(1) : a)); }
  return pts;
};
const rings = [];
const collect = (g) => {
  if (g.type === "GeometryCollection") g.geometries.forEach(collect);
  else if (g.type === "Polygon") g.arcs.forEach((r) => rings.push(ring(r)));
  else if (g.type === "MultiPolygon") g.arcs.forEach((p) => p.forEach((r) => rings.push(ring(r))));
};
collect(topo.objects.land);
const r2 = (n) => Math.round(n * 100) / 100;
const flat = rings.filter((r) => r.length >= 4).map((r) => r.flatMap(([x, y]) => [r2(x), r2(y)]));
const license = licensePath ? readFileSync(licensePath, "utf8").trim().split("\n").map((l) => " * " + l).join("\n") : "";
const out = `// @generated von scripts/build-land.mjs – nicht von Hand ändern.
/**
 * Landflächen der Erde, 1:110m, als Ringe [lon, lat, lon, lat, …] (Grad, auf 0,01° gerundet).
 *
 * Quelle: Natural Earth 4.1.0 „land“ 1:110m (https://www.naturalearthdata.com) – gemeinfrei (public domain),
 * in der TopoJSON-Fassung des npm-Pakets world-atlas@2.0.2 (land-110m.json), das unter ISC steht:
 *
${license}
 */
export const LAND_RINGS: readonly (readonly number[])[] = ${JSON.stringify(flat)};
`;
writeFileSync(new URL("../packages/database-ui/src/map/land.ts", import.meta.url), out);
console.log(`${flat.length} Ringe, ${flat.reduce((n, r) => n + r.length / 2, 0)} Punkte, ${out.length} Bytes`);
