// BSD-314: echtes Terminal je Coding-Sitzung (wie Happier/Claude Code im Terminal). Plattformneutral: den PTY-Prozess
// liefert die Hülle (`spawn`, auf dem Server node-pty). Ein Terminal je Sitzung, im Arbeitsordner der Sitzung, mit
// gefilterter Umgebung (BSD-33: Allowlist, keine Geheimnisse). Beliebig viele Geräte hängen sich an; wer neu kommt,
// bekommt die letzten Ausgaben (begrenzter Puffer) und dann alles Neue. Endet die Sitzung, endet das Terminal.
import { childEnvironment } from "./agents.js";

/** Ein laufender Pseudo-Terminal-Prozess (Ausschnitt aus node-pty). */
export interface Pty {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number | undefined }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtyFactory = (file: string, args: string[], o: { cwd: string; cols: number; rows: number; env: Record<string, string>; name: string }) => Pty;

/** Nachrichten an ein Gerät. */
export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

/** Nachrichten von einem Gerät (nach der Anmeldung). */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface TerminalClient {
  send(m: TerminalServerMessage): void;
}

export interface TerminalsOptions {
  spawn: PtyFactory;
  /** Umgebung des Servers; geht gefiltert an die Shell (BSD-33). */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** Shell (Standard: $SHELL aus der Basis, sonst /bin/bash). */
  shell?: string;
  /** Höchstens so viele Zeichen Ausgabe für später Kommende (Standard 200.000). */
  maxBuffer?: number;
}

const clampSize = (n: unknown, max: number, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(2, Math.floor(n))) : fallback);

/** Eingabe eines Geräts lesen (alles andere wird ignoriert). */
export function parseTerminalMessage(raw: string): TerminalClientMessage | undefined {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return undefined; }
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (o.type === "input" && typeof o.data === "string" && o.data.length <= 64 * 1024) return { type: "input", data: o.data };
  if (o.type === "resize") return { type: "resize", cols: clampSize(o.cols, 500, 80), rows: clampSize(o.rows, 200, 24) };
  return undefined;
}

class Terminal {
  buffer = "";
  readonly clients = new Set<TerminalClient>();
  exited: number | undefined;
  constructor(readonly pty: Pty, private readonly max: number, onExit: () => void) {
    pty.onData((d) => {
      this.buffer += d;
      if (this.buffer.length > this.max) this.buffer = this.buffer.slice(this.buffer.length - this.max);
      for (const c of this.clients) c.send({ type: "output", data: d });
    });
    pty.onExit((e) => {
      this.exited = e.exitCode;
      for (const c of this.clients) c.send({ type: "exit", code: e.exitCode });
      onExit();
    });
  }
}

export class Terminals {
  private readonly open = new Map<string, Terminal>();
  constructor(private readonly o: TerminalsOptions) {}

  get size(): number { return this.open.size; }

  private shell(): string {
    return this.o.shell ?? this.o.baseEnv.SHELL ?? "/bin/bash";
  }

  /**
   * Gerät an das Terminal der Sitzung hängen (startet es beim ersten Mal im Ordner `cwd`). Gibt Eingabe und
   * Abmelden zurück. Die bisherige Ausgabe geht sofort an das Gerät.
   */
  attach(sessionId: string, cwd: string, client: TerminalClient, size: { cols?: number; rows?: number } = {}): { input(m: TerminalClientMessage): void; detach(): void } {
    let t = this.open.get(sessionId);
    if (!t) {
      const env = { ...childEnvironment(this.o.baseEnv), TERM: "xterm-256color", COLORTERM: "truecolor", BASED_TERMINAL: "1" };
      const pty = this.o.spawn(this.shell(), ["-l"], { cwd, cols: clampSize(size.cols, 500, 80), rows: clampSize(size.rows, 200, 24), env, name: "xterm-256color" });
      t = new Terminal(pty, this.o.maxBuffer ?? 200_000, () => { if (this.open.get(sessionId) === t) this.open.delete(sessionId); });
      this.open.set(sessionId, t);
    }
    const term = t;
    term.clients.add(client);
    if (term.buffer) client.send({ type: "output", data: term.buffer });
    if (term.exited !== undefined) client.send({ type: "exit", code: term.exited });
    return {
      input: (m) => {
        if (term.exited !== undefined) return;
        if (m.type === "input") term.pty.write(m.data);
        else term.pty.resize(m.cols, m.rows);
      },
      detach: () => { term.clients.delete(client); },
    };
  }

  /** Terminal der Sitzung beenden (Sitzung geschlossen). */
  close(sessionId: string): void {
    const t = this.open.get(sessionId);
    if (!t) return;
    this.open.delete(sessionId);
    try { t.pty.kill(); } catch { /* schon weg */ }
  }

  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}
