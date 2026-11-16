// BSD-231 Teil 3d: Modelldateien auf dem based-server (Ordner neben der Datenbank). Gleiche Ablage wie im Worker
// (`<modell>/<version>/<datei>`), atomar geschrieben (erst .tmp, dann umbenennen); Pfade ohne „..“.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { localModels } from "@based/brain";

export class FileModelStore implements localModels.LocalModelStore {
  constructor(readonly dir: string) {}

  /** Absoluter Pfad, nur innerhalb des Ordners. */
  pathOf(path: string): string {
    const parts = path.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`invalid model path ${path}`);
    const full = resolve(this.dir, ...parts);
    if (!full.startsWith(resolve(this.dir) + sep)) throw new Error(`invalid model path ${path}`);
    return full;
  }

  async get(path: string) {
    try {
      return new Uint8Array(await readFile(this.pathOf(path)));
    } catch {
      return undefined;
    }
  }

  async put(path: string, bytes: Uint8Array) {
    const full = this.pathOf(path);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = full + ".tmp";
    writeFileSync(tmp, bytes);
    renameSync(tmp, full);
  }

  async delete(path: string) {
    rmSync(this.pathOf(path), { force: true });
  }
}

export const defaultModelsDir = (db: string | undefined) => (db && db !== ":memory:" ? db.replace(/(\.sqlite)?$/, ".models") : undefined);
