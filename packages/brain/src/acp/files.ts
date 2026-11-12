// BSD-313: @Dateien in der Coding-Konsole – Treffer für eine Eingabe nach „@“ ordnen (plattformneutral; die Liste
// der Dateien liefert die Hülle, auf dem Server `listSessionFiles` aus `@based/brain/acp-node`).
// Reihenfolge: Dateiname beginnt mit der Eingabe › Dateiname enthält sie › Pfad enthält sie › Buchstaben in
// Reihenfolge (fuzzy); bei Gleichstand kürzerer Pfad, dann alphabetisch. Groß/klein egal, „/“ in der Eingabe
// gleicht Pfade ab („src/ma“ → src/main.ts).

/** Ein Treffer: Pfad relativ zum Arbeitsordner. */
export interface FileMatch { path: string; name: string }

function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (let k = 0; k < hay.length && i < needle.length; k++) if (hay[k] === needle[i]) i++;
  return i === needle.length;
}

/** Bis zu `limit` Treffer für `query`; leere Eingabe = die kürzesten Pfade (oberste Ebene zuerst). */
export function rankFiles(paths: readonly string[], query: string, limit = 50): FileMatch[] {
  const q = query.trim().toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (q === "") score = 4;
    else if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (subsequence(q.includes("/") ? lower : name, q)) score = 3;
    else continue;
    scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, limit).map(({ path }) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }));
}

/**
 * Sehr kleine .gitignore-Auswertung für Ordner ohne git (Fallback): Kommentare und Negationen werden ignoriert,
 * `*` und `?` gelten innerhalb eines Abschnitts, `/` am Ende = nur Ordner, `/` am Anfang oder in der Mitte = ab
 * dem Ordner der .gitignore. Liefert eine Prüfung für Pfade relativ zu diesem Ordner.
 */
export function gitignoreMatcher(text: string): (rel: string, isDir: boolean) => boolean {
  const rules = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("!")).map((raw) => {
    const dirOnly = raw.endsWith("/");
    let p = dirOnly ? raw.slice(0, -1) : raw;
    const anchored = p.startsWith("/") || p.includes("/");
    p = p.replace(/^\//, "");
    const re = new RegExp("^" + p.split("**/").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("(?:.*/)?") + "$");
    return { re, dirOnly, anchored };
  });
  return (rel, isDir) => rules.some((r) => {
    if (r.dirOnly && !isDir) return false;
    if (r.anchored) return r.re.test(rel);
    return r.re.test(rel.slice(rel.lastIndexOf("/") + 1));
  });
}
