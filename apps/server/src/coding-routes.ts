// BSD-223 Teil 2: Coding-Agent-Sitzungen über den Server (nur Owner). Die Logik liegt in `@based/brain`
// (`CodingSessions`); hier nur HTTP. Ereignisse und Freigabe-Inbox per Long-Poll (wie /sync/pull), damit jedes Gerät
// mitlesen und Freigaben beantworten kann. Aus, solange der Server ohne `--coding-root` startet.
import { CodingError, type CodingSessions } from "@based/brain";
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
function waitParam(url: URL, max: number): number {
  const raw = Number(url.searchParams.get("wait") ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, max) : 0;
}

export function registerCodingRoutes(router: Router, coding: CodingSessions, log: Logger, longPollMs = CODING_LONG_POLL_MS) {
  router.add("GET", "/coding/agents", () =>
    json({ agents: coding.agents().map((a) => ({ id: a.id, name: a.name, icon: a.icon, note: a.note })) }));

  router.add("GET", "/coding/sessions", () => json({ sessions: coding.list() }));

  router.add("POST", "/coding/sessions", ({ body }) => guarded(async () => {
    const b = parse(body);
    const agentId = str(b.agent), cwd = str(b.cwd);
    if (!agentId || !cwd) return error("agent and cwd are required", 400);
    const view = await coding.create({ agentId, cwd, mode: str(b.mode), resume: str(b.resume), handoffFrom: str(b.handoffFrom) });
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
    const text = str(parse(body).prompt);
    if (!text?.trim()) return error("prompt is required", 400);
    coding.prompt(params.id!, text);
    return json({ ok: true }, 202);
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
}
