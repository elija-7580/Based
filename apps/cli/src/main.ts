// `based` – Ein-/Ausgabe: argv, Umgebung, Konfigurationsdatei, MCP über Streamable HTTP (POST /mcp mit Bearer-Token),
// stdin. Entscheidungen stehen in args.ts, config.ts und cli.ts (getestet).
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLIError, parseArgs, VERSION } from "./args.js";
import { BasedCLI, type MCPSession } from "./cli.js";
import { checkURL, configFileContents, configPath, resolveConfig } from "./config.js";

const readFile = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};
const fileMode = (p: string) => {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return undefined;
  }
};

/** Läuft ein Prozess noch? (Signal 0 prüft nur; EPERM heißt: läuft, gehört aber jemand anderem.) */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Token am Terminal ohne Echo lesen (wie `getpass`). */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stderr.write(label);
    input.setRawMode(true);
    input.resume();
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
      }
    };
    input.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Verbindet einen MCP-Client mit `<url>/mcp`. Der Token geht nur im Authorization-Header. */
export async function connect(url: string, token: string): Promise<MCPSession & { close(): Promise<void> }> {
  const client = new Client({ name: "based-cli", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: unknown }).code;
    if (code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(msg)) throw new CLIError("Not authorised — check the token (`based config`).");
    throw new CLIError(`Can't reach ${url}: ${msg.slice(0, 200)}`);
  }
  return {
    listTools: async () => (await client.listTools()).tools,
    callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as Awaited<ReturnType<MCPSession["callTool"]>>,
    close: () => client.close(),
  };
}

export async function main(argv: string[], io: { env?: Record<string, string | undefined>; home?: string; out?: (s: string) => void; err?: (s: string) => void; stdin?: () => Promise<string> } = {}): Promise<number> {
  const env = io.env ?? process.env;
  const home = io.home ?? env.HOME ?? homedir();
  const out = io.out ?? ((s: string) => void process.stdout.write(s + "\n"));
  const err = io.err ?? ((s: string) => void process.stderr.write(s + "\n"));
  const stdin = io.stdin ?? readStdin;
  try {
    const { command, options } = parseArgs(argv);
    if (command.name === "help" || command.name === "version") {
      await new BasedCLI({ listTools: async () => [], callTool: async () => ({}) }, { out }).execute(command);
      return 0;
    }
    if (command.name === "login") {
      // Der Token kommt über stdin (Pipe oder getippt), nie über argv.
      const url = checkURL(command.url);
      const token = (io.stdin === undefined && process.stdin.isTTY ? await promptHidden("Token: ") : await stdin()).trim();
      if (!token) throw new CLIError("no token on stdin (e.g. `pbpaste | based login --url …`)");
      const path = configPath(home);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, "", { mode: 0o600 });
      chmodSync(path, 0o600);
      writeFileSync(path, configFileContents(url, token), { mode: 0o600 });
      out(`Saved ${url} to ${path} (mode 600).`);
      return 0;
    }
    const config = resolveConfig(options, { env, home, readFile, fileMode, alive });
    if (command.name === "config") {
      out(`Server: ${config.url}\nToken:  from ${config.tokenSource}`);
      return 0;
    }
    const session = await connect(config.url, config.token);
    try {
      await new BasedCLI(session, { json: options.json, out, stdin }).execute(command);
    } finally {
      await session.close();
    }
    return 0;
  } catch (e) {
    if (e instanceof CLIError) {
      err(`based: ${e.message}`);
      return e.exitCode;
    }
    err(`based: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
