// BSD-138: lokaler based-server und die Kommandozeile `based` aus der Desktop-App – beides nur per Opt-in und ohne
// gebündelte Node-Laufzeit. Der App liegt nur ein JavaScript-Bundle bei (Resource `based-server.cjs`); es läuft mit
// der Node des Nutzers (≥ 22), gefunden über die Login-Shell wie im Terminal. Die Hülle hat keine eigene Rust-Logik:
// das offizielle Shell-Plugin darf genau zwei feste Aufrufe (capabilities/local-server.json):
//   based-node-probe  /bin/zsh -ilc 'command -v node && node --version'
//   based-node-run    /bin/zsh -ilc 'exec node "$BASED_BUNDLE" desktop'   (was zu tun ist: BASED_ACTION)
// - Lokaler Server: nur 127.0.0.1, fester Port; Token von der App erzeugt, in ihrer verschlüsselten Ablage, an den
//   Prozess über die Umgebung (nie Kommandozeile). Er schreibt ~/.config/based/local.json (+ Token-Datei 0600) für
//   die CLI und endet mit der App (stdin zu).
// - Kommandozeile: ein kleiner Starter (Standard ~/.local/bin/based), der das Bundle mit dieser Node startet;
//   „Uninstall“ entfernt nur den eigenen Starter.
// Im Browser tut nichts davon etwas.
import { isTauri } from "../desktop.js";
import { secretVault } from "../shell/storage.js";

export const LOCAL_SERVER_PORT = 47821;
export const MIN_NODE_MAJOR = 22;
export const PROBE = { name: "based-node-probe", args: ["-ilc", "command -v node && node --version"] } as const;
export const RUN = { name: "based-node-run", args: ["-ilc", 'exec node "$BASED_BUNDLE" desktop'] } as const;
const SETTINGS_KEY = "based.localServer";
const TOKEN_SECRET = "local-server-token";

export type LocalServerStatus = "off" | "starting" | "running" | "failed" | "unavailable";

export interface NodeInfo { ok: boolean; path: string | undefined; version: string | undefined; message: string }
export interface CliState { installed: boolean; target: string | undefined; message: string | undefined; busy: boolean }

export interface LocalServerState {
  status: LocalServerStatus;
  enabled: boolean;
  url: string | undefined;
  error: string | undefined;
  /** Letzte Zeilen von stderr (Diagnose, ohne Token). */
  log: string[];
  node: NodeInfo | undefined;
  cli: CliState;
}

/** Ausgabe von `command -v node && node --version` deuten. */
export function parseNodeProbe(stdout: string, code: number | null): NodeInfo {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const path = lines.find((l) => l.startsWith("/"));
  const version = lines.find((l) => /^v\d+\.\d+/.test(l));
  const fix = "Install Node.js 22 or newer (for example `brew install node`, or from nodejs.org), then try again.";
  if (code !== 0 || !path || !version) return { ok: false, path, version, message: `Node.js wasn't found in your login shell. ${fix}` };
  const major = Number(/^v(\d+)/.exec(version)![1]);
  if (major < MIN_NODE_MAJOR) return { ok: false, path, version, message: `Node.js ${version} is too old. ${fix}` };
  return { ok: true, path, version, message: `Node.js ${version} (${path})` };
}

/** `BASED_RESULT {…}` aus der Ausgabe einer Aktion. */
export function parseResult(stdout: string): { ok: boolean; message?: string; target?: string; installed?: boolean; inPath?: boolean } | undefined {
  const m = /BASED_RESULT (\{.*\})/.exec(stdout);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!) as ReturnType<typeof parseResult>;
  } catch {
    return undefined;
  }
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

/** Umgebung für einen Aufruf des Bundles (nur BASED_*; PATH usw. liefert die Login-Shell). */
export function actionEnv(bundle: string, action: "local" | "install-cli" | "uninstall-cli" | "cli-status", extra: Record<string, string> = {}): Record<string, string> {
  return { BASED_BUNDLE: bundle, BASED_ACTION: action, ...extra };
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
  private state: LocalServerState = {
    status: isTauri() ? "off" : "unavailable", enabled: readEnabled(), url: undefined, error: undefined, log: [], node: undefined,
    cli: { installed: false, target: undefined, message: undefined, busy: false },
  };
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
  private setCli(patch: Partial<CliState>) { this.set({ cli: { ...this.state.cli, ...patch } }); }

  /** Token aus der verschlüsselten Ablage (beim ersten Mal erzeugt). */
  async token(): Promise<string> {
    const store = secretVault();
    const t = await store.getSecret(TOKEN_SECRET);
    if (t) return t;
    const fresh = newToken();
    await store.setSecret(TOKEN_SECRET, fresh);
    return fresh;
  }

  private async bundle(): Promise<string> {
    const { resolveResource } = await import("@tauri-apps/api/path");
    return resolveResource("based-server.cjs");
  }

  /** Node über die Login-Shell suchen (nichts wird installiert oder geladen). */
  async probeNode(): Promise<NodeInfo | undefined> {
    if (!isTauri()) return undefined;
    try {
      const { Command } = await import("@tauri-apps/plugin-shell");
      const r = await Command.create(PROBE.name, [...PROBE.args]).execute();
      const info = parseNodeProbe(r.stdout, r.code);
      this.set({ node: info });
      return info;
    } catch (e) {
      const info: NodeInfo = { ok: false, path: undefined, version: undefined, message: `Couldn't look for Node.js: ${e instanceof Error ? e.message : String(e)}` };
      this.set({ node: info });
      return info;
    }
  }

  private async action(action: "install-cli" | "uninstall-cli" | "cli-status", extra: Record<string, string> = {}) {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const r = await Command.create(RUN.name, [...RUN.args], { env: actionEnv(await this.bundle(), action, extra) }).execute();
    return parseResult(r.stdout) ?? { ok: false, message: (r.stderr.trim().split("\n").at(-1) ?? "") || `exit ${r.code ?? "?"}` };
  }

  /** Ist `based` installiert (am Standardort bzw. `target`)? */
  async cliStatus(target?: string): Promise<void> {
    if (!isTauri()) return;
    const node = this.state.node ?? (await this.probeNode());
    if (!node?.ok) return;
    const r = await this.action("cli-status", target ? { BASED_TARGET: target } : {}).catch(() => undefined);
    if (r) this.setCli({ installed: r.installed === true, target: r.target });
  }

  async installCli(target?: string): Promise<void> {
    this.setCli({ busy: true, message: undefined });
    try {
      const node = await this.probeNode();
      if (!node?.ok) { this.setCli({ message: node?.message }); return; }
      const r = await this.action("install-cli", target ? { BASED_TARGET: target } : {});
      this.setCli({ installed: r.ok || this.state.cli.installed, target: r.target ?? target, message: r.message });
    } catch (e) {
      this.setCli({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.setCli({ busy: false });
    }
  }

  async uninstallCli(target?: string): Promise<void> {
    this.setCli({ busy: true, message: undefined });
    try {
      const r = await this.action("uninstall-cli", target ? { BASED_TARGET: target } : {});
      this.setCli({ installed: r.ok ? false : this.state.cli.installed, message: r.message });
    } catch (e) {
      this.setCli({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.setCli({ busy: false });
    }
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

  /** Beim Start der App: läuft nur, wenn eingeschaltet. */
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
      const node = await this.probeNode();
      if (!node?.ok) { this.set({ status: "failed", error: node?.message }); return; }
      const [{ Command }, path] = await Promise.all([import("@tauri-apps/plugin-shell"), import("@tauri-apps/api/path")]);
      const [data, home, bundle] = await Promise.all([path.appDataDir(), path.homeDir(), this.bundle()]);
      const db = await path.join(data, "local-server.sqlite");
      const env = actionEnv(bundle, "local", {
        BASED_DB: db, BASED_PORT: String(LOCAL_SERVER_PORT), BASED_CODING_ROOT: home,
        BASED_TOKEN: await this.token(), BASED_LOCAL_OWNER: "Based Next", BASED_LOG_LEVEL: "warning",
      });
      const cmd = Command.create(RUN.name, [...RUN.args], { env });
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
}

let shared: LocalServer | undefined;
export const localServer = (): LocalServer => (shared ??= new LocalServer());
