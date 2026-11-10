// BSD-223: Node-Hülle für ACP-Agenten (Desktop-Sidecar bzw. Server): startet die Agenten-CLI als Kindprozess mit
// gefilterter Umgebung (BSD-33), verbindet stdio mit dem JSON-RPC-Peer und stellt ein Dateisystem mit
// Symlink-Auflösung bereit. Nur über `@based/brain/acp-node` (nicht im Browser-Bundle).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import { delimiter, join } from "node:path";
import { childEnvironment, secretInArguments, type AgentDefinition } from "./agents.js";
import { claudeLoginFrom, toolCatalog, type DoctorTool } from "./doctor.js";
import { claudeCliSession, cliTranscript, codexCliSession, type CliSession } from "./history.js";
import type { StoredChatEvent } from "../events.js";
import { AcpClient, type AcpClientOptions, type AcpFileSystem } from "./client.js";
import { JsonRpcPeer } from "./jsonrpc.js";

export const nodeFileSystem: AcpFileSystem = {
  read: (p) => fsp.readFile(p, "utf8"),
  write: (p, c) => fsp.writeFile(p, c, "utf8"),
  async realpath(p) {
    try { return await fsp.realpath(p); } catch {
      // Neue Datei: Ordner auflösen, Name dran (ein Symlink-Ordner kann sonst nach außen zeigen).
      const i = p.lastIndexOf("/");
      return (await fsp.realpath(p.slice(0, i) || "/")) + p.slice(i);
    }
  },
};

export interface SpawnAgentOptions extends AcpClientOptions {
  cwd: string;
  /** Basis-Umgebung (Standard: `process.env`); wird gefiltert. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Für diesen Agenten freigegebene Namen (z. B. `ANTHROPIC_API_KEY`). */
  approvedEnv?: readonly string[];
  /** stderr-Zeilen (Diagnose). */
  onLog?: (line: string) => void;
}

export interface SpawnedAgent {
  client: AcpClient;
  process: ChildProcess;
  stop(): void;
}

/** Agentenprozess starten und den ACP-Handshake machen. */
export async function spawnAgent(agent: AgentDefinition, o: SpawnAgentOptions): Promise<SpawnedAgent> {
  const bad = secretInArguments(agent.args);
  if (bad) throw new Error(`Refusing to start ${agent.name}: a secret-looking argument (${bad}) belongs in an approved environment variable, not on the command line.`);
  const env = childEnvironment(o.baseEnv ?? process.env, { agentId: agent.id, approved: o.approvedEnv ?? [], extra: agent.env });
  const child = spawn(agent.command, agent.args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  const peer = new JsonRpcPeer((line) => {
    if (!child.stdin || child.stdin.destroyed || child.exitCode !== null) throw new Error("Process exited");
    child.stdin.write(line);
  });
  child.stdout!.setEncoding("utf8").on("data", (d: string) => peer.receive(d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => o.onLog?.(d));
  child.stdin!.on("error", () => peer.close());
  child.on("exit", () => peer.close());
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (e) => { peer.close(); reject(new Error(`${agent.name}: ${agent.command} could not be started (${e.message})`)); });
  });
  await spawned;
  const client = new AcpClient(peer, { fs: nodeFileSystem, ...o });
  const stop = () => { if (child.exitCode === null) child.kill(); peer.close(); };
  try {
    await client.initialize();
  } catch (e) {
    stop();
    throw e;
  }
  return { client, process: child, stop };
}

// MARK: Setup-Doctor (Node)

/** Befehl im PATH suchen (unter Windows mit PATHEXT). */
export async function which(command: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | undefined> {
  if (command.includes("/") || command.includes("\\")) return (await isExecutable(command)) ? command : undefined;
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, command + ext);
      if (await isExecutable(p)) return p;
    }
  }
  return undefined;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    await fsp.access(p, process.platform === "win32" ? 0 : 1);
    return true;
  } catch {
    return false;
  }
}

/** Erste Zeile von `<pfad> --version` (höchstens 8 s, gefilterte Umgebung). */
export function toolVersion(path: string, env: Readonly<Record<string, string | undefined>> = process.env, timeoutMs = 8000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: timeoutMs, env: childEnvironment(env), shell: process.platform === "win32" }, (err, stdout, stderr) => {
      const line = `${stdout || stderr || ""}`.split("\n")[0]?.trim() ?? "";
      resolve(err && !line ? undefined : line ? line.slice(0, 60) : undefined);
    });
  });
}

/** Alle Werkzeuge des Katalogs prüfen. */
export async function probeTools(env: Readonly<Record<string, string | undefined>> = process.env): Promise<DoctorTool[]> {
  return Promise.all(toolCatalog(process.platform).map(async (t) => {
    const path = await which(t.id, env);
    return { ...t, path, version: path ? await toolVersion(path, env) : undefined };
  }));
}

/** Claude-Login: Anmeldedatei oder freigegebener Schlüssel (macOS: Konto in `~/.claude.json`, Token im Schlüsselbund). */
export async function claudeLoggedIn(home: string, approvedEnv: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const exists = await fsp.access(join(home, ".claude", ".credentials.json")).then(() => true, () => false);
  const claudeJson = await fsp.readFile(join(home, ".claude.json"), "utf8").catch(() => undefined);
  return claudeLoginFrom({ credentials: exists, claudeJson }, approvedEnv);
}

/** Agent starten und den ACP-Handshake abwarten (beweist die ganze Kette). */
export async function testAgent(agent: AgentDefinition, o: SpawnAgentOptions & { timeoutMs?: number }): Promise<{ ok: boolean; message: string }> {
  let spawned: SpawnedAgent | undefined;
  const timeout = o.timeoutMs ?? 45_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    spawned = await Promise.race([
      spawnAgent(agent, o),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(timeout / 1000)} s (the first npx start can take a while – try again).`)), timeout); }),
    ]);
    const info = spawned.client.agentInfo;
    const name = info && typeof info === "object" && !Array.isArray(info) ? (typeof info.title === "string" ? info.title : typeof info.name === "string" ? info.name : agent.name) : agent.name;
    return { ok: true, message: `${name} answered the ACP handshake.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
    spawned?.stop();
  }
}

// MARK: CLI-Verlauf (Node)

async function jsonlFiles(root: string, filter: (name: string) => boolean, depth = 5): Promise<{ path: string; mtime: number; size: number }[]> {
  const out: { path: string; mtime: number; size: number }[] = [];
  const walk = async (dir: string, d: number): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && d > 0) await walk(p, d - 1);
      else if (e.isFile() && e.name.endsWith(".jsonl") && filter(e.name)) {
        const st = await fsp.stat(p).catch(() => undefined);
        if (st) out.push({ path: p, mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  await walk(root, depth);
  return out;
}

async function readSlice(path: string, from: "head" | "tail", bytes: number): Promise<string[]> {
  const h = await fsp.open(path, "r").catch(() => undefined);
  if (!h) return [];
  try {
    const size = (await h.stat()).size;
    const start = from === "head" ? 0 : Math.max(0, size - bytes);
    const len = Math.min(bytes, size - start);
    const buf = Buffer.alloc(len);
    await h.read(buf, 0, len, start);
    const lines = buf.toString("utf8").split("\n");
    if (from === "head" && len === bytes) lines.pop(); // letzte Zeile ist vermutlich abgeschnitten
    if (from === "tail" && start > 0) lines.shift();
    return lines;
  } finally {
    await h.close();
  }
}

/** Alle Claude-Code- und Codex-Gespräche unter `home`, neueste zuerst (liest nur Anfang und Ende jeder Datei). */
export async function scanCliSessions(home: string, limit = 400): Promise<CliSession[]> {
  const out: CliSession[] = [];
  for (const f of await jsonlFiles(join(home, ".claude", "projects"), () => true, 2)) {
    const s = claudeCliSession(f, await readSlice(f.path, "head", 96 * 1024), await readSlice(f.path, "tail", 16 * 1024));
    if (s) out.push(s);
  }
  for (const f of await jsonlFiles(join(home, ".codex", "sessions"), (n) => n.startsWith("rollout-"), 4)) {
    out.push(codexCliSession(f, await readSlice(f.path, "head", 96 * 1024)));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** Transkript eines Gesprächs als ChatEvents (Datei bis 64 MiB). */
export async function readCliTranscript(s: Pick<CliSession, "tool" | "file">, limit?: number): Promise<StoredChatEvent[]> {
  const st = await fsp.stat(s.file);
  if (st.size > 64 << 20) throw new Error("transcript file is too large");
  return cliTranscript(s.tool, await fsp.readFile(s.file, "utf8"), limit);
}
