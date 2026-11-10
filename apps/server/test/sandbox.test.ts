// Sandbox pro Lauf (BSD-161): Docker-Kommandozeilen mit gemocktem Prozess (kein Docker in CI), Env-Allowlist,
// lokale Snapshots mit echtem tar, Aufräumen nur mit Bestätigung, Owner-Routen.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerSandboxProvider,
  LocalSandboxProvider,
  SandboxCleanup,
  SandboxEnvironmentPolicy,
  SandboxManager,
  type CommandRunner,
  type ExecResult,
} from "../src/sandbox.js";
import { auth, get, post, startApp } from "./helpers.js";

/** Gemockter Prozess: merkt sich jeden Aufruf samt Umgebung, antwortet nach Regeln. */
class FakeRunner implements CommandRunner {
  calls: { exe: string; args: string[]; env: Record<string, string> }[] = [];
  constructor(private readonly reply: (exe: string, args: string[]) => Partial<ExecResult> = () => ({})) {}
  run(exe: string, args: string[], env: Record<string, string>): Promise<ExecResult> {
    this.calls.push({ exe, args, env });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...this.reply(exe, args) });
  }
}

const SECRET = "sk-very-secret-value-123";
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "based-sandbox-"));
  dirs.push(d);
  return d;
};

describe("Env-Allowlist", () => {
  it("nur erlaubte Namen; Geheimnis-Namen nur ausdrücklich", () => {
    const env = { LANG: "de_DE.UTF-8", PATH: "/bin", ANTHROPIC_API_KEY: SECRET, GITHUB_TOKEN: SECRET, TERM: "xterm", "BAD-NAME": "x", MY_SESSION: "s" };
    expect(new SandboxEnvironmentPolicy().filter(env)).toEqual({ LANG: "de_DE.UTF-8", TERM: "xterm" });
    const p = new SandboxEnvironmentPolicy({ allow: ["LANG", "MY_SESSION"], secrets: ["ANTHROPIC_API_KEY"] });
    expect(p.filter(env)).toEqual({ LANG: "de_DE.UTF-8", ANTHROPIC_API_KEY: SECRET });
    expect(SandboxEnvironmentPolicy.looksSecret("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(SandboxEnvironmentPolicy.looksSecret("LC_ALL")).toBe(false);
  });
});

describe("Docker-Provider (gemockter Prozess – Docker selbst ungeprüft)", () => {
  const make = (runner: FakeRunner, dir: string) =>
    new DockerSandboxProvider({ runner, snapshotDirectory: join(dir, "snaps"), baseEnvironment: { PATH: "/usr/bin" }, now: () => 1_700_000_000_000 });

  it("docker run: Labels, Grenzen, Mount, kein Netz auf Wunsch; Geheimnisse nie in argv", async () => {
    const runner = new FakeRunner((_e, a) => (a[0] === "run" ? { stdout: "abc123def4567890\n" } : {}));
    const dir = tmp();
    const m = new SandboxManager(make(runner, dir), new SandboxEnvironmentPolicy({ secrets: ["ANTHROPIC_API_KEY"] }));
    const s = await m.start("Run 42", { project: "My App", hostWorkspace: "/srv/ws/my-app", network: false, readOnlyMounts: [{ host: "/home/a/.claude", container: "/home/agent/.claude" }] });
    expect(s.id).toBe("abc123def4567890");
    expect(s.workdir).toBe("/workspace/my-app");
    const run = runner.calls[0]!.args;
    expect(run.slice(0, 4)).toEqual(["run", "-d", "--name", "based-my-app-run-42"]);
    expect(run).toEqual(expect.arrayContaining(["--label", "based.sandbox=1", "based.run=Run 42", "--network", "none", "--security-opt", "no-new-privileges", "/srv/ws/my-app:/workspace/my-app", "/home/a/.claude:/home/agent/.claude:ro"]));
    expect(run.slice(-3)).toEqual(["based-sandbox:latest", "sleep", "infinity"]);
    // zweiter Start desselben Laufs: dieselbe Sandbox
    expect(await m.start("Run 42", { project: "My App", hostWorkspace: "/srv/ws/my-app" })).toBe(s);
    expect(runner.calls).toHaveLength(1);

    await m.exec("Run 42", ["claude", "--print", "hi"], { ANTHROPIC_API_KEY: SECRET, GITHUB_TOKEN: SECRET, LANG: "C" });
    const exec = runner.calls[1]!;
    expect(exec.args).toEqual(["exec", "-w", "/workspace/my-app", "-e", "ANTHROPIC_API_KEY", "-e", "LANG", "abc123def4567890", "claude", "--print", "hi"]);
    expect(exec.args.join(" ")).not.toContain(SECRET);
    expect(exec.env.ANTHROPIC_API_KEY).toBe(SECRET); // Wert nur in der Umgebung der docker-CLI
    expect(exec.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("Snapshot = commit + Archiv; Restore ersetzt den Container; Stop entfernt ihn", async () => {
    let containers = 0;
    const runner: FakeRunner = new FakeRunner((_e, a) => (a[0] === "run" ? { stdout: `cid-${containers++}\n` } : {}));
    const dir = tmp();
    const m = new SandboxManager(make(runner, dir));
    await m.start("r1", { project: "web", hostWorkspace: "/ws/web" });
    const snap = await m.snapshot("r1", "before-refactor");
    expect(snap.image).toBe("based-snapshot/web:before-refactor");
    expect(runner.calls.map((c) => c.args[0])).toEqual(["run", "commit", "-p", "-C"]);
    expect(runner.calls[1]!.args).toEqual(["commit", "--pause=true", "--message", "Based snapshot before-refactor", "cid-0", "based-snapshot/web:before-refactor"]);
    expect(runner.calls[3]!.args).toEqual(["-C", "/ws/web", "-czf", join(dir, "snaps", "web-before-refactor.tar.gz"), "."]);
    expect(m.snapshots("r1").map((x) => x.name)).toEqual(["before-refactor"]);
    await expect(m.snapshot("r1", "../evil")).rejects.toThrow("Invalid snapshot name");

    runner.calls = [];
    const restored = await m.restore("r1", "before-refactor");
    expect(runner.calls.map((c) => [c.exe, c.args[0]])).toEqual([["docker", "rm"], ["mv", "/ws/web"], ["mkdir", "-p"], ["tar", "-C"], ["docker", "run"]]);
    expect(runner.calls[1]!.args).toEqual(["/ws/web", "/ws/web.before-restore-1700000000"]);
    expect(restored.image).toBe("based-snapshot/web:before-refactor");
    expect(restored.id).toBe("cid-1");
    await expect(m.restore("r1", "nope")).rejects.toThrow("Unknown snapshot");

    runner.calls = [];
    await m.stop("r1");
    expect(runner.calls[0]!.args).toEqual(["rm", "-f", "cid-1"]);
    expect(m.get("r1")).toBeUndefined();
  });

  it("Fehler von docker werden gemeldet; verwaiste Container werden gefunden", async () => {
    const failing = new FakeRunner(() => ({ exitCode: 125, stderr: "Unable to find image" }));
    await expect(new SandboxManager(make(failing, tmp())).start("r", { project: "p", hostWorkspace: "/ws" })).rejects.toThrow("docker run failed (125)");
    const runner = new FakeRunner((_e, a) => (a[0] === "ps" ? { stdout: "aaa111\nbbb222\n" } : a[0] === "run" ? { stdout: "aaa111fffff\n" } : {}));
    const m = new SandboxManager(make(runner, tmp()));
    await m.start("live", { project: "p", hostWorkspace: "/ws" });
    expect(await m.removeOrphans()).toBe(1);
    expect(runner.calls.at(-1)!.args).toEqual(["rm", "-f", "bbb222"]);
  });
});

describe("Lokaler Provider (echtes tar)", () => {
  it("Snapshot anlegen, Datei ändern, wiederherstellen; alter Stand bleibt daneben; aufräumen nur mit Bestätigung", async () => {
    const dir = tmp();
    const ws = join(dir, "project");
    mkdirSync(ws);
    writeFileSync(join(ws, "a.txt"), "v1");
    const m = new SandboxManager(new LocalSandboxProvider({ snapshotDirectory: join(dir, "snaps"), baseEnvironment: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, now: () => 1_700_000_000_000 }));
    await m.start("run-1", { project: "Project", hostWorkspace: ws });
    const r = await m.exec("run-1", ["sh", "-c", "pwd; echo ${GITHUB_TOKEN:-none}"], { GITHUB_TOKEN: SECRET });
    expect(r.stdout).toBe(`${ws}\nnone\n`);
    await m.snapshot("run-1", "s1");
    writeFileSync(join(ws, "a.txt"), "v2");
    writeFileSync(join(ws, "b.txt"), "new");
    await m.restore("run-1", "s1");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v1");
    expect(existsSync(join(ws, "b.txt"))).toBe(false);
    const backup = `${ws}.before-restore-1700000000`;
    expect(readFileSync(join(backup, "a.txt"), "utf8")).toBe("v2");

    // In Gebrauch: Archiv wird nicht angeboten; die Sicherung schon.
    let left = await m.leftovers();
    expect(left.map((l) => l.kind)).toEqual(["restoreBackup"]);
    await m.stop("run-1");
    left = await m.leftovers([ws]);
    expect(left.map((l) => l.kind).sort()).toEqual(["archive", "restoreBackup"]);
    await expect(m.cleanUp(left.map((l) => l.reference), false)).rejects.toThrow("confirmation");
    // Beliebige Pfade werden ignoriert
    const removed = await m.cleanUp([...left.map((l) => l.reference), "/etc/passwd"], true);
    expect(removed).toHaveLength(1); // ohne Lauf kennt der Scan den Ordner nicht mehr: nur das Archiv
    expect(SandboxCleanup.scan(join(dir, "snaps"), [ws])).toHaveLength(1); // die Sicherung bleibt, bis man sie nennt
  });
});

describe("Owner-Routen /sandbox", () => {
  it("Läufe, Snapshots, Restore, Aufräumen; ohne Owner-Token nicht", async () => {
    const dir = tmp();
    const ws = join(dir, "p");
    mkdirSync(ws);
    writeFileSync(join(ws, "x"), "1");
    const sandbox = new SandboxManager(new LocalSandboxProvider({ snapshotDirectory: join(dir, "snaps"), baseEnvironment: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }));
    await sandbox.start("run-a", { project: "P", hostWorkspace: ws });
    const app = await startApp({ sandbox });
    try {
      expect((await get(`${app.url}/sandbox/runs`, {})).status).toBe(401);
      const runs = await get(`${app.url}/sandbox/runs`);
      expect(runs.body).toMatchObject({ provider: "local", runs: [{ runID: "run-a", reference: `local:${ws}` }] });
      expect((await post(`${app.url}/sandbox/runs/run-a/snapshots`, { name: "one" })).body).toMatchObject({ name: "one" });
      expect((await post(`${app.url}/sandbox/runs/run-a/snapshots`, { name: "-bad" })).status).toBe(400);
      expect((await post(`${app.url}/sandbox/runs/run-a/restore`, { name: "one" })).status).toBe(200);
      const left = await get(`${app.url}/sandbox/leftovers`);
      expect((left.body!.leftovers as { kind: string }[]).map((l) => l.kind)).toEqual(["restoreBackup"]);
      expect((await post(`${app.url}/sandbox/cleanup`, { references: [] }, auth)).status).toBe(400);
      expect((await post(`${app.url}/sandbox/runs/run-a/stop`, {})).status).toBe(200);
      expect(sandbox.list()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
