// BSD-138: `based` aus der Desktop-App installieren (Opt-in, ohne gebündelte Node-Laufzeit). Der Befehl ist ein
// kleiner Starter, der das Bundle der App mit der vorhandenen Node (≥ 22) startet. Installiert nur, wo keine fremde
// Datei liegt, und entfernt nur den eigenen Starter (Kennzeichen-Zeile).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const STARTER_MARK = "# based-cli-starter (Based Next)";
export const MIN_NODE_MAJOR = 22;

/** Standardort: ~/.local/bin/based (braucht kein sudo). */
export const defaultTarget = (home: string) => join(home, ".local", "bin", "based");

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Inhalt des Starters. */
export function starterScript(node: string, bundle: string): string {
  return [
    "#!/bin/sh",
    STARTER_MARK,
    "# Runs the Based command line tool with your Node.js. Uninstall in Based Next: Settings → Sync & server.",
    `exec ${shellQuote(node)} ${shellQuote(bundle)} cli "$@"`,
    "",
  ].join("\n");
}

/** Hauptversion aus `v22.11.0`. */
export function nodeMajor(version: string): number | undefined {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

export interface InstallResult { ok: boolean; target: string; message: string; inPath?: boolean }

export function installStarter(o: { target: string; node: string; nodeVersion: string; bundle: string; path?: string | undefined }): InstallResult {
  const major = nodeMajor(o.nodeVersion);
  if (major === undefined || major < MIN_NODE_MAJOR) {
    return { ok: false, target: o.target, message: `Node.js ${MIN_NODE_MAJOR} or newer is needed (found ${o.nodeVersion || "none"}).` };
  }
  if (!o.target.startsWith("/")) return { ok: false, target: o.target, message: "The install location must be an absolute path." };
  if (!existsSync(o.bundle)) return { ok: false, target: o.target, message: `The app's command line bundle is missing (${o.bundle}).` };
  if (existsSync(o.target)) {
    let current = "";
    try { current = readFileSync(o.target, "utf8"); } catch { current = ""; }
    if (!current.includes(STARTER_MARK)) return { ok: false, target: o.target, message: `${o.target} already exists and wasn't installed by Based. Choose another location or remove it first.` };
  }
  try {
    mkdirSync(dirname(o.target), { recursive: true });
    const tmp = `${o.target}.${process.pid}.tmp`;
    writeFileSync(tmp, starterScript(o.node, o.bundle), { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, o.target);
  } catch (e) {
    return { ok: false, target: o.target, message: `Couldn't write ${o.target}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const inPath = (o.path ?? "").split(delimiter).includes(dirname(o.target));
  return { ok: true, target: o.target, inPath, message: inPath ? `Installed. Run \`based --help\` in a new terminal.` : `Installed. ${dirname(o.target)} isn't in your PATH yet — add it to your shell profile, or run ${o.target} directly.` };
}

export function uninstallStarter(target: string): InstallResult {
  if (!existsSync(target)) return { ok: true, target, message: "Not installed." };
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { current = ""; }
  if (!current.includes(STARTER_MARK)) return { ok: false, target, message: `${target} wasn't installed by Based — left it alone.` };
  rmSync(target, { force: true });
  return { ok: true, target, message: "Removed." };
}

export function starterStatus(target: string): { installed: boolean; target: string } {
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { return { installed: false, target }; }
  return { installed: current.includes(STARTER_MARK), target };
}
