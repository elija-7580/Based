// BSD-243: Zeitpläne laufen auch bei geschlossener App. Der Server prüft die gesyncten Zeitplan-Records aller Agenten
// (nicht nur des Hauptagenten) und legt fällige Läufe als Run-Records an („queued“) – dieselbe Regel wie in der App
// (`claimSchedule` + `scheduledRun` aus @based/brain). Ausgeführt werden sie von der App bzw. einem Ausführer, sobald
// einer läuft; kein Termin geht verloren, verpasste werden höchstens einmal nachgeholt. Doppelausführung verhindert
// der weitergeschobene Termin: wer ihn zuerst weiterschiebt, legt den Lauf an (über Sync v2 sehen es alle).
import { AgentStore, scheduledRun } from "@based/brain";
import type { WorkspaceStore } from "@based/core";
import type { Logger } from "./log.js";

export interface SchedulerOptions {
  /** Abstand der Prüfungen (Standard 30 s). */
  intervalMs?: number;
  now?: () => number;
  log?: Logger;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly agents: AgentStore;
  private readonly now: () => number;

  constructor(readonly store: WorkspaceStore, private readonly opts: SchedulerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.agents = new AgentStore(store, this.now);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick(); }, this.opts.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
