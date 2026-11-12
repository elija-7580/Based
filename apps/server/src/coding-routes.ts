// BSD-223 Teil 2: Coding-Agent-Sitzungen über den Server (nur Owner). Die Logik liegt in `@based/brain`
// (`CodingSessions`); hier nur HTTP. Ereignisse und Freigabe-Inbox per Long-Poll (wie /sync/pull), damit jedes Gerät
// mitlesen und Freigaben beantworten kann. Aus, solange der Server ohne `--coding-root` startet.
import { agentStatus, chatgptStatus, CodingError, isComputeLevel, rankFiles, toolCatalog, unapprovedKeys, type CodexLogin, type CodingSessions } from "@based/brain";
import { claudeLoggedIn, codexLoginState, listSessionFiles, probeTools, toolVersion, readCliTranscript, scanCliSessions, testAgent, which } from "@based/brain/acp-node";
import { stat } from "node:fs/promises";
import type { CliSession } from "@based/brain";
import type { Logger } from "./log.js";
import { error, json, type RouteResult, type Router } from "./router.js";

export const CODING_LONG_POLL_MS = 25_000;

function parse(body: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(body.toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

async function guarded(f: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof CodingError) return error(e.message, e.status);
    throw e;
  }
}

/** `wait` in ms aus der Query (0…25 s). */
async function fileSize(path: string): Promise<number | undefined> {
  try { return (await stat(path)).size; } catch { return undefined; }
}

/** Wartet bis zu `ms`, ob die Datei über `since` Bytes wächst (Prüfung alle 300 ms – zuverlässig auch bei Anhängen). */
async function waitForGrowth(path: string, since: number, ms: number, signal: AbortSignal | undefined): Promise<number | undefined> {
  const end = Date.now() + ms;
  let size: number | undefined = since;
  while (Date.now() < end && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, Math.min(300, Math.max(0, end - Date.now()))));
    size = await fileSize(path);
    if (size !== since) return size;
  }
  return size;
}

function waitParam(url: URL, max: number): number {
  const raw = Number(url.searchParams.get("wait") ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, max) : 0;
}

/** Rechner, auf dem die Agenten laufen: Home (CLI-Verlauf, Logins), Umgebung, freigegebene Variablen je Agent. */
export interface CodingHost {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  approvedEnv: Readonly<Record<string, readonly string[]>>;
}

/** Nur freigegebene Variablen eines Agenten (für die Login-Prüfung). */
function approvedValues(host: CodingHost, agentId: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of host.approvedEnv[agentId] ?? []) out[k] = host.env[k];
  return out;
}

export function registerCodingRoutes(router: Router, coding: CodingSessions, log: Logger, longPollMs = CODING_LONG_POLL_MS, host?: CodingHost) {
  router.add("GET", "/coding/agents", () =>
    json({ agents: coding.agents().map((a) => ({ id: a.id, name: a.name, icon: a.icon, note: a.note })) }));

  router.add("GET", "/coding/sessions", () => json({ sessions: coding.list() }));

  router.add("POST", "/coding/sessions", ({ body }) => guarded(async () => {
    const b = parse(body);
    const agentId = str(b.agent), cwd = str(b.cwd);
    if (!agentId || !cwd) return error("agent and cwd are required", 400);
    const effort = isComputeLevel(b.effort) ? b.effort : undefined;
    const purpose = b.purpose === "chat" ? "chat" as const : undefined;
    const view = await coding.create({ agentId, cwd, mode: str(b.mode), resume: str(b.resume), handoffFrom: str(b.handoffFrom), effort, purpose });
    log.info("coding session", { agent: agentId, state: view.state, handoff: view.handoffFrom !== undefined });
    return json(view, view.state === "failed" ? 502 : 201);
  }));

  router.add("GET", "/coding/sessions/:id", ({ params }) => guarded(() => {
    const v = coding.get(params.id!);
    return v ? json(v) : error("session not found", 404);
  }));

  router.add("GET", "/coding/sessions/:id/events", ({ params, url, signal }) => guarded(async () => {
    const since = Number(url.searchParams.get("since") ?? 0);
    if (!Number.isInteger(since) || since < 0) return error("since must be a non-negative integer", 400);
    return json(await coding.events(params.id!, since, waitParam(url, longPollMs), signal));
  }));

  router.add("POST", "/coding/sessions/:id/prompt", ({ params, body }) => guarded(() => {
    const b = parse(body);
    const text = str(b.prompt);
    if (!text?.trim()) return error("prompt is required", 400);
    const files = b.files === undefined ? [] : Array.isArray(b.files) && b.files.every((f) => typeof f === "string") ? (b.files as string[]) : undefined;
    if (!files || files.length > 50) return error("files must be a list of at most 50 paths", 400);
    coding.prompt(params.id!, text, files);
    return json({ ok: true }, 202);
  }));

  // BSD-313: Modus des Agenten (ACP availableModes), z. B. per ⇧Tab.
  router.add("POST", "/coding/sessions/:id/agent-mode", ({ params, body }) => guarded(async () => {
    const mode = str(parse(body).mode);
    if (!mode) return error("mode is required", 400);
    return json(await coding.setAgentMode(params.id!, mode));
  }));

  // BSD-313: @Dateien – nur Dateien unterhalb des Arbeitsordners der Sitzung (.gitignore beachtet).
  router.add("GET", "/coding/sessions/:id/files", ({ params, url }) => guarded(async () => {
    const view = coding.get(params.id!);
    if (!view) return error("session not found", 404);
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30), 200);
    return json({ files: rankFiles(await listSessionFiles(view.cwd), url.searchParams.get("q") ?? "", limit) });
  }));

  router.add("POST", "/coding/sessions/:id/mode", ({ params, body }) => guarded(() => {
    const mode = str(parse(body).mode);
    if (!mode) return error("mode is required", 400);
    return json(coding.setMode(params.id!, mode));
  }));

  router.add("POST", "/coding/sessions/:id/cancel", ({ params }) => guarded(() => {
    coding.cancel(params.id!);
    return json({ ok: true });
  }));

  router.add("DELETE", "/coding/sessions/:id", ({ params }) => guarded(() => {
    coding.close(params.id!);
    return json({ ok: true });
  }));

  router.add("GET", "/coding/inbox", ({ url, signal }) => guarded(async () => {
    const raw = url.searchParams.get("since");
    const since = raw === null || raw === "" ? undefined : Number(raw);
    return json(await coding.pendingPermissions(since, waitParam(url, longPollMs), signal));
  }));

  router.add("POST", "/coding/inbox/:id", ({ params, body }) => guarded(() => {
    const b = parse(body);
    const optionId = b.optionId === null ? undefined : str(b.optionId);
    if (b.optionId !== null && optionId === undefined) return error("optionId (string or null to cancel) is required", 400);
    return coding.answer(params.id!, optionId) ? json({ ok: true }) : error("permission request not found (already answered?)", 404);
  }));

  if (!host) return;

  // MARK: CLI-Verlauf (~/.claude/projects, ~/.codex/sessions), nur lesend
  router.add("GET", "/coding/history", async ({ url }) => {
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 400) || 400), 2000);
    return json({ sessions: await scanCliSessions(host.home, limit) });
  });
  // Live: `?since=<Bytes>&wait=<ms>` wartet, bis die Datei über `since` hinaus wächst (das CLI schreibt gerade), und
  // liefert dann das neue Transkript. `size` ist der nächste `since`. Ohne `since` sofort (wie bisher).
  const files = new Map<string, CliSession>();
  router.add("GET", "/coding/history/:tool/:id", async ({ params, url, signal }) => {
    const key = `${params.tool}:${params.id}`;
    let found = files.get(key);
    if (!found) {
      found = (await scanCliSessions(host.home, 100_000)).find((x) => x.tool === params.tool && x.id === params.id);
      if (!found) return error("conversation not found", 404);
      if (files.size > 200) files.clear();
      files.set(key, found);
    }
    const rawSince = url.searchParams.get("since");
    const since = rawSince === null || rawSince === "" ? undefined : Number(rawSince);
    let size = await fileSize(found.file);
    if (size === undefined) { files.delete(key); return error("conversation not found", 404); }
    if (since !== undefined && Number.isFinite(since) && size === since) {
      size = await waitForGrowth(found.file, since, waitParam(url, longPollMs), signal);
      if (size === since) return json({ size, unchanged: true });
    }
    const session = size !== found.sizeBytes ? { ...found, updatedAt: Date.now(), sizeBytes: size } : found;
    return json({ session, events: await readCliTranscript(found), size });
  });

  // MARK: Setup-Doctor
  router.add("GET", "/coding/doctor", async () => {
    const tools = await probeTools(host.env);
    const loggedIn = await claudeLoggedIn(host.home, approvedValues(host, "claude"));
    const codexPath = tools.find((t) => t.id === "codex")?.path;
    const codexLogin: CodexLogin | undefined = codexPath ? await codexLoginState(codexPath, host.env) : undefined;
    const found = new Set<string>();
    for (const a of coding.agents()) if (await which(a.command, host.env)) found.add(a.command);
    const agents = coding.agents().map((a) => agentStatus(a, tools, {
      claudeLoggedIn: loggedIn,
      unapprovedKeys: (id) => unapprovedKeys(id, host.env, host.approvedEnv[id] ?? []),
      found: (c) => found.has(c),
      approveHint: (id, names) => `BASED_CODING_ENV="${id}=${[...(host.approvedEnv[id] ?? []), ...names].join(",")}" (restart the server)`,
      codexLogin,
    }));
    return json({ tools, agents });
  });

  // MARK: BSD-257 „Mit ChatGPT anmelden“: Codex-Login für Chat und Agenten (Based liest keine Token)
  router.add("GET", "/coding/chatgpt", async () => {
    const path = await which("codex", host.env);
    const [version, login] = path ? await Promise.all([toolVersion(path, host.env), codexLoginState(path, host.env)]) : [undefined, "none" as CodexLogin];
    const install = toolCatalog(process.platform).find((t) => t.id === "codex")?.install ?? "npm install -g @openai/codex";
    return json(chatgptStatus({ agentEnabled: coding.agents().some((a) => a.id === "codex"), path, version, login, cwd: coding.roots[0], install }));
  });
  router.add("POST", "/coding/doctor/:agent/test", async ({ params }) => {
    const agent = coding.agents().find((a) => a.id === params.agent);
    if (!agent) return error("unknown or disabled agent", 404);
    const r = await testAgent(agent, { cwd: host.home, baseEnv: host.env, approvedEnv: host.approvedEnv[agent.id] ?? [] });
    log.info("coding agent test", { agent: agent.id, ok: r.ok });
    return json(r);
  });
}
