// Sandbox-Endpunkte (nur Owner, BSD-161 / Swift `SandboxPart4`): Läufe mit ihren Sandboxen, Snapshots anlegen,
// auflisten, wiederherstellen, Sandbox beenden, Reste aufräumen (nur mit Bestätigung). Gestartet werden Sandboxen
// vom Agenten-Laufzeitsystem (noch nicht im TS-Server), nicht über HTTP.
import type { Logger } from "./log.js";
import { error, json, type RouteResult, type Router } from "./router.js";
import { SandboxError, type SandboxHandle, type SandboxManager } from "./sandbox.js";

const view = (s: SandboxHandle) => ({
  runID: s.runID ?? null,
  provider: s.provider,
  // „docker:<kurze ID>“ wie in der Runs-Datenbank der Swift-App
  reference: `${s.provider}:${s.provider === "docker" ? s.id.slice(0, 12) : s.id}`,
  project: s.project,
  workdir: s.workdir,
  image: s.image,
  snapshots: s.snapshots.map((x) => ({ name: x.name, image: x.image, createdAt: x.createdAt })),
});

function parse(body: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(body.toString("utf8")) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function guarded(f: () => Promise<RouteResult>): Promise<RouteResult> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SandboxError) return error(e.message, 400);
    throw e;
  }
}

export function registerSandboxRoutes(router: Router, sandbox: SandboxManager, log: Logger) {
  router.add("GET", "/sandbox/runs", () => json({ provider: sandbox.provider.kind, runs: sandbox.list().map(view) }));
  router.add("GET", "/sandbox/runs/:run", ({ params }) => {
    const s = sandbox.get(params.run!);
    return s ? json(view(s)) : error("not found", 404);
  });
  router.add("POST", "/sandbox/runs/:run/snapshots", ({ params, body }) => guarded(async () => {
    const name = parse(body).name;
    if (typeof name !== "string") return error("name", 400);
    const snap = await sandbox.snapshot(params.run!, name);
    log.info("sandbox snapshot", { provider: sandbox.provider.kind });
    return json({ name: snap.name, image: snap.image, createdAt: snap.createdAt });
  }));
  router.add("POST", "/sandbox/runs/:run/restore", ({ params, body }) => guarded(async () => {
    const name = parse(body).name;
    if (typeof name !== "string") return error("name", 400);
    const s = await sandbox.restore(params.run!, name);
    log.info("sandbox restored", { provider: sandbox.provider.kind });
    return json(view(s));
  }));
  router.add("POST", "/sandbox/runs/:run/stop", ({ params }) => guarded(async () => {
    await sandbox.stop(params.run!);
    return json({ ok: true });
  }));
  router.add("GET", "/sandbox/leftovers", () => guarded(async () => json({ leftovers: await sandbox.leftovers() })));
  router.add("POST", "/sandbox/cleanup", ({ body }) => guarded(async () => {
    const b = parse(body);
    const refs = Array.isArray(b.references) ? b.references.filter((r): r is string => typeof r === "string") : [];
    const removed = await sandbox.cleanUp(refs, b.confirmed === true);
    if (removed.length > 0) log.info("sandbox cleanup", { removed: removed.length });
    return json({ removed });
  }));
}
