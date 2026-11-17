// BSD-138: `based` aus der Desktop-App installieren (Opt-in, ohne gebündelte Node-Laufzeit). Der Befehl ist ein
// kleiner Starter, der das Bundle der App mit der vorhandenen Node (≥ 22) startet. Installiert nur, wo keine fremde
// Datei liegt, und entfernt nur den eigenen Starter (Kennzeichen-Zeile).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { desktopPlaces, type DesktopChannel } from "@based/core";

/** Kennzeichen eines von Based installierten Starters (jede App/jeder Kanal). */
export const STARTER_PREFIX = "# based-cli-starter (";
export const STARTER_MARK = "# based-cli-starter (Based Next)";
/** BSD-455: Kennzeichen pro Kanal – die Beta entfernt/überschreibt nie den Starter von Based Next und umgekehrt. */
export const starterMark = (channel: DesktopChannel = "next") => `${STARTER_PREFIX}${desktopPlaces(channel).appName})`;
export const MIN_NODE_MAJOR = 22;

/** Standardort: ~/.local/bin/based (braucht kein sudo); Based Beta: ~/.local/bin/based-beta (BSD-455). */
export const defaultTarget = (home: string, channel: DesktopChannel = "next") => join(home, ".local", "bin", desktopPlaces(channel).cliName);

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Inhalt des Starters. Die Beta gibt ihren Kanal mit, damit `based-beta` den lokalen Server der Beta findet. */
export function starterScript(node: string, bundle: string, channel: DesktopChannel = "next"): string {
  const app = desktopPlaces(channel).appName;
  return [
    "#!/bin/sh",
    starterMark(channel),
    `# Runs the Based command line tool with your Node.js. Uninstall in ${app}: Settings → Sync & server.`,
    ...(channel === "next" ? [] : [`BASED_CHANNEL=${channel}; export BASED_CHANNEL`]),
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

export function installStarter(o: { target: string; node: string; nodeVersion: string; bundle: string; path?: string | undefined; channel?: DesktopChannel }): InstallResult {
  const channel = o.channel ?? "next";
  const major = nodeMajor(o.nodeVersion);
  if (major === undefined || major < MIN_NODE_MAJOR) {
    return { ok: false, target: o.target, message: `Node.js ${MIN_NODE_MAJOR} or newer is needed (found ${o.nodeVersion || "none"}).` };
  }
  if (!o.target.startsWith("/")) return { ok: false, target: o.target, message: "The install location must be an absolute path." };
  if (!existsSync(o.bundle)) return { ok: false, target: o.target, message: `The app's command line bundle is missing (${o.bundle}).` };
  if (existsSync(o.target)) {
    let current = "";
    try { current = readFileSync(o.target, "utf8"); } catch { current = ""; }
    if (!current.includes(STARTER_PREFIX)) return { ok: false, target: o.target, message: `${o.target} already exists and wasn't installed by Based. Choose another location or remove it first.` };
    if (!current.includes(starterMark(channel))) return { ok: false, target: o.target, message: `${o.target} belongs to another Based app. Choose another location (for example ${defaultTarget("~", channel)}).` };
  }
  try {
    mkdirSync(dirname(o.target), { recursive: true });
    const tmp = `${o.target}.${process.pid}.tmp`;
    writeFileSync(tmp, starterScript(o.node, o.bundle, channel), { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, o.target);
  } catch (e) {
    return { ok: false, target: o.target, message: `Couldn't write ${o.target}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const inPath = (o.path ?? "").split(delimiter).includes(dirname(o.target));
  const name = o.target.split("/").pop() || "based";
  return { ok: true, target: o.target, inPath, message: inPath ? `Installed. Run \`${name} --help\` in a new terminal.` : `Installed. ${dirname(o.target)} isn't in your PATH yet — add it to your shell profile, or run ${o.target} directly.` };
}

export function uninstallStarter(target: string, channel: DesktopChannel = "next"): InstallResult {
  if (!existsSync(target)) return { ok: true, target, message: "Not installed." };
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { current = ""; }
  if (current.includes(STARTER_PREFIX) && !current.includes(starterMark(channel))) return { ok: false, target, message: `${target} belongs to another Based app — left it alone.` };
  if (!current.includes(starterMark(channel))) return { ok: false, target, message: `${target} wasn't installed by Based — left it alone.` };
  rmSync(target, { force: true });
  return { ok: true, target, message: "Removed." };
}

export function starterStatus(target: string, channel: DesktopChannel = "next"): { installed: boolean; target: string } {
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { return { installed: false, target }; }
  return { installed: current.includes(starterMark(channel)), target };
}
