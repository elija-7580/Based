// BSD-138: lokaler based-server als Beilage der Desktop-App (Tauri-Sidecar). Damit laufen die Kommandozeile `based`
// und die Coding-Agenten (BSD-223/257) ohne eigenen Server. Die Hülle hat dafür keine eigene Rust-Logik: hier startet
// und stoppt das offizielle Shell-Plugin genau diese eine Beilage (capabilities/local-server.json).
// - Nur 127.0.0.1, fester Port (die Sync-Verbindung bleibt nach einem Neustart gültig), Token von der App erzeugt und
//   in der verschlüsselten Ablage; er geht über die Umgebung an den Prozess, nie über die Kommandozeile.
// - Der Server schreibt ~/.config/based/local.json (+ Token-Datei 0600) für die CLI und endet, wenn die App endet
//   (stdin zu).
// Im Browser tut nichts davon etwas.
import { isTauri } from "../desktop.js";
import { secretVault } from "../shell/storage.js";

export const LOCAL_SERVER_PORT = 47821;
export const SIDECAR = "binaries/based-server";
const SETTINGS_KEY = "based.localServer";
const TOKEN_SECRET = "local-server-token";

export type LocalServerStatus = "off" | "starting" | "running" | "failed" | "unavailable";

export interface LocalServerState {
  status: LocalServerStatus;
  enabled: boolean;
  url: string | undefined;
  error: string | undefined;
  /** Letzte Zeilen von stderr (Diagnose, ohne Token). */
  log: string[];
}

/** Argumente der Beilage (Token kommt über BASED_TOKEN). */
export function sidecarArgs(o: { db: string; home: string; port?: number }): string[] {
  return ["--local", "--port", String(o.port ?? LOCAL_SERVER_PORT), "--db", o.db, "--coding-root", o.home];
}

/** `BASED_LOCAL_READY {"url":…,"pid":…}` → Adresse (nur Loopback). */
export function parseReady(line: string): { url: string; pid: number } | undefined {
  const m = /^BASED_LOCAL_READY (\{.*\})\s*$/.exec(line.trim());
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[1]!) as { url?: unknown; pid?: unknown };
    if (typeof v.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(v.url)) return undefined;
    return { url: v.url, pid: typeof v.pid === "number" ? v.pid : 0 };
  } catch {
    return undefined;
  }
}

/** Befehl, der `based` in den PATH legt (Symlink auf die Beilage; als `based` aufgerufen spielt sie die CLI). */
export function installCommand(sidecarPath: string): string {
  return `sudo ln -sf '${sidecarPath.replace(/'/g, "'\\''")}' /usr/local/bin/based`;
}

/** Pfad der Beilage im App-Paket (macOS: neben der App-Binärdatei in Contents/MacOS). */
export function sidecarPathFor(resourceDir: string): string {
  return resourceDir.replace(/\/Resources\/?$/, "/MacOS") + "/based-server";
}

/** Zufälliger Token (32 Byte, base64url). */
export function newToken(random: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  const bytes = random(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Child { kill(): Promise<void> }

function readEnabled(): boolean {
  try {
    return (JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? "{}") as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

class LocalServer {
  private state: LocalServerState = { status: isTauri() ? "off" : "unavailable", enabled: readEnabled(), url: undefined, error: undefined, log: [] };
  private listeners = new Set<() => void>();
  private child: Child | undefined;
  private starting: Promise<void> | undefined;

  getState = (): LocalServerState => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(patch: Partial<LocalServerState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Token aus der verschlüsselten Ablage (beim ersten Mal erzeugt). */
  async token(): Promise<string> {
    const store = secretVault();
    const t = await store.getSecret(TOKEN_SECRET);
    if (t) return t;
    const fresh = newToken();
    await store.setSecret(TOKEN_SECRET, fresh);
    return fresh;
  }

  async setEnabled(on: boolean): Promise<void> {
    try {
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify({ enabled: on }));
    } catch {
      // nur für diese Sitzung
    }
    this.set({ enabled: on });
    if (on) await this.start();
    else await this.stop();
  }

  /** Beim Start der App: läuft, wenn eingeschaltet. */
  async autostart(): Promise<void> {
    if (this.state.enabled) await this.start().catch(() => undefined);
  }

  start(): Promise<void> {
    if (!isTauri()) return Promise.resolve();
    if (this.child || this.starting) return this.starting ?? Promise.resolve();
    this.starting = this.spawn().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async spawn(): Promise<void> {
    this.set({ status: "starting", error: undefined, log: [] });
    try {
      const [{ Command }, path] = await Promise.all([import("@tauri-apps/plugin-shell"), import("@tauri-apps/api/path")]);
      const [data, home] = await Promise.all([path.appDataDir(), path.homeDir()]);
      const db = await path.join(data, "local-server.sqlite");
      const cmd = Command.sidecar(SIDECAR, sidecarArgs({ db, home }), { env: { BASED_TOKEN: await this.token(), BASED_LOCAL_OWNER: "Based Next", BASED_LOG_LEVEL: "warning" } });
      cmd.stdout.on("data", (line: string) => {
        const r = parseReady(line);
        if (r) this.set({ status: "running", url: r.url });
      });
      cmd.stderr.on("data", (line: string) => this.set({ log: [...this.state.log, line].slice(-20) }));
      cmd.on("close", (e: { code: number | null }) => {
        this.child = undefined;
        if (this.state.status !== "off") this.set({ status: e.code === 0 ? "off" : "failed", url: undefined, error: e.code === 0 ? undefined : `The local server stopped (exit ${e.code ?? "?"}). ${this.state.log.at(-1) ?? ""}`.trim() });
      });
      cmd.on("error", (e: string) => this.set({ status: "failed", error: e }));
      this.child = await cmd.spawn();
    } catch (e) {
      this.child = undefined;
      this.set({ status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  async stop(): Promise<void> {
    const c = this.child;
    this.child = undefined;
    this.set({ status: isTauri() ? "off" : "unavailable", url: undefined });
    await c?.kill().catch(() => undefined);
  }

  /** Sync-Verbindung zu diesem Server (Adresse + Token), z. B. wenn sonst keiner eingestellt ist. */
  async syncConfig(): Promise<{ url: string; token: string } | undefined> {
    if (this.state.status !== "running" || !this.state.url) return undefined;
    return { url: this.state.url, token: await this.token() };
  }

  /** Pfad der Beilage und Befehl für „Install Command Line Tool…“. */
  async cliInstall(): Promise<{ path: string; command: string } | undefined> {
    if (!isTauri()) return undefined;
    const { resourceDir } = await import("@tauri-apps/api/path");
    const path = sidecarPathFor(await resourceDir());
    return { path, command: installCommand(path) };
  }
}

let shared: LocalServer | undefined;
export const localServer = (): LocalServer => (shared ??= new LocalServer());
