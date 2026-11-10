# @based/brain

KI-Fundament von Based Next: ein ChatEvent-Strom für alle Engines (ADR 0005), Anbieter, Werkzeuge, Transkripte
(BSD-159/77/74) und der Agenten-Kern (ADR 0007, ADR 0013: BSD-195/196/160). Reines TypeScript, kein DOM.

## Agenten-Kern – API für die Startseite (BSD-162/197)

Alles liegt als Record im Store (Blöcke unter `w`, Sync v2 überträgt sie, unbekannte Felder bleiben erhalten).
Zeiten in Swift-Sekunden (`toMs`/`fromMs` in `agents/records.ts`).

### Records

| Block-Typ | Feld in `props` | Typ | Inhalt |
| --- | --- | --- | --- |
| `agentTask` | `task` | `TaskData` | Auftrag: `state`, `input`, `plan`, `decisions`, `question`, `proposal`, `answer`, `result`, `undo`, `projectID`, `runID`, `usage`, `log` |
| `agentRun` | `run` | `RunData` | Lauf: `kind` (`chat`/`main`/`subagent`/`schedule`), `status` (`queued`/`running`/`needsYou`/`done`/`failed`/`cancelled`), `taskID`, `parentID`, `projectID`, `chatID` (Transkript), `usage`, `costEUR`, `budgetEUR`, `subscriptionShare` (nur Feld) |
| `agentProject` | `project` | `ProjectData` | Projekt: `status`, `goal`, `pageID` (Updates landen dort), `permissions`, `budgetEUR` |
| `agentProfile` | `agent` | `AgentData` | Hauptagent (feste ID `MAIN_AGENT_ID`): Planer-`model`, `monthlyBudgetEUR`, `perTaskEUR`, `eurPerUSD`, `permissions {mode, rules}`, gelernte `examples` |
| `agentSchedule` | `schedule` | `ScheduleData` | Zeitplan: `when` („daily 06:30“ …), `prompt`, `nextAt`, `lastAt`, `enabled` |

Notizen aus dem Fallback und Aufgaben ohne Projekt landen auf der Seite „Inbox“ (feste ID `INBOX_PAGE_ID`).

### Zustände eines Auftrags (`agents/task.ts`)

`received → understanding → question | proposal | executing → done`; `failed`, `filed` (als Notiz abgelegt),
`undone`. `needsWork(state)` = der Runner arbeitet weiter, `needsUser(state)` = „Needs you“. Übergänge nur über
`transition(task, event, at)` (rein, wirft `TransitionError`).

### Ereignisse

- Im Web hält der Store-Worker `ShellState.agents` (`AgentSnapshot`: `tasks`, `runs`, `projects`, `schedules`,
  `main`, `spentEUR`) aktuell – lokal, aus anderen Tabs und über Sync (`agents`-Ereignis).
- AG-UI-Stil: `new TaskStream().update(snapshot.tasks)` liefert `STATE_SNAPSHOT`, danach `STATE_DELTA` (JSON-Patch),
  `RUN_STARTED`, `TOOL_CALL_END` (je ausgeführter Aktion), `RUN_FINISHED`, `RUN_ERROR`. `applyPatch` baut den Stand nach.

### Client-Methoden (Web, `apps/web/src/tasks/runtime.ts`)

```ts
const rt = tasksRuntime(client);       // einmal; startet in App.tsx
await rt.submit("Buy milk tomorrow");  // Record zuerst, dann planen
rt.runner.answer(taskID, option);      // Rückfrage-Knopf
rt.runner.confirm(taskID);             // Vorschlag ausführen
rt.runner.dismiss(taskID);             // als Notiz ablegen
rt.runner.undo(taskID);                // Undo (eine Transaktion, nur Unverändertes)
rt.runner.retry(taskID);               // Try again
rt.agents.approve(runID, callID, ok);  // Freigabe eines Unteragenten
rt.getState()                          // { active, approvals, ready } (useSyncExternalStore)
client.agents({ op: ... })             // Records direkt (worker/agents.ts, AgentAction)
```

Ohne Web: `new AgentStore(store)` (synchron, im Worker/Server), `new TaskRunner({ backend: localBackend(agentStore), engine })`,
`new AgentRunner({ backend, engine })` für Unteragenten und Zeitpläne.

### Plan (`agents/plan.ts`, Zod)

Aktionen: `answer`, `create_page`, `create_task`, `file_to_project`, `spawn_agent`, `schedule`, `ask` – je mit
`id`, `reason`, `confidence`. `parsePlan` prüft, `assess` ordnet Sicherheitsstufen zu (`auto`/`propose`/`ask`/`deny`
nach Modus, Regeln, Budget, Sicherheit), `executePlan` setzt in einer Transaktion um. `RulesPlannerEngine` ist der
Scripted-Planer für Tests, Golden-Set (`test/fixtures/golden-plans.json`) und E2E (`__basedTasks.useRules()`).
