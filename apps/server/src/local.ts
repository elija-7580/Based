// BSD-138: lokaler based-server als Sidecar der Desktop-App („ohne Server“). Die Hülle startet ihn mit `--local`:
// nur 127.0.0.1, freier Port, Token aus der Umgebung (BASED_TOKEN, von der App erzeugt – nie auf der Kommandozeile).
// Damit die Kommandozeile (`based`) ihn findet, schreibt er eine Discovery-Datei (Adresse, PID, Pfad der Token-Datei;
// ohne Token) und den Token in eine eigene Datei, beide nur für den Besitzer lesbar (0600). Beim Beenden räumt er
// beides weg – aber nur, wenn die Dateien noch zu diesem Prozess gehören (ein zweiter Start überschreibt sie).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LocalDiscovery {
  v: 1;
  /** `http://127.0.0.1:<port>` */
  url: string;
  pid: number;
  startedAt: string;
  /** Datei mit dem Token (0600). */
  tokenFile: string;
  /** Wer gestartet hat (z. B. „Based Next“). */
  owner: string;
}

/** Feste Orte (wie `~/.config/based/config.json` der CLI). */
export const localPaths = (home: string) => ({
  discovery: join(home, ".config", "based", "local.json"),
  token: join(home, ".config", "based", "local-token"),
});

/** Zufälliger Token (32 Byte, base64url), falls die Hülle keinen mitgibt. */
export const newLocalToken = () => randomBytes(32).toString("base64url");

/** Atomar schreiben, nur für den Besitzer lesbar. */
function writePrivate(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function writeLocalDiscovery(home: string, input: { port: number; token: string; pid?: number; owner?: string; now?: Date }): LocalDiscovery {
  const p = localPaths(home);
  const d: LocalDiscovery = {
    v: 1,
    url: `http://127.0.0.1:${input.port}`,
    pid: input.pid ?? process.pid,
    startedAt: (input.now ?? new Date()).toISOString(),
    tokenFile: p.token,
    owner: input.owner ?? "based-server --local",
  };
  writePrivate(p.token, input.token + "\n");
  writePrivate(p.discovery, JSON.stringify(d, null, 2) + "\n");
  return d;
}

/** Discovery und Token entfernen, wenn sie noch zu `pid` gehören. */
export function removeLocalDiscovery(home: string, pid: number = process.pid): boolean {
  const p = localPaths(home);
  let mine = false;
  try {
    mine = (JSON.parse(readFileSync(p.discovery, "utf8")) as { pid?: unknown }).pid === pid;
  } catch {
    return false;
  }
  if (!mine) return false;
  rmSync(p.discovery, { force: true });
  rmSync(p.token, { force: true });
  return true;
}

/**
 * PATH der Login-Shell. Aus dem Finder gestartete Apps bekommen nur /usr/bin:/bin:…; Coding-Agenten (npx, codex,
 * claude aus Homebrew/nvm) fände der Sidecar sonst nicht. Fehler → `undefined` (dann bleibt der PATH, wie er ist).
 */
export function loginShellPath(shell: string | undefined, run: (shell: string) => string = (sh) => execFileSync(sh, ["-ilc", 'printf "__BASED_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const out = run(shell && shell.startsWith("/") ? shell : "/bin/zsh");
    const path = out.slice(out.lastIndexOf("__BASED_PATH__") + "__BASED_PATH__".length).trim();
    return out.includes("__BASED_PATH__") && path.includes("/") ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Login-PATH vorn, bisherige Einträge dahinter (ohne Doppelte). */
export function mergePath(login: string | undefined, current: string | undefined): string | undefined {
  if (!login) return current;
  const seen = new Set<string>();
  return [...login.split(":"), ...(current ?? "").split(":")].filter((p) => p !== "" && !seen.has(p) && (seen.add(p), true)).join(":");
}

/**
 * BSD-424: Der Port ist belegt. Gehört er laut Discovery-Datei einem älteren lokalen Server desselben Starters (z. B.
 * nach einem Absturz der App übrig geblieben) und antwortet dort ein based-server, wird dieser beendet, damit der neue
 * starten kann. Alles andere (fremdes Programm, von Hand gestarteter Server) bleibt unberührt.
 *   "replaced" – alter Server beendet, Port wieder frei
 *   "foreign"  – Port gehört einem anderen Programm oder Starter
 */
export interface StaleLocalDeps {
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  health?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** Wie lange auf das Ende des alten Prozesses gewartet wird (ms). */
  waitMs?: number;
}

const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const basedHealth = async (url: string) => {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    const v = (await r.json()) as { name?: unknown };
    return r.ok && v.name === "based-server";
  } catch {
    return false;
  }
};

export async function replaceStaleLocal(home: string, port: number, owner: string, deps: StaleLocalDeps = {}): Promise<"replaced" | "foreign"> {
  const alive = deps.alive ?? isAlive;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const health = deps.health ?? basedHealth;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let d: Partial<LocalDiscovery>;
  try { d = JSON.parse(readFileSync(localPaths(home).discovery, "utf8")) as Partial<LocalDiscovery>; } catch { return "foreign"; }
  const url = `http://127.0.0.1:${port}`;
  if (d.url !== url || d.owner !== owner || typeof d.pid !== "number" || d.pid <= 1 || d.pid === process.pid) return "foreign";
  if (!alive(d.pid) || !(await health(url))) return "foreign";
  kill(d.pid, "SIGTERM");
  const waitMs = deps.waitMs ?? 5000;
  for (let t = 0; t < waitMs && alive(d.pid); t += 100) await sleep(100);
  if (alive(d.pid)) {
    try { kill(d.pid, "SIGKILL"); } catch { /* schon weg */ }
    await sleep(200);
  }
  return "replaced";
}

/** BSD-424: verständliche Meldung statt Stacktrace, wenn der Port belegt ist. */
export function portInUseMessage(port: number): string {
  return `Port ${port} is already in use by another program, so the local server can't start. Quit that program (or restart the Mac) and turn the local server on again.`;
}
