// BSD-223: Coding-Agenten, die das Agent Client Protocol (ACP) über stdio sprechen (Port von Swift
// `AgentDefinition`, `MCPServerConfig`, `AgentSecrets.childEnvironment`). Based nutzt die vorhandenen Logins
// (Claude-, ChatGPT-, Google-Abo) über die jeweilige CLI – kein eigener API-Schlüssel.
// BSD-33: Kindprozesse bekommen nur Umgebungsvariablen von einer Allowlist; Namen, die nach Geheimnis aussehen,
// nur, wenn sie für genau diesen Agenten freigegeben sind. Token stehen nie auf der Kommandozeile.
import type { JSONValue } from "@based/core";

export interface AgentDefinition {
  /** `claude`, `codex`, `gemini`, `opencode`, `pi`, `cursor` oder eigene ID. */
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Bewusst gesetzte Werte (keine Geheimnisse; die kommen über `passthrough`). */
  env: Record<string, string>;
  icon: string;
  enabled: boolean;
  note: string;
}

const def = (id: string, name: string, command: string, args: string[], icon: string, note: string, enabled = true): AgentDefinition =>
  ({ id, name, command, args, env: {}, icon, enabled, note });

/** Startbefehle wie die ACP-Adapter von Zed/Happier; in den Einstellungen änderbar. */
export const DEFAULT_AGENTS: readonly AgentDefinition[] = [
  def("claude", "Claude Code", "npx", ["-y", "@zed-industries/claude-code-acp"], "✴️", "Uses your Claude subscription via the Claude Code CLI login."),
  def("codex", "Codex", "npx", ["-y", "@zed-industries/codex-acp"], "🅾️", "Uses your ChatGPT / OpenAI login through the Codex CLI."),
  def("gemini", "Gemini CLI", "gemini", ["--experimental-acp"], "♊️", "Google account login via gemini CLI."),
  def("opencode", "OpenCode", "opencode", ["acp"], "🟩", "opencode.ai; any model you set up with `opencode auth login`."),
  def("pi", "Pi", "pi", ["--acp"], "π", "Verify the ACP flag for your Pi build.", false),
  def("cursor", "Cursor Agent", "cursor-agent", ["acp"], "🖱️", "Cursor's CLI agent; verify the ACP subcommand.", false),
];

/** MCP-Server, den jeder Agent bei `session/new` bekommt („einmal konfiguriert, überall da“). */
export type AcpMcpServer =
  | { name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; url: string; headers?: Record<string, string> };

/** ACP-Form (`env`/`headers` als Liste von Name/Wert, sortiert für stabile Ausgabe). */
export function mcpServerJSON(s: AcpMcpServer): JSONValue {
  const pairs = (r: Record<string, string> | undefined) =>
    Object.keys(r ?? {}).sort().map((name) => ({ name, value: r![name]! }));
  if ("url" in s) return { type: "http", name: s.name, url: s.url, headers: pairs(s.headers) };
  return { name: s.name, command: s.command, args: s.args ?? [], env: pairs(s.env) };
}

// MARK: Umgebung (BSD-33)

const CHILD_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "COLORTERM", "NO_COLOR", "CI",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "NVM_DIR", "VOLTA_HOME", "BUN_INSTALL",
  "PNPM_HOME", "DEVELOPER_DIR", "ANDROID_HOME",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
  // Windows: ohne diese starten Node/npx dort nicht.
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP",
]);
const CHILD_ALLOW_PREFIXES = ["LC_", "XDG_"];
const SECRET_PARTS = ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "APIKEY", "PRIVATE", "CREDENTIAL", "AUTH", "COOKIE", "SESSION"];

/** Ordner-Variablen, die ein Agent für seinen Login braucht (Swift `agentDefaultPassthrough`). */
export const AGENT_DEFAULT_PASSTHROUGH: Readonly<Record<string, readonly string[]>> = {
  claude: ["CLAUDE_CONFIG_DIR"],
  codex: ["CODEX_HOME"],
};

export const validEnvName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

export function looksSecret(name: string): boolean {
  const n = name.toUpperCase();
  return SECRET_PARTS.some((p) => n.includes(p)) || n.endsWith("_KEY") || n === "KEY";
}

/** Darf eine Variable der Basis-Umgebung an einen Agenten-Kindprozess? */
export function childMayInherit(name: string, passthrough: ReadonlySet<string> = new Set()): boolean {
  if (!validEnvName(name)) return false;
  if (passthrough.has(name)) return true;
  if (name.toUpperCase().startsWith("BASED_") || looksSecret(name)) return false;
  return CHILD_ALLOW.has(name) || CHILD_ALLOW_PREFIXES.some((p) => name.startsWith(p));
}

/** Freigegebene Namen aus Text („ANTHROPIC_API_KEY, GEMINI_API_KEY“); ungültige fallen weg. */
export function parsePassthrough(text: string | undefined): string[] {
  return (text ?? "").split(/[\s,]+/).filter((n) => n !== "" && validEnvName(n));
}

/**
 * Umgebung für einen Agenten: Basis gefiltert (Allowlist + Standard- und freigegebene Namen dieses Agenten),
 * dann `extra` (bewusst gesetzt) darüber.
 */
export function childEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  opts: { agentId?: string | undefined; approved?: readonly string[]; extra?: Readonly<Record<string, string>> } = {},
): Record<string, string> {
  const pass = new Set<string>([...(opts.agentId ? AGENT_DEFAULT_PASSTHROUGH[opts.agentId] ?? [] : []), ...(opts.approved ?? [])]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && childMayInherit(k, pass)) out[k] = v;
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (validEnvName(k)) out[k] = v;
  return out;
}

/** Argumente, die wie ein Geheimnis aussehen (`--token=…`, `sk-…`), werden abgelehnt: Token nie auf die Kommandozeile. */
export function secretInArguments(args: readonly string[]): string | undefined {
  for (const a of args) {
    const flag = /^--?([A-Za-z0-9_-]+)=/.exec(a)?.[1];
    if (flag && looksSecret(flag.replace(/-/g, "_"))) return a.slice(0, a.indexOf("=") + 1) + "…";
    if (/^(sk-|ghp_|gho_|github_pat_|xox[bp]-|AIza)[A-Za-z0-9_-]{8,}/.test(a)) return a.slice(0, 4) + "…";
  }
  return undefined;
}

// MARK: Pfade

/** POSIX-Pfad normalisieren (`.`/`..` auflösen, doppelte `/` weg); relativ bleibt relativ. */
export function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (out.length > 0 && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); continue; }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** Liegt `path` in `root` (abschnittsweise: `/p/proj` erlaubt nicht `/p/proj-secret`)? Beide absolut. */
export function pathWithin(root: string, path: string): boolean {
  if (!root.startsWith("/") || !path.startsWith("/")) return false;
  const r = normalizePath(root), p = normalizePath(path);
  return r === "/" || p === r || p.startsWith(r + "/");
}
