// Die Befehle (Swift `BasedCLI`): alles über MCP-Werkzeuge des Servers. Was ein Server nicht anbietet (der TS-Server
// hat noch keinen Hauptagenten und keine Läufe), meldet der Befehl ehrlich, statt etwas vorzutäuschen. Werkzeug-
// Argumente passen sich an das Schema an (TS-Server: `id`/`parent`, Swift-Server: `page_id`/`parent_id`).
import { CLIError, USAGE, VERSION, type CLICommand } from "./args.js";

export interface ToolInfo {
  name: string;
  description?: string | undefined;
  inputSchema?: { properties?: Record<string, unknown> | undefined } | undefined;
}

export interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Was der Befehl vom MCP-Client braucht (in Tests: echter Client gegen einen In-Process-Server). */
export interface MCPSession {
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

const UUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

export function idsIn(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of s.matchAll(UUID)) {
    if (!seen.has(m[0].toLowerCase())) {
      seen.add(m[0].toLowerCase());
      out.push(m[0]);
    }
  }
  return out;
}

const isID = (s: string) => {
  const ids = idsIn(s);
  return ids.length === 1 && ids[0] === s;
};

export const TERMINAL = new Set(["Done", "Failed", "Cancelled"]);

/** Was `get_run` über einen Lauf sagt: Status (erste Zeile „- [Status] …“) und den Abschnitt „Result:“. */
export function runSnapshot(text: string): { status?: string; result: string } {
  const first = text.split(/\r?\n/)[0] ?? "";
  const m = /^- \[([^\]]+)\]/.exec(first);
  let result = "";
  const i = text.indexOf("\n\nResult:\n");
  if (i >= 0) {
    const rest = text.slice(i + "\n\nResult:\n".length);
    const ends = ["\n\nProtocol:\n", "\n\nSub-runs:\n"].map((e) => rest.indexOf(e)).filter((x) => x >= 0);
    result = rest.slice(0, ends.length ? Math.min(...ends) : rest.length).trim();
  }
  return m ? { status: m[1]!, result } : { result };
}

/** Befehl, der eine Shell in der Sandbox eines Laufs öffnet („docker:<container>“ oder „local:<pfad>“). */
export function shellCommand(ref: string, runID: string): string {
  const safe = (s: string) => s !== "" && /^[\p{L}\p{N}\-_./]+$/u.test(s);
  if (ref.startsWith("docker:")) {
    const c = ref.slice(7);
    if (!safe(c) || c.includes("/")) throw new CLIError(`Run ${runID} has no usable container name`);
    return `docker exec -it ${c} /bin/sh`;
  }
  if (ref.startsWith("local:")) {
    const p = ref.slice(6);
    if (!safe(p)) throw new CLIError(`Run ${runID} has no usable sandbox path`);
    return `cd ${p} && exec "\${SHELL:-/bin/sh}"`;
  }
  throw new CLIError(`Run ${runID} has no sandbox`);
}

export interface RunOptions {
  json?: boolean;
  stdin?: () => Promise<string> | string;
  out: (line: string) => void;
  /** Für `ask --wait` (Tests: sofort). */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export class BasedCLI {
  private tools: Map<string, ToolInfo> | undefined;

  constructor(readonly session: MCPSession, readonly opts: RunOptions) {}

  private async tool(name: string, feature: string): Promise<ToolInfo> {
    this.tools ??= new Map((await this.session.listTools()).map((t) => [t.name, t]));
    const t = this.tools.get(name);
    if (!t) throw new CLIError(`This server doesn't offer ${feature} (no \`${name}\` tool). Run \`based tools\` to see what it offers.`);
    return t;
  }

  /** Name eines Arguments im Schema des Werkzeugs (erster Kandidat, den es kennt; sonst der erste). */
  private static arg(t: ToolInfo, ...candidates: string[]): string {
    const props = t.inputSchema?.properties ?? {};
    return candidates.find((c) => c in props) ?? candidates[0]!;
  }

  /** Werkzeug aufrufen; Text zurück, Werkzeugfehler als CLIError. */
  async call(t: ToolInfo, args: Record<string, unknown>): Promise<string> {
    const r = await this.session.callTool(t.name, args);
    const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new CLIError(text || `${t.name} failed`);
    return this.opts.json ? JSON.stringify(r) : text;
  }

  private async projectID(ref: string): Promise<string> {
    if (isID(ref)) return ref;
    const t = await this.tool("get_project", "projects");
    const id = idsIn(await this.call(t, { [BasedCLI.arg(t, "project")]: ref }))[0];
    if (!id) throw new CLIError(`No project ${ref}`);
    return id;
  }

  async execute(c: CLICommand): Promise<void> {
    const out = this.opts.out;
    switch (c.name) {
      case "help": return out(USAGE);
      case "version": return out(`based ${VERSION}`);
      case "login":
      case "config":
      case "reports":
        throw new CLIError("handled by the executable");
      case "tools": {
        this.tools = undefined;
        const list = (await this.session.listTools()).sort((a, b) => (a.name < b.name ? -1 : 1));
        return out(list.map((t) => `${t.name}${t.description ? ` — ${t.description.split("\n")[0]}` : ""}`).join("\n"));
      }
      case "ask": {
        const t = await this.tool("ask_main_agent", "`ask` (the main agent)");
        const args: Record<string, unknown> = { task: c.task };
        if (c.kind) args.kind = c.kind;
        if (c.project) args.project = c.project;
        const handed = await this.call(t, args);
        if (!c.wait) return out(handed);
        const runID = idsIn(handed)[0];
        if (!runID) {
          out(handed);
          throw new CLIError("The main agent returned no run id to follow");
        }
        out(`Run ${runID} started — waiting for the result (Ctrl-C stops waiting, the run keeps going).`);
        return this.follow(runID, (c.timeout ?? 1800) * 1000);
      }
      case "runs": {
        const t = await this.tool("list_runs", "runs");
        const args: Record<string, unknown> = {};
        if (c.status) args.status = c.status;
        if (c.limit) args.limit = c.limit;
        return out(await this.call(t, args));
      }
      case "run": {
        const t = await this.tool("get_run", "runs");
        return out(await this.call(t, { [BasedCLI.arg(t, "run_id", "id")]: c.id }));
      }
      case "inbox":
        return out(await this.call(await this.tool("inbox", "an inbox"), {}));
      case "search": {
        const t = await this.tool("search", "search");
        return out(await this.call(t, { query: c.query, ...(c.limit ? { limit: c.limit } : {}) }));
      }
      case "pageList": {
        const t = await this.tool("list_pages", "page lists");
        const args: Record<string, unknown> = {};
        if (c.parent) args[BasedCLI.arg(t, "parent", "parent_id")] = c.parent;
        if (c.limit) args.limit = c.limit;
        return out(await this.call(t, args));
      }
      case "pageGet": {
        const read = await this.tool("read_page", "reading pages");
        const idArg = BasedCLI.arg(read, "id", "page_id");
        if (isID(c.ref)) return out(await this.call(read, { [idArg]: c.ref }));
        const found = await this.call(await this.tool("search", "search"), { query: c.ref, limit: 10 });
        const ids = idsIn(found);
        if (ids.length === 0) throw new CLIError(`No page matches "${c.ref}"`);
        // Ein exakter Titel gewinnt; sonst nur ein eindeutiger Treffer.
        const exact = found.split(/\r?\n/).find((line) => {
          const title = line.replace(/^- /, "").replace(/\s*\(id: .*$/, "").replace(/\*/g, "").trim();
          return title.toLowerCase() === c.ref.toLowerCase() && idsIn(line).length > 0;
        });
        const pick = exact ? idsIn(exact)[0] : ids.length === 1 ? ids[0] : undefined;
        if (!pick) {
          out(found);
          throw new CLIError(`${ids.length} pages match — pass the id`);
        }
        return out(await this.call(read, { [idArg]: pick }));
      }
      case "pageNew": {
        const t = await this.tool("create_page", "creating pages");
        const args: Record<string, unknown> = { title: c.title };
        const body = (await this.opts.stdin?.()) ?? "";
        if (body.trim() !== "") args.markdown = body;
        const parentArg = BasedCLI.arg(t, "parent", "parent_id");
        if (c.project) args[parentArg] = await this.projectID(c.project);
        if (c.parent) args[parentArg] = c.parent;
        return out(await this.call(t, args));
      }
      case "sandboxShell": {
        const t = await this.tool("get_run", "runs");
        const run = await this.call(t, { [BasedCLI.arg(t, "run_id", "id")]: c.runID });
        const line = run.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("sandbox:"));
        if (!line) throw new CLIError(`Run ${c.runID} has no sandbox`);
        return out(shellCommand(line.slice(line.indexOf(":") + 1).trim(), c.runID));
      }
    }
  }

  /** `get_run` abfragen, bis der Lauf endet: Statuswechsel und letzte Fortschrittszeile, dann das Ergebnis. */
  async follow(runID: string, timeoutMs: number): Promise<void> {
    const t = await this.tool("get_run", "runs");
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const step = this.opts.pollMs ?? 2000;
    let waited = 0;
    let lastStatus: string | undefined, lastProgress = "";
    for (;;) {
      const snap = runSnapshot(await this.call(t, { [BasedCLI.arg(t, "run_id", "id")]: runID }));
      if (snap.status && TERMINAL.has(snap.status)) {
        if (snap.result) this.opts.out(snap.result);
        if (snap.status === "Done") return;
        throw new CLIError(snap.status === "Failed" ? `Run ${runID} failed${snap.result ? " (see above)" : ""}` : `Run ${runID} was cancelled`);
      }
      if (snap.status && snap.status !== lastStatus) {
        this.opts.out(`· ${snap.status}`);
        if (snap.status === "Needs you") this.opts.out("  The run waits for you — answer it in Based (Inbox).");
        lastStatus = snap.status;
      }
      const progress = snap.result.split(/\r?\n/).at(-1) ?? "";
      if (progress && progress !== lastProgress) {
        this.opts.out("  " + progress);
        lastProgress = progress;
      }
      if (waited >= timeoutMs) throw new CLIError(`Still ${lastStatus ?? "running"} after ${Math.round(timeoutMs / 1000)} s — follow it with \`based run ${runID}\``);
      const ms = Math.min(step, Math.max(100, timeoutMs - waited));
      await sleep(ms);
      waited += ms;
    }
  }
}
