// Argumente des `based`-Befehls (Swift `CLIArguments`, BSD-54). Geheimnisse nie auf der Kommandozeile: sie landen
// in der Shell-History und in `ps`. Der Token kommt aus BASED_TOKEN, einer Datei oder `based login` (stdin).

export type CLICommand =
  | { name: "help" }
  | { name: "version" }
  | { name: "ask"; task: string; kind?: string; project?: string; wait: boolean; timeout?: number }
  | { name: "runs"; status?: string; limit?: number }
  | { name: "run"; id: string }
  | { name: "pageGet"; ref: string }
  | { name: "pageNew"; title: string; parent?: string; project?: string }
  | { name: "pageList"; parent?: string; limit?: number }
  | { name: "search"; query: string; limit?: number }
  | { name: "inbox" }
  | { name: "tools" }
  | { name: "sandboxShell"; runID: string }
  | { name: "login"; url: string }
  | { name: "config" }
  /** BSD-30: Probelauf der Umstellung „Properties als eigene Records“ auf einem Based-Archiv. Liest nur, braucht keinen Server. */
  | { name: "check"; path: string };

export interface CLIOptions {
  url?: string;
  tokenFile?: string;
  json: boolean;
  /** BSD-138: den lokalen Server der Desktop-App nehmen (Discovery-Datei), auch wenn ein anderer eingestellt ist. */
  local?: boolean;
}

export class CLIError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "CLIError";
  }
}

export const VERSION = "0.1.0";

export const USAGE = `based — Based from the terminal

Usage:
  based ask "<task>" [--kind code|research|write|organize] [--project <name|id>] [--wait [--timeout <seconds>]]
  based runs [--running | --status <Status>] [--limit N]
  based run <run-id>
  based page get <page-id | title>
  based page new --title <title> [--parent <page-id> | --project <name|id>]  < body.md
  based page list [--parent <page-id>] [--limit N]
  based search "<text>" [--limit N]
  based inbox
  based tools                                 (what this server offers)
  based sandbox shell <run-id>
  based login --url <https://server>          (reads the token from stdin)
  based config
  based check <export.based.zip>              (dry run of the properties migration; reads only, no server)

Options (any command):
  --url <url>          Server URL (default: BASED_URL, then the config file)
  --token-file <path>  File that contains the token (default: BASED_TOKEN_FILE)
  --json               Print the raw tool result as JSON
  --local              Use the local server of the Based desktop app (no server needed)

The token is never accepted as an argument. Use BASED_TOKEN, --token-file, or \`based login\`
(stored in ~/.config/based/config.json, mode 0600). Without any server configured, \`based\` uses the
desktop app's local server when the app is running (~/.config/based/local.json).`;

const VALUE_FLAGS = new Set(["--url", "--token-file", "--kind", "--project", "--status", "--limit", "--title", "--parent", "--timeout"]);
const BOOL_FLAGS = new Set(["--local", "--json", "--running", "--help", "-h", "--version", "--wait"]);
const SECRET_FLAGS = new Set(["--token", "-t", "--password", "--secret", "--api-key"]);
export const RUN_STATUSES = ["Queued", "Running", "Needs you", "Done", "Failed", "Cancelled"];

export function parseArgs(argv: string[]): { command: CLICommand; options: CLIOptions } {
  const rest: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("-") && eq > 0 ? a.slice(0, eq) : a;
    if (SECRET_FLAGS.has(name)) {
      throw new CLIError(`Refusing ${name}: secrets on the command line end up in shell history. Use BASED_TOKEN, --token-file <path> or \`based login\` (reads stdin).`, 2);
    }
    if (VALUE_FLAGS.has(name)) {
      let value: string;
      if (eq > 0 && a.startsWith("-")) value = a.slice(eq + 1);
      else {
        if (i + 1 >= argv.length) throw new CLIError(`${name} needs a value`, 2);
        value = argv[++i]!;
      }
      if (flags.has(name)) throw new CLIError(`${name} given twice`, 2);
      flags.set(name, value);
    } else if (BOOL_FLAGS.has(a)) bools.add(a);
    else if (a.startsWith("-") && a.length > 1) throw new CLIError(`Unknown option ${a}. Run \`based --help\`.`, 2);
    else rest.push(a);
  }
  const options: CLIOptions = { json: bools.has("--json") };
  if (bools.has("--local")) {
    if (flags.has("--url") || flags.has("--token-file")) throw new CLIError("--local doesn't go with --url or --token-file", 2);
    options.local = true;
  }
  if (flags.has("--url")) options.url = flags.get("--url")!;
  if (flags.has("--token-file")) options.tokenFile = flags.get("--token-file")!;
  const done = (command: CLICommand) => ({ command, options });
  if (bools.has("--help") || bools.has("-h") || rest[0] === "help") return done({ name: "help" });
  if (bools.has("--version") || rest[0] === "version") return done({ name: "version" });
  const cmd = rest[0];
  if (cmd === undefined) return done({ name: "help" });
  const args = rest.slice(1);

  const only = (allowed: string[]) => {
    const extra = [...flags.keys()].filter((k) => !allowed.includes(k) && k !== "--url" && k !== "--token-file").sort();
    if (extra[0]) throw new CLIError(`${extra[0]} does not apply to \`${cmd}\``, 2);
  };
  const positive = (flag: string, what = "a positive number") => {
    const v = flags.get(flag);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v) || Number(v) <= 0) throw new CLIError(`${flag} must be ${what}`, 2);
    return Number(v);
  };
  const one = (what: string) => {
    if (args.length !== 1 || args[0]!.trim() === "") throw new CLIError(`\`based ${cmd}\` needs exactly one ${what}`, 2);
    return args[0]!;
  };
  const opt = <K extends string>(key: K, flag: string): Partial<Record<K, string>> => (flags.has(flag) ? ({ [key]: flags.get(flag)! } as Record<K, string>) : {});

  switch (cmd) {
    case "ask": {
      only(["--kind", "--project", "--timeout"]);
      const task = args.join(" ").trim();
      if (!task) throw new CLIError('`based ask` needs a task, e.g. based ask "Summarise today\'s runs"', 2);
      const kind = flags.get("--kind");
      if (kind !== undefined && !["code", "research", "write", "organize"].includes(kind)) throw new CLIError("--kind must be code, research, write or organize", 2);
      const wait = bools.has("--wait");
      if (!wait && flags.has("--timeout")) throw new CLIError("--timeout only applies with --wait", 2);
      const timeout = positive("--timeout", "a positive number of seconds");
      return done({ name: "ask", task, wait, ...opt("kind", "--kind"), ...opt("project", "--project"), ...(timeout ? { timeout } : {}) });
    }
    case "runs": {
      only(["--status", "--limit"]);
      if (args.length > 0) throw new CLIError("`based runs` takes no arguments", 2);
      if (bools.has("--running") && flags.has("--status")) throw new CLIError("use either --running or --status", 2);
      let status = bools.has("--running") ? "Running" : flags.get("--status");
      if (status !== undefined) {
        const match = RUN_STATUSES.find((s) => s.toLowerCase() === status!.toLowerCase() || s.replace(" ", "").toLowerCase() === status!.toLowerCase());
        if (!match) throw new CLIError(`--status must be one of: ${RUN_STATUSES.join(", ")}`, 2);
        status = match;
      }
      const limit = positive("--limit");
      return done({ name: "runs", ...(status ? { status } : {}), ...(limit ? { limit } : {}) });
    }
    case "run":
      only([]);
      return done({ name: "run", id: one("run id") });
    case "page": {
      const sub = args[0];
      const pargs = args.slice(1);
      if (sub === "get") {
        only([]);
        if (pargs.length === 0) throw new CLIError("`based page get` needs a page id or title", 2);
        return done({ name: "pageGet", ref: pargs.join(" ") });
      }
      if (sub === "new") {
        only(["--title", "--project", "--parent"]);
        if (pargs.length > 0) throw new CLIError("`based page new` reads the body from stdin; pass the title with --title", 2);
        const title = flags.get("--title")?.trim();
        if (!title) throw new CLIError("`based page new` needs --title", 2);
        if (flags.has("--project") && flags.has("--parent")) throw new CLIError("use either --project or --parent", 2);
        return done({ name: "pageNew", title, ...opt("parent", "--parent"), ...opt("project", "--project") });
      }
      if (sub === "list") {
        only(["--parent", "--limit"]);
        const limit = positive("--limit");
        return done({ name: "pageList", ...opt("parent", "--parent"), ...(limit ? { limit } : {}) });
      }
      throw new CLIError(sub ? `Unknown page command ${sub} (get, new, list)` : "`based page` needs get, new or list", 2);
    }
    case "search": {
      only(["--limit"]);
      const query = args.join(" ").trim();
      if (!query) throw new CLIError("`based search` needs a text", 2);
      const limit = positive("--limit");
      return done({ name: "search", query, ...(limit ? { limit } : {}) });
    }
    case "inbox":
    case "tools":
    case "config":
      only([]);
      if (args.length > 0) throw new CLIError(`\`based ${cmd}\` takes no arguments`, 2);
      return done({ name: cmd });
    case "check":
      only([]);
      return done({ name: "check", path: one("archive file (.based.zip or .based.jsonl)") });
    case "sandbox":
      only([]);
      if (args[0] !== "shell" || args.length !== 2) throw new CLIError("usage: based sandbox shell <run-id>", 2);
      return done({ name: "sandboxShell", runID: args[1]! });
    case "login":
      only([]);
      if (args.length > 0) throw new CLIError("`based login` reads the token from stdin; pass only --url", 2);
      if (!options.url) throw new CLIError("`based login` needs --url <https://your-server>", 2);
      return done({ name: "login", url: options.url });
    default:
      throw new CLIError(`Unknown command ${cmd}. Run \`based --help\`.`, 2);
  }
}
