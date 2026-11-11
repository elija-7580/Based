// BSD-243: Zeitpläne laufen auch bei geschlossener App. Der Server prüft die gesyncten Zeitplan-Records aller Agenten
// (nicht nur des Hauptagenten) und legt fällige Läufe als Run-Records an („queued“) – dieselbe Regel wie in der App
// (`claimSchedule` + `scheduledRun` aus @based/brain). Doppelausführung verhindert der weitergeschobene Termin: wer
// ihn zuerst weiterschiebt, legt den Lauf an (über Sync v2 sehen es alle).
// Teil 2: Ist auf dem Server ein Modell eingerichtet (`engine`), führt er wartende Läufe selbst aus – derselbe
// AgentRunner wie in der App, Lease über den Run-Record (läuft die App zugleich, übernimmt nur einer). Fragepflichtige
// Werkzeugaufrufe werden dort abgelehnt (niemand könnte sie erlauben). Ohne Modell bleiben die Läufe „queued“, bis
// eine App sie ausführt.
import { AgentRunner, AgentStore, ChatStore, scheduledRun, type AgentRunBackend, type AgentRunnerOptions } from "@based/brain";
import type { WorkspaceStore } from "@based/core";
import type { Logger } from "./log.js";

export interface SchedulerOptions {
  /** Abstand der Prüfungen (Standard 30 s). */
  intervalMs?: number;
  now?: () => number;
  log?: Logger;
  /** Teil 2: Engine für Läufe auf dem Server (ohne: Läufe warten auf die App). */
  engine?: AgentRunnerOptions["engine"] | undefined;
}

/** Run-Backend direkt über den Server-Store (gleiche Records wie über Sync v2). */
export function storeRunBackend(agents: AgentStore, chats: ChatStore): AgentRunBackend {
  const a = <T>(f: () => T) => Promise.resolve().then(f);
  return {
    runs: () => a(() => agents.runs()), claimRun: (id, o) => a(() => agents.claimRun(id, o)), updateRun: (id, p) => a(() => agents.updateRun(id, p)),
    createRun: (d) => a(() => agents.createRun(d)), main: () => a(() => agents.main()), projects: () => a(() => agents.projects()),
    schedules: () => a(() => agents.schedules()), claimSchedule: (id, n) => a(() => agents.claimSchedule(id, n)),
    chatCreate: (title) => a(() => chats.create({ title })), chatSave: (id, b, e) => a(() => chats.save(id, b, e)),
    projectUpdate: (id, md) => a(() => agents.projectUpdate(id, md)),
  };
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly agents: AgentStore;
  private readonly now: () => number;
  /** Teil 2: führt Läufe aus, wenn ein Modell eingerichtet ist. */
  readonly runner: AgentRunner | undefined;

  constructor(readonly store: WorkspaceStore, private readonly opts: SchedulerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.agents = new AgentStore(store, this.now);
    this.runner = opts.engine
      ? new AgentRunner({ backend: storeRunBackend(this.agents, new ChatStore(store)), engine: opts.engine, owner: "server", now: this.now, approvals: "deny" })
      : undefined;
  }

  /** Läuft auf dem Server ein Ausführer? (sonst nur bei offener App) */
  get executes(): boolean {
    return this.runner !== undefined;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.cycle(); }, this.opts.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of this.runner?.activeRuns ?? []) this.runner?.cancel(id);
  }

  /** Eine Runde: fällige Zeitpläne anlegen, dann (mit Modell) wartende Läufe starten. */
  async cycle(): Promise<number> {
    const fired = this.tick();
    if (this.runner && !this.store.isReadOnly) {
      await this.runner.tick().catch((e: unknown) => this.opts.log?.warning("scheduler: run failed", { error: e instanceof Error ? e.name : "unknown" }));
    }
    return fired;
  }

  /** Fällige Zeitpläne übernehmen und Läufe anlegen. Gibt die Zahl der angelegten Läufe zurück. */
  tick(): number {
    if (this.store.isReadOnly) return 0;
    const now = this.now();
    let fired = 0;
    for (const s of this.agents.schedules()) {
      if (!s.data.enabled || s.data.nextAt === undefined) continue;
      try {
        if (!this.agents.claimSchedule(s.id, now)) continue;
        this.agents.createRun(scheduledRun(s, this.agents.main(), this.agents.runs(), now));
        fired += 1;
      } catch (e) {
        this.opts.log?.warning("scheduler: schedule failed", { error: e instanceof Error ? e.name : "unknown" });
      }
    }
    if (fired > 0) this.opts.log?.info("scheduler: queued scheduled runs", { count: fired });
    return fired;
  }
}
