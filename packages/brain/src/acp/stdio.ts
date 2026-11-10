// BSD-223: Node-Hülle für ACP-Agenten (Desktop-Sidecar bzw. Server): startet die Agenten-CLI als Kindprozess mit
// gefilterter Umgebung (BSD-33), verbindet stdio mit dem JSON-RPC-Peer und stellt ein Dateisystem mit
// Symlink-Auflösung bereit. Nur über `@based/brain/acp-node` (nicht im Browser-Bundle).
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import { childEnvironment, secretInArguments, type AgentDefinition } from "./agents.js";
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
