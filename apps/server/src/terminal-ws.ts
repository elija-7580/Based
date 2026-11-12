// BSD-314: Terminal einer Coding-Sitzung über WebSocket (/coding/terminal/<sitzung>). Die Logik liegt in
// `@based/brain` (`Terminals`); hier nur Upgrade, Anmeldung und Weiterreichen. Browser können beim WebSocket keinen
// Authorization-Header setzen: die erste Nachricht ist {type:"auth", token, cols, rows}, sonst wird nach 5 s
// geschlossen. Das Token steht damit nie in der URL (und nie im Log).
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { WebSocketServer, type WebSocket } from "ws";
import { parseTerminalMessage, Terminals, type CodingSessions, type PtyFactory } from "@based/brain";
import type { Logger } from "./log.js";
import { tokenEquals } from "./router.js";

export const TERMINAL_PATH = /^\/coding\/terminal\/([^/]+)$/;

/**
 * node-pty mit fertigen Binärdateien (MIT). In der Desktop-App liegt es neben dem gebündelten Server (nicht im
 * Bundle); fehlt es, gibt es kein Terminal, der Server läuft trotzdem.
 */
export function loadPty(): PtyFactory | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pty = req("@homebridge/node-pty-prebuilt-multiarch") as { spawn: PtyFactory };
    return (file, args, o) => pty.spawn(file, args, o);
  } catch {
    return undefined;
  }
}

export class TerminalSockets {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  readonly terminals: Terminals | undefined;

  /** `spawn`: ohne Angabe node-pty, `null` = kein Terminal. */
  constructor(private readonly coding: CodingSessions, private readonly accept: string | ((token: string) => boolean), private readonly log: Logger, spawn?: PtyFactory | null, env: Readonly<Record<string, string | undefined>> = process.env) {
    const pty = spawn === undefined ? loadPty() : spawn ?? undefined;
    this.terminals = pty ? new Terminals({ spawn: pty, baseEnv: env }) : undefined;
    coding.onClosed.add((id) => this.terminals?.close(id));
  }

  /** Upgrade übernehmen, wenn der Pfad passt (sonst `false`). */
  handle = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const m = TERMINAL_PATH.exec(new URL(req.url ?? "/", "http://localhost").pathname);
    if (!m) return false;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, decodeURIComponent(m[1]!)));
    return true;
  };

  private connect(ws: WebSocket, sessionId: string) {
    const send = (o: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    const fail = (message: string, code = 4000) => { send({ type: "error", message }); ws.close(code, message.slice(0, 100)); };
    let link: ReturnType<Terminals["attach"]> | undefined;
    const timer = setTimeout(() => { if (!link) fail("authentication timeout", 4001); }, 5000);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const text = data.toString("utf8");
      if (!link) {
        let auth: { type?: unknown; token?: unknown; cols?: unknown; rows?: unknown } | undefined;
        try { auth = JSON.parse(text) as typeof auth; } catch { auth = undefined; }
        if (auth?.type !== "auth" || typeof auth.token !== "string" || !(typeof this.accept === "string" ? tokenEquals(auth.token, this.accept) : this.accept(auth.token))) return fail("unauthorized", 4401);
        clearTimeout(timer);
        if (!this.terminals) return fail("The terminal is not available on this server (node-pty missing).", 4501);
        const view = this.coding.get(sessionId);
        if (!view) return fail("session not found", 4404);
        if (view.state === "closed" || view.state === "failed") return fail(`session is ${view.state}`, 4409);
        link = this.terminals.attach(sessionId, view.cwd, { send }, { cols: auth.cols as number, rows: auth.rows as number });
        this.log.info("terminal attached", { session: sessionId });
        return;
      }
      const msg = parseTerminalMessage(text);
      if (msg) link.input(msg);
    });
    ws.on("close", () => { clearTimeout(timer); link?.detach(); });
  }

  close() {
    this.terminals?.closeAll();
    for (const c of this.wss.clients) c.terminate();
  }
}
