// BSD-313: Dateien im Arbeitsordner einer Coding-Sitzung (Node). In einem git-Repo `git ls-files` (beachtet alle
// .gitignore-Dateien, schnell auch bei 50.000 Dateien), sonst ein eigener Durchlauf ohne Symlinks, ohne .git und
// node_modules, mit der .gitignore des Ordners. Nur unterhalb von `root`; höchstens `max` Einträge.
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { gitignoreMatcher } from "./files.js";

const SKIP = new Set([".git", "node_modules", ".hg", ".svn"]);

function gitFiles(root: string, max: number): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }, (err, out) => {
      if (err) return resolve(undefined);
      // Pfade relativ zu root; „..“ kommt bei -C nicht vor, sicherheitshalber trotzdem heraus.
      resolve(out.split("\0").filter((p) => p !== "" && !p.startsWith("../") && !p.startsWith("/")).slice(0, max));
    });
  });
}

async function walk(root: string, max: number): Promise<string[]> {
  const ignored = gitignoreMatcher(await fsp.readFile(root + "/.gitignore", "utf8").catch(() => ""));
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < max) {
    const dir = queue.shift()!;
    const entries = await fsp.readdir(dir === "" ? root : `${root}/${dir}`, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = dir === "" ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !ignored(rel, true)) queue.push(rel);
      } else if (e.isFile() && !ignored(rel, false)) {
        out.push(rel);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** Dateien unter `root` (relativ), 10 s zwischengespeichert. */
export function listSessionFiles(root: string, o: { max?: number; ttlMs?: number; now?: () => number } = {}): Promise<string[]> {
  const now = (o.now ?? Date.now)();
  const hit = cache.get(root);
  if (hit && now - hit.at < (o.ttlMs ?? 10_000)) return hit.files;
  const max = o.max ?? 200_000;
  const files = gitFiles(root, max).then((g) => g ?? walk(root, max));
  cache.set(root, { at: now, files });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return files;
}
