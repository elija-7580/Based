// BSD-337: Der Mac baut auf einem Dateisystem ohne Groß-/Kleinschreibung. Liegen `composer.ts` und `Composer.tsx` im
// selben Ordner, löst Vite `./Composer.js` dort auf `composer.ts` auf – der Desktop-Build brach ab (Läufe 66–72), unter
// Linux fiel es nicht auf. Dieser Test hält jeden Ordner frei von Namen, die sich nur in der Schreibweise unterscheiden
// (auch über die Endung hinweg, weil TypeScript-Importe `.js` gegen `.ts`/`.tsx` tauschen; nur Skriptdateien).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(new URL(".", import.meta.url).pathname, "../../..");
const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);

/** Name ohne Code-Endung, klein geschrieben: `Composer.tsx` und `composer.ts` ergeben beide `composer`. */
const SCRIPT = /\.(d\.ts|tsx?|jsx?|mjs|cjs)$/;
const stem = (path: string) => path.replace(SCRIPT, "").toLowerCase();

describe("Dateinamen (BSD-337)", () => {
  it("kein Ordner enthält zwei Namen, die sich nur in Groß-/Kleinschreibung unterscheiden", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const f of tracked) {
      if (f.startsWith("legacy/") || !SCRIPT.test(f)) continue; // CSS u. a. werden mit Endung importiert – kein Problem
      const key = join(dirname(f).toLowerCase(), stem(f.split("/").pop()!));
      const other = seen.get(key);
      if (other !== undefined && other !== f && !/\.test\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(other)) clashes.push(`${other} ↔ ${f}`);
      else seen.set(key, f);
    }
    expect(clashes).toEqual([]);
  });
});
