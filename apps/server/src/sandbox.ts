// Sandbox pro Lauf (BSD-161, Swift `Sandbox.swift`, `SandboxPart3/4.swift`): Agenten mit Shell laufen auf dem Server
// in einem Docker-Container je Lauf (Projektordner unter /workspace/<projekt>), lokal (Tests, eigener Rechner)
// direkt im Projektordner. Beides lässt sich als Snapshot sichern und wiederherstellen.
//
// Der Docker-Provider steuert die `docker`-CLI über einen `CommandRunner`; die Kommandozeilen sind damit ohne Docker
// testbar. Geheimnisse stehen nie in argv: Umgebungsvariablen gehen als `-e NAME` (Wert aus der Umgebung der
// docker-CLI selbst), und nur Namen auf der Allowlist kommen überhaupt durch. Ins Log kommen keine Werte.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";

export interface SandboxSpec {
  /** Projektname: Teil des Containernamens und des Mount-Punkts (/workspace/<slug>). */
  project: string;
  /** Ordner auf dem Host mit den Projektdateien (rw in den Container gebunden). */
  hostWorkspace: string;
  image?: string;
  cpus?: number;
  memoryMB?: number;
  /** Netz an (Standard, Paketinstallationen); aus = `--network none`. */
  network?: boolean;
  /** Nur-Lese-Mounts Host → Container (z. B. Login-Ordner der Agent-CLIs). */
  readOnlyMounts?: { host: string; container: string }[];
  /** Lauf, dem die Sandbox gehört (Label; ein Container je Lauf). */
  runID?: string;
  /** `host.docker.internal` zeigt auf den Host (MCP-Endpunkt von Based). */
  hostGateway?: boolean;
}

export const DEFAULT_IMAGE = "based-sandbox:latest";

export interface SandboxSnapshot {
  name: string;
  /** Image-Tag (docker), leer bei lokal. */
  image: string;
  /** tar.gz des Projektordners auf dem Host. */
  archive: string;
  createdAt: string;
}

export interface SandboxHandle {
  provider: "docker" | "local";
  /** Container-ID (docker) oder Projektordner (lokal). */
  id: string;
  project: string;
  /** Arbeitsordner, wie ihn der Agent in der Sandbox sieht. */
  workdir: string;
  hostWorkspace: string;
  image: string;
  runID?: string;
  snapshots: SandboxSnapshot[];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Startet ein Programm und sammelt die Ausgabe. `env` ist die *vollständige* Umgebung des Kindprozesses. */
export interface CommandRunner {
  run(executable: string, args: string[], env: Record<string, string>, cwd?: string): Promise<ExecResult>;
}

/** Echte Prozesse (nichts aus der Server-Umgebung wird geerbt). */
export class ProcessCommandRunner implements CommandRunner {
  run(executable: string, args: string[], env: Record<string, string>, cwd?: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env, ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [], err: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    });
  }
}

// MARK: Umgebung

const SECRET_PARTS = ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "APIKEY", "PRIVATE", "CREDENTIAL", "AUTH", "COOKIE", "SESSION"];

/**
 * Welche Umgebungsvariablen ein Agent in der Sandbox bekommt: nur Namen auf der Allowlist; Namen, die nach Geheimnis
 * aussehen, zusätzlich nur, wenn sie ausdrücklich in `secrets` stehen. Logins kommen aus nur lesbar gemounteten
 * Ordnern, nicht aus der Umgebung.
 */
export class SandboxEnvironmentPolicy {
  static readonly defaultAllow: readonly string[] = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "NO_COLOR", "CI", "COLORTERM"];
  readonly allow: Set<string>;
  readonly secrets: Set<string>;

  constructor(opts: { allow?: Iterable<string>; secrets?: Iterable<string> } = {}) {
    this.allow = new Set(opts.allow ?? SandboxEnvironmentPolicy.defaultAllow);
    this.secrets = new Set(opts.secrets ?? []);
  }

  static looksSecret(name: string): boolean {
    const n = name.toUpperCase();
    return SECRET_PARTS.some((p) => n.includes(p)) || n.endsWith("_KEY") || n === "KEY";
  }

  static validName(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  filter(source: Record<string, string | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined || !SandboxEnvironmentPolicy.validName(k)) continue;
      if (this.secrets.has(k) || (this.allow.has(k) && !SandboxEnvironmentPolicy.looksSecret(k))) out[k] = v;
    }
    return out;
  }
}

/** Die wenigen Variablen, die die docker-CLI braucht – sonst nichts aus der Server-Umgebung. */
export function dockerCLIEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  out.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  return out;
}

// MARK: Namen

/** Kleinbuchstaben-Slug für Containernamen, Image-Tags und Pfade. */
export function slug(s: string): string {
  const parts = s.toLowerCase().replace(/[^a-z0-9]/g, "-").split("-").filter(Boolean);
  return parts.length === 0 ? "project" : parts.join("-").slice(0, 48);
}

/** Snapshot-Namen: Buchstaben, Ziffern, „.“, „_“, „-“ (max. 64), nicht mit „.“ oder „-“ am Anfang. */
export function validSnapshotName(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(s);
}

const workdirFor = (project: string) => "/workspace/" + slug(project);
export const SANDBOX_HOST = "host.docker.internal";
const BACKUP_MARKER = ".before-restore-";
export const SNAPSHOT_IMAGE_PREFIX = "based-snapshot/";

async function must(runner: CommandRunner, label: string, exe: string, args: string[], env: Record<string, string>, cwd?: string): Promise<ExecResult> {
  const r = await runner.run(exe, args, env, cwd);
  if (r.exitCode !== 0) throw new SandboxError(`${label} failed (${r.exitCode}): ${r.stderr.slice(0, 300)}`);
  return r;
}

async function archive(runner: CommandRunner, env: Record<string, string>, folder: string, to: string) {
  await must(runner, "mkdir", "mkdir", ["-p", dirname(to)], env);
  await must(runner, "tar", "tar", ["-C", folder, "-czf", to, "."], env);
}

/** Ordner wiederherstellen; der aktuelle bleibt daneben als `<ordner>.before-restore-<zeit>` (nichts wird gelöscht). */
async function unarchive(runner: CommandRunner, env: Record<string, string>, from: string, folder: string, nowMillis: number) {
  const aside = folder + BACKUP_MARKER + Math.floor(nowMillis / 1000);
  await must(runner, "mv", "mv", [folder, aside], env);
  await must(runner, "mkdir", "mkdir", ["-p", folder], env);
  await must(runner, "tar", "tar", ["-C", folder, "-xzf", from], env);
}

// MARK: Provider

export interface SandboxProvider {
  readonly kind: "docker" | "local";
  readonly runner: CommandRunner;
  readonly snapshotDirectory: string;
  readonly baseEnvironment: Record<string, string>;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** Ein Kommando in der Sandbox bis zum Ende. `env` vorher durch die Allowlist filtern. */
  exec(s: SandboxHandle, command: string[], env?: Record<string, string>): Promise<ExecResult>;
  snapshot(s: SandboxHandle, name: string): Promise<SandboxHandle>;
  restore(s: SandboxHandle, name: string): Promise<SandboxHandle>;
  /** Entfernt den Container. Löscht nie den Projektordner. */
  destroy(s: SandboxHandle): Promise<void>;
}

export interface ProviderOptions {
  runner?: CommandRunner;
  snapshotDirectory: string;
  baseEnvironment?: Record<string, string>;
  now?: () => number;
}

/** Ein Container je Lauf, über die `docker`-CLI. */
export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly runner: CommandRunner;
  readonly snapshotDirectory: string;
  readonly baseEnvironment: Record<string, string>;
  readonly docker: string;
  private readonly now: () => number;

  constructor(opts: ProviderOptions & { docker?: string }) {
    this.runner = opts.runner ?? new ProcessCommandRunner();
    this.snapshotDirectory = opts.snapshotDirectory;
    this.baseEnvironment = opts.baseEnvironment ?? dockerCLIEnvironment();
    this.docker = opts.docker ?? "docker";
    this.now = opts.now ?? Date.now;
  }

  /** `docker run`-Argumente für einen neuen Container. */
  runArguments(spec: SandboxSpec, name: string, image = spec.image ?? DEFAULT_IMAGE): string[] {
    const a = ["run", "-d", "--name", name, "--init", "--label", "based.sandbox=1", "--label", `based.project=${slug(spec.project)}`];
    if (spec.runID) a.push("--label", `based.run=${spec.runID}`);
    a.push("--cpus", String(spec.cpus ?? 2), "--memory", `${spec.memoryMB ?? 4096}m`, "--pids-limit", "1024", "--security-opt", "no-new-privileges", "--cap-drop", "ALL");
    const network = spec.network ?? true;
    if (!network) a.push("--network", "none");
    if (network && spec.hostGateway) a.push("--add-host", `${SANDBOX_HOST}:host-gateway`);
    const wd = workdirFor(spec.project);
    a.push("-v", `${spec.hostWorkspace}:${wd}`);
    for (const m of spec.readOnlyMounts ?? []) a.push("-v", `${m.host}:${m.container}:ro`);
    a.push("-w", wd, image, "sleep", "infinity");
    return a;
  }

  /** `docker exec`-Argumente; Werte nie in argv, nur `-e NAME`. */
  execArguments(s: SandboxHandle, command: string[], env: Record<string, string>, interactive = false): string[] {
    const a = ["exec"];
    if (interactive) a.push("-i");
    a.push("-w", s.workdir);
    for (const k of Object.keys(env).sort()) a.push("-e", k);
    return [...a, s.id, ...command];
  }

  private call(args: string[], extra: Record<string, string> = {}) {
    return must(this.runner, `docker ${args[0] ?? ""}`, this.docker, args, { ...this.baseEnvironment, ...extra });
  }

  private containerName(spec: SandboxSpec): string {
    const suffix = spec.runID ? slug(spec.runID) : randomUUID().slice(0, 8);
    return `based-${slug(spec.project)}-${suffix.slice(0, 24)}`;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const r = await this.call(this.runArguments(spec, this.containerName(spec)));
    const id = r.stdout.trim();
    if (!id) throw new SandboxError("docker run returned no container id");
    return { provider: "docker", id, project: spec.project, workdir: workdirFor(spec.project), hostWorkspace: spec.hostWorkspace, image: spec.image ?? DEFAULT_IMAGE, ...(spec.runID ? { runID: spec.runID } : {}), snapshots: [] };
  }

  exec(s: SandboxHandle, command: string[], env: Record<string, string> = {}): Promise<ExecResult> {
    // Die Werte erreichen `docker exec -e NAME` über die Umgebung der docker-CLI.
    return this.runner.run(this.docker, this.execArguments(s, command, env), { ...this.baseEnvironment, ...env });
  }

  snapshotImage(s: SandboxHandle, name: string) {
    return `${SNAPSHOT_IMAGE_PREFIX}${slug(s.project)}:${name}`;
  }

  /** Snapshot = `docker commit` (installierte Pakete, Caches) + tar.gz des Projektordners. */
  async snapshot(s: SandboxHandle, name: string): Promise<SandboxHandle> {
    if (!validSnapshotName(name)) throw new SandboxError(`Invalid snapshot name: ${name}`);
    const image = this.snapshotImage(s, name);
    await this.call(["commit", "--pause=true", "--message", `Based snapshot ${name}`, s.id, image]);
    const file = join(this.snapshotDirectory, `${slug(s.project)}-${name}.tar.gz`);
    await archive(this.runner, this.baseEnvironment, s.hostWorkspace, file);
    return { ...s, snapshots: [...s.snapshots.filter((x) => x.name !== name), { name, image, archive: file, createdAt: new Date(this.now()).toISOString() }] };
  }

  /** Container durch einen aus dem Snapshot-Image ersetzen und den Ordner zurücklegen. */
  async restore(s: SandboxHandle, name: string): Promise<SandboxHandle> {
    const snap = s.snapshots.find((x) => x.name === name);
    if (!snap) throw new SandboxError(`Unknown snapshot: ${name}`);
    await this.call(["rm", "-f", s.id]);
    await unarchive(this.runner, this.baseEnvironment, snap.archive, s.hostWorkspace, this.now());
    const spec: SandboxSpec = { project: s.project, hostWorkspace: s.hostWorkspace, image: snap.image, ...(s.runID ? { runID: s.runID } : {}) };
    const r = await this.call(this.runArguments(spec, `based-${slug(s.project)}-${slug(name)}-${Math.floor(this.now() / 1000)}`, snap.image));
    return { ...s, id: r.stdout.trim(), image: snap.image };
  }

  async destroy(s: SandboxHandle): Promise<void> {
    await this.call(["rm", "-f", s.id]);
  }

  /** Container mit dem Label `based.sandbox=1`, die kein lebender Lauf mehr kennt (z. B. nach einem Absturz). */
  async orphans(known: Set<string>): Promise<string[]> {
    const r = await this.call(["ps", "-a", "--filter", "label=based.sandbox=1", "--format", "{{.ID}}"]);
    return r.stdout.split(/\s+/).filter((id) => id && ![...known].some((k) => k.startsWith(id) || id.startsWith(k)));
  }
}

/** Ohne Container: der Agent arbeitet direkt im Projektordner. Snapshots sind tar.gz-Archive. */
export class LocalSandboxProvider implements SandboxProvider {
  readonly kind = "local" as const;
  readonly runner: CommandRunner;
  readonly snapshotDirectory: string;
  readonly baseEnvironment: Record<string, string>;
  private readonly now: () => number;

  constructor(opts: ProviderOptions) {
    this.runner = opts.runner ?? new ProcessCommandRunner();
    this.snapshotDirectory = opts.snapshotDirectory;
    this.baseEnvironment = opts.baseEnvironment ?? { PATH: "/usr/local/bin:/usr/bin:/bin" };
    this.now = opts.now ?? Date.now;
  }

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    return Promise.resolve({ provider: "local", id: spec.hostWorkspace, project: spec.project, workdir: spec.hostWorkspace, hostWorkspace: spec.hostWorkspace, image: "", ...(spec.runID ? { runID: spec.runID } : {}), snapshots: [] });
  }

  exec(s: SandboxHandle, command: string[], env: Record<string, string> = {}): Promise<ExecResult> {
    const [exe, ...args] = command;
    if (!exe) return Promise.reject(new SandboxError("empty command"));
    return this.runner.run(exe, args, { ...this.baseEnvironment, ...env }, s.workdir);
  }

  async snapshot(s: SandboxHandle, name: string): Promise<SandboxHandle> {
    if (!validSnapshotName(name)) throw new SandboxError(`Invalid snapshot name: ${name}`);
    const file = join(this.snapshotDirectory, `${slug(s.project)}-${name}.tar.gz`);
    await archive(this.runner, this.baseEnvironment, s.hostWorkspace, file);
    return { ...s, snapshots: [...s.snapshots.filter((x) => x.name !== name), { name, image: "", archive: file, createdAt: new Date(this.now()).toISOString() }] };
  }

  async restore(s: SandboxHandle, name: string): Promise<SandboxHandle> {
    const snap = s.snapshots.find((x) => x.name === name);
    if (!snap) throw new SandboxError(`Unknown snapshot: ${name}`);
    await unarchive(this.runner, this.baseEnvironment, snap.archive, s.hostWorkspace, this.now());
    return s;
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

// MARK: Aufräumen

export interface SandboxLeftover {
  kind: "archive" | "restoreBackup" | "image";
  /** Pfad (Archiv, Sicherung) oder Image-Referenz (`based-snapshot/<projekt>:<name>`). */
  reference: string;
  modified?: string;
  label: string;
}

const leftover = (kind: SandboxLeftover["kind"], reference: string, modified?: Date): SandboxLeftover => ({
  kind,
  reference,
  ...(modified ? { modified: modified.toISOString() } : {}),
  label: kind === "archive" ? `Snapshot archive ${basename(reference)}` : kind === "restoreBackup" ? `Folder before restore ${basename(reference)}` : `Snapshot image ${reference}`,
});

function isBackup(name: string, base: string): boolean {
  if (!name.startsWith(base + BACKUP_MARKER)) return false;
  return /^\d+$/.test(name.slice(base.length + BACKUP_MARKER.length));
}

/** Alte Archive, Snapshot-Images und `<ordner>.before-restore-<zeit>`-Ordner. Entfernt wird nur nach Bestätigung. */
export const SandboxCleanup = {
  scan(snapshotDirectory: string, workspaces: string[], keep: SandboxSnapshot[] = []): SandboxLeftover[] {
    const kept = new Set(keep.map((s) => normalize(s.archive)));
    const modified = (p: string) => {
      try {
        return statSync(p).mtime;
      } catch {
        return undefined;
      }
    };
    const out: SandboxLeftover[] = [];
    if (existsSync(snapshotDirectory)) {
      for (const name of readdirSync(snapshotDirectory).sort()) {
        if (!name.endsWith(".tar.gz")) continue;
        const p = normalize(join(snapshotDirectory, name));
        if (!kept.has(p)) out.push(leftover("archive", p, modified(p)));
      }
    }
    const seen = new Set<string>();
    for (const ws of workspaces) {
      const folder = normalize(ws);
      const parent = dirname(folder), base = basename(folder);
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent).sort()) {
        if (!isBackup(name, base)) continue;
        const p = join(parent, name);
        if (!seen.has(p)) {
          seen.add(p);
          out.push(leftover("restoreBackup", p, modified(p)));
        }
      }
    }
    return out;
  },

  async images(runner: CommandRunner, env: Record<string, string>, keep: SandboxSnapshot[] = [], docker = "docker"): Promise<SandboxLeftover[]> {
    let r: ExecResult;
    try {
      r = await runner.run(docker, ["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", `reference=${SNAPSHOT_IMAGE_PREFIX}*`], env);
    } catch {
      return [];
    }
    if (r.exitCode !== 0) return [];
    const kept = new Set(keep.map((s) => s.image));
    return r.stdout.split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s.startsWith(SNAPSHOT_IMAGE_PREFIX) && !s.endsWith(":<none>") && !kept.has(s))
      .map((s) => leftover("image", s));
  },

  /** Entfernt `items` (nur mit `confirmed`); was nicht nach Based aussieht, bleibt. Gibt das Entfernte zurück. */
  async remove(items: SandboxLeftover[], opts: { confirmed: boolean; snapshotDirectory: string; runner?: CommandRunner; env?: Record<string, string>; docker?: string }): Promise<SandboxLeftover[]> {
    if (!opts.confirmed) throw new SandboxError("Cleaning up snapshots needs a confirmation.");
    const dir = normalize(opts.snapshotDirectory);
    const removed: SandboxLeftover[] = [];
    for (const item of items) {
      if (item.kind === "archive") {
        const p = normalize(item.reference);
        if (dirname(p) !== dir || !p.endsWith(".tar.gz")) continue;
        try {
          rmSync(p);
          removed.push(item);
        } catch {
          // schon weg
        }
      } else if (item.kind === "restoreBackup") {
        const p = normalize(item.reference);
        if (!basename(p).includes(BACKUP_MARKER)) continue;
        try {
          rmSync(p, { recursive: true });
          removed.push(item);
        } catch {
          // schon weg
        }
      } else {
        if (!item.reference.startsWith(SNAPSHOT_IMAGE_PREFIX) || !opts.runner) continue;
        const r = await opts.runner.run(opts.docker ?? "docker", ["rmi", item.reference], opts.env ?? {}).catch(() => undefined);
        if (r?.exitCode === 0) removed.push(item);
      }
    }
    return removed;
  },
};

// MARK: Verwaltung pro Lauf

/** Sandboxen der laufenden Läufe: anlegen, Snapshots, wiederherstellen, beenden, Reste aufräumen. */
export class SandboxManager {
  private readonly byRun = new Map<string, SandboxHandle>();

  constructor(
    readonly provider: SandboxProvider,
    readonly policy: SandboxEnvironmentPolicy = new SandboxEnvironmentPolicy(),
  ) {}

  get(runID: string): SandboxHandle | undefined {
    return this.byRun.get(runID);
  }

  list(): SandboxHandle[] {
    return [...this.byRun.values()];
  }

  private need(runID: string): SandboxHandle {
    const s = this.byRun.get(runID);
    if (!s) throw new SandboxError(`No sandbox for run ${runID}`);
    return s;
  }

  /** Eine Sandbox für den Lauf (gibt die vorhandene zurück, wenn es schon eine gibt). */
  async start(runID: string, spec: Omit<SandboxSpec, "runID">): Promise<SandboxHandle> {
    const existing = this.byRun.get(runID);
    if (existing) return existing;
    const s = await this.provider.create({ ...spec, runID });
    this.byRun.set(runID, s);
    return s;
  }

  /** Kommando im Lauf; die Umgebung geht nur gefiltert hinein. */
  exec(runID: string, command: string[], env: Record<string, string | undefined> = {}): Promise<ExecResult> {
    return this.provider.exec(this.need(runID), command, this.policy.filter(env));
  }

  async snapshot(runID: string, name: string): Promise<SandboxSnapshot> {
    const s = await this.provider.snapshot(this.need(runID), name);
    this.byRun.set(runID, s);
    return s.snapshots.find((x) => x.name === name)!;
  }

  snapshots(runID: string): SandboxSnapshot[] {
    return [...this.need(runID).snapshots].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async restore(runID: string, name: string): Promise<SandboxHandle> {
    const s = await this.provider.restore(this.need(runID), name);
    this.byRun.set(runID, s);
    return s;
  }

  /** Lauf beendet: Container weg (Projektordner und Snapshots bleiben). */
  async stop(runID: string): Promise<void> {
    const s = this.byRun.get(runID);
    if (!s) return;
    await this.provider.destroy(s);
    this.byRun.delete(runID);
  }

  /** Beim Herunterfahren: alle Container weg. Fehler einzelner Container halten die anderen nicht auf. */
  async stopAll(): Promise<number> {
    let n = 0;
    for (const id of [...this.byRun.keys()]) {
      try {
        await this.stop(id);
        n++;
      } catch {
        // weiter mit den anderen
      }
    }
    return n;
  }

  /** Container mit Based-Label, die kein Lauf mehr kennt, entfernen (nach einem Absturz). Nur Docker. */
  async removeOrphans(): Promise<number> {
    const p = this.provider;
    if (!(p instanceof DockerSandboxProvider)) return 0;
    const orphans = await p.orphans(new Set(this.list().map((s) => s.id)));
    let n = 0;
    for (const id of orphans) {
      const r = await p.runner.run(p.docker, ["rm", "-f", id], p.baseEnvironment).catch(() => undefined);
      if (r?.exitCode === 0) n++;
    }
    return n;
  }

  private get inUse(): SandboxSnapshot[] {
    return this.list().flatMap((s) => s.snapshots);
  }

  async leftovers(extraWorkspaces: string[] = []): Promise<SandboxLeftover[]> {
    const p = this.provider;
    const workspaces = [...new Set([...this.list().map((s) => s.hostWorkspace), ...extraWorkspaces])].sort();
    const out = SandboxCleanup.scan(p.snapshotDirectory, workspaces, this.inUse);
    if (p instanceof DockerSandboxProvider) out.push(...(await SandboxCleanup.images(p.runner, p.baseEnvironment, this.inUse, p.docker)));
    return out;
  }

  /** Entfernt nur, was ein frischer Scan noch meldet (ein Aufrufer kann keine beliebigen Pfade nennen). */
  async cleanUp(references: string[], confirmed: boolean): Promise<SandboxLeftover[]> {
    if (!confirmed) throw new SandboxError("Cleaning up snapshots needs a confirmation.");
    const wanted = new Set(references);
    const items = (await this.leftovers()).filter((l) => wanted.has(l.reference));
    const p = this.provider;
    return SandboxCleanup.remove(items, { confirmed: true, snapshotDirectory: p.snapshotDirectory, runner: p.runner, env: p.baseEnvironment, ...(p instanceof DockerSandboxProvider ? { docker: p.docker } : {}) });
  }
}
