// BSD-250: stdio-MCP-Server (z. B. Katalog „Files on this computer“) als Kindprozess – auf dem Server bzw. in der
// Desktop-Hülle mit Node. Umgebung gefiltert wie bei ACP-Agenten (BSD-33, `childEnvironment`); das Token kommt nur
// als Umgebungsvariable `secretEnv`, nie als Argument. Nur über `@based/brain/mcp-node` (nicht im Browser-Bundle).
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { childEnvironment, secretInArguments } from "../acp/agents.js";
import type { ConnectionData } from "./connections.js";

export interface StdioTransportOptions {
  /** Token der Connection (aus dem verschlüsselten Speicher). */
  token?: string | undefined;
  /** Basis-Umgebung (Standard `process.env`), wird gefiltert. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Zusätzlich erlaubte Variablen (vom Nutzer freigegeben). */
  approvedEnv?: readonly string[];
  cwd?: string;
}

export class StdioConfigError extends Error {}

/** Transport für eine stdio-Connection; wirft bei fehlendem Befehl oder Geheimnis in den Argumenten. */
export function stdioTransport(c: Pick<ConnectionData, "command" | "args" | "secretEnv">, opts: StdioTransportOptions = {}): Transport {
  const command = c.command?.trim();
  if (!command) throw new StdioConfigError("This connection has no command.");
  const args = c.args ?? [];
  const leaked = secretInArguments(args);
  if (leaked) throw new StdioConfigError(`Don't put secrets in the arguments (${leaked}); use the token field.`);
  const extra: Record<string, string> = {};
  if (opts.token && c.secretEnv) extra[c.secretEnv] = opts.token;
  const env = childEnvironment(opts.baseEnv ?? process.env, { approved: opts.approvedEnv ?? [], extra });
  return new StdioClientTransport({ command, args, env, ...(opts.cwd ? { cwd: opts.cwd } : {}), stderr: "ignore" });
}
