// BSD-223 Teil 3: Setup-Doctor (Port von Swift `AgentDoctor`): Welche CLIs sind da, ist man angemeldet, und was
// genau fehlt – mit einem Befehl zum Beheben. Rein: die Hülle liefert die Funde (`probeTools` in `acp/stdio.ts`).
import { looksSecret, type AgentDefinition } from "./agents.js";
import type { CodexLogin } from "./chatgpt.js";

export interface DoctorToolSpec { id: string; name: string; required: boolean; purpose: string; install: string; docs: string }

export interface DoctorTool extends DoctorToolSpec {
  path: string | undefined;
  version: string | undefined;
}

export type AgentReadiness = "ready" | "missing" | "needsLogin" | "unknown";

export interface AgentStatus {
  id: string;
  name: string;
  state: AgentReadiness;
  summary: string;
  /** Befehl fürs Terminal, der das Problem behebt. */
  fix: string | undefined;
  driver: string;
}

export function toolCatalog(platform: string = "linux"): DoctorToolSpec[] {
  const node = platform === "darwin" ? "brew install node" : platform === "win32" ? "winget install OpenJS.NodeJS.LTS" : "Install Node.js 20+ from https://nodejs.org (or your package manager)";
  const git = platform === "darwin" ? "xcode-select --install" : platform === "win32" ? "winget install Git.Git" : "Install git with your package manager";
  return [
    { id: "node", name: "Node.js", required: true, purpose: "Runs npx-based agents and MCP servers", install: node, docs: "https://nodejs.org" },
    { id: "npx", name: "npx", required: true, purpose: "Starts ACP adapters and MCP servers", install: node, docs: "https://docs.npmjs.com/cli/commands/npx" },
    { id: "claude", name: "Claude Code", required: false, purpose: "Anthropic's coding agent (uses your Claude subscription)", install: "npm install -g @anthropic-ai/claude-code", docs: "https://docs.anthropic.com/en/docs/claude-code" },
    { id: "codex", name: "Codex CLI", required: false, purpose: "OpenAI's coding agent (ChatGPT login)", install: "npm install -g @openai/codex", docs: "https://github.com/openai/codex" },
    { id: "gemini", name: "Gemini CLI", required: false, purpose: "Google's coding agent", install: "npm install -g @google/gemini-cli", docs: "https://github.com/google-gemini/gemini-cli" },
    { id: "opencode", name: "OpenCode", required: false, purpose: "Open-source coding agent", install: "npm install -g opencode-ai", docs: "https://opencode.ai" },
    { id: "git", name: "Git", required: false, purpose: "Agents commit and diff with git", install: git, docs: "https://git-scm.com" },
  ];
}

export interface StatusContext {
  /** Claude-Login gefunden (Anmeldedatei bzw. freigegebener Schlüssel). */
  claudeLoggedIn: boolean;
  /** Schlüssel, die in der Umgebung stehen, aber für den Agenten nicht freigegeben sind (BSD-110). */
  unapprovedKeys: (agentId: string) => string[];
  /** Ist ein Befehl im PATH? (für eigene Agenten) */
  found: (command: string) => boolean;
  /** Wie man Variablen freigibt (Server: `BASED_CODING_ENV=…`). */
  approveHint: (agentId: string, names: string[]) => string;
  /** BSD-257: Ergebnis von `codex login status` (fehlt = nicht geprüft). */
  codexLogin?: CodexLogin | undefined;
}

/** Zustand eines konfigurierten Agenten anhand der gefundenen Werkzeuge. */
export function agentStatus(def: AgentDefinition, tools: readonly DoctorTool[], ctx: StatusContext): AgentStatus {
  const tool = (id: string) => tools.find((t) => t.id === id);
  const cmd = def.command.split(/[\\/]/).pop() ?? def.command;
  const base = { id: def.id, name: def.name };
  if (def.id === "claude" && tool("claude")?.path) {
    const c = tool("claude")!;
    if (!ctx.claudeLoggedIn) {
      const key = ctx.unapprovedKeys("claude")[0];
      if (key) return { ...base, state: "needsLogin", summary: `Claude Code found. ${key} is set but not passed to Claude Code – allow it for this agent, or run \`claude\` once and log in.`, fix: ctx.approveHint("claude", [key]), driver: "ACP adapter" };
      return { ...base, state: "needsLogin", summary: "Claude Code found, but no login was detected. Run `claude` once in a terminal and log in.", fix: "claude", driver: "ACP adapter" };
    }
    if (!tool("npx")?.path) return { ...base, state: "missing", summary: "Node.js (npx) is required to start the Claude Code ACP adapter.", fix: tool("npx")?.install, driver: "ACP adapter" };
    return { ...base, state: "ready", summary: `Claude Code${c.version ? ` ${c.version}` : ""} found and logged in.`, fix: undefined, driver: "ACP adapter" };
  }
  if (cmd === "npx" || cmd === "npx.cmd") {
    if (!tool("node")?.path || !tool("npx")?.path) {
      return { ...base, state: "missing", summary: `Node.js is required for ${def.name} (started via npx).`, fix: tool("node")?.install, driver: "ACP adapter" };
    }
    const cli = tool(def.id);
    if (cli && !cli.path) return { ...base, state: "missing", summary: `The ${cli.name} CLI is not installed – the ACP adapter needs it and its login.`, fix: cli.install, driver: "ACP adapter" };
    if (def.id === "codex" && ctx.codexLogin === "none") {
      const key = ctx.unapprovedKeys("codex")[0];
      if (key) return { ...base, state: "needsLogin", summary: `Codex found. ${key} is set but not passed to Codex – allow it for this agent, or run \`codex login\` and sign in with ChatGPT.`, fix: ctx.approveHint("codex", [key]), driver: "ACP adapter" };
      return { ...base, state: "needsLogin", summary: "Codex found, but it is not signed in. Run `codex login` in a terminal and choose “Sign in with ChatGPT”.", fix: "codex login", driver: "ACP adapter" };
    }
    if (def.id === "codex" && ctx.codexLogin === "chatgpt") return { ...base, state: "ready", summary: `Codex${cli?.version ? ` ${cli.version}` : ""} found and signed in with ChatGPT.`, fix: undefined, driver: "ACP adapter" };
    return { ...base, state: "ready", summary: "Ready (npx downloads the ACP adapter on first start).", fix: undefined, driver: "ACP adapter" };
  }
  if (ctx.found(def.command)) return { ...base, state: "ready", summary: `${def.command} found.`, fix: undefined, driver: "ACP" };
  return { ...base, state: "missing", summary: `\`${def.command}\` was not found in PATH.`, fix: tools.find((t) => t.id === cmd)?.install, driver: "ACP" };
}

/** Bekannte Login-Variablen je Agent (zählen nur, wenn freigegeben). */
export const AGENT_KEY_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

/** Gesetzte, aber nicht freigegebene Login-Variablen. */
export function unapprovedKeys(agentId: string, env: Readonly<Record<string, string | undefined>>, approved: readonly string[]): string[] {
  return (AGENT_KEY_VARIABLES[agentId] ?? []).filter((k) => looksSecret(k) && (env[k] ?? "") !== "" && !approved.includes(k));
}

/** Claude-Login aus Dateiinhalten: `~/.claude/.credentials.json` vorhanden oder `~/.claude.json` mit Konto. */
export function claudeLoginFrom(files: { credentials: boolean; claudeJson: string | undefined }, approvedEnv: Readonly<Record<string, string | undefined>>): boolean {
  if ((approvedEnv.ANTHROPIC_API_KEY ?? "") !== "" || (approvedEnv.CLAUDE_CODE_OAUTH_TOKEN ?? "") !== "") return true;
  if (files.credentials) return true;
  const j = files.claudeJson ?? "";
  return j.includes('"oauthAccount"') || j.includes('"userID"');
}
