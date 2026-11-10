// BSD-195/196/160: schlichte Auftragsliste (#tasks) zum Testen des Agenten-Kerns – Eingabe wird sofort eine Karte
// („Received“), dann Plan, Rückfrage-Knöpfe, Vorschlag bestätigen, Undo, Try again; Unteragenten mit Kosten und
// Freigaben. Die eigentliche Startseite (Zeitbogen, fliegende Karten; BSD-162/197) baut darauf auf.
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { actionLabel, budgetLevel, formatEUR, INBOX_PAGE_ID, type Decision, type Rec, type RunData, type TaskState, type TaskView } from "@based/brain";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ShellState, StoreClient } from "../worker/client.js";
import { tasksRuntime } from "./runtime.js";
import "./tasks.css";

const STATE_LABEL: Record<TaskState, string> = {
  received: "Received", understanding: "Understanding", question: "Needs you", proposal: "Proposal", executing: "Running",
  done: "Done", failed: "Failed", filed: "Filed as note", undone: "Undone",
};

const DOT: Record<TaskState, "success" | "warning" | "error" | "accent" | "neutral"> = {
  received: "neutral", understanding: "accent", question: "warning", proposal: "warning", executing: "accent", done: "success", failed: "error", filed: "neutral", undone: "neutral",
};

const DECISION_LABEL: Record<Decision, string> = { auto: "", propose: "needs OK", ask: "", deny: "blocked" };

export function TasksScreen({ client, state }: { client: StoreClient; state: ShellState }) {
  const rt = tasksRuntime(client);
  const ui = useSyncExternalStore(rt.subscribe, rt.getState);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const snap = state.agents;

  useEffect(() => {
    if (state.ready && !snap) void client.agentSnapshot().catch(() => undefined);
  }, [state.ready, snap, client]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(undefined);
    try {
      await rt.submit(t);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = (f: () => Promise<void>) => () => { f().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
  const projectName = (id: string) => snap?.projects.find((p) => p.id === id)?.name;
  const level = snap ? budgetLevel(snap.spentEUR, snap.main.monthlyBudgetEUR) : "ok";

  return (
    <div className="content tasks-screen" data-testid="tasks-screen">
      <div className="column">
        <VStack gap={5}>
          <VStack gap={1}>
            <h1 className="t-title">Tasks</h1>
            <Text type="supporting" color="secondary">
              Everything you send becomes a card. It stays here until Based knows where it belongs.
            </Text>
            {snap ? (
              <Text type="code" color="secondary" data-testid="tasks-budget">
                {`this month ${formatEUR(snap.spentEUR)}${snap.main.monthlyBudgetEUR !== undefined ? ` of ${formatEUR(snap.main.monthlyBudgetEUR)}` : ""}${level !== "ok" ? ` · budget ${level === "warning" ? "at 80 %" : "used up"}` : ""}`}
              </Text>
            ) : null}
          </VStack>

          <Card>
            <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <VStack gap={3}>
                <TextArea label="Tell the main agent" value={text} onChange={setText} rows={2} width="100%" placeholder="Buy milk tomorrow · Research competitors for Publit · Remind me daily at 7:30 …"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
                <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
                  <Text type="supporting" color="secondary">
                    {ui.ready ? "Saved first, then planned — also offline." : "No model set up: tasks are saved and wait. Add one in Settings → Agents & AI."}
                  </Text>
                  <Button type="submit" variant="primary" label="Send" isDisabled={!text.trim() || busy || !state.ready} />
                </HStack>
                {error ? <Text type="supporting" className="task-error" role="alert">{error}</Text> : null}
              </VStack>
            </form>
          </Card>

          {ui.approvals.length > 0 ? (
            <VStack gap={3}>
              {ui.approvals.map((a) => (
                <Card key={a.runID + a.callID} data-testid="run-approval">
                  <VStack gap={2}>
                    <HStack gap={2} vAlign="center"><StatusDot variant="warning" label="Needs you" /><Text type="label">Needs you</Text></HStack>
                    <Text type="body">{`${snap?.runs.find((r) => r.id === a.runID)?.name ?? "An agent"} wants to use ${a.name}.`}</Text>
                    <HStack gap={2}>
                      <Button variant="primary" size="sm" label="Allow" onClick={() => rt.agents.approve(a.runID, a.callID, true)} />
                      <Button variant="secondary" size="sm" label="Deny" onClick={() => rt.agents.approve(a.runID, a.callID, false)} />
                    </HStack>
                  </VStack>
                </Card>
              ))}
            </VStack>
          ) : null}

          {!snap ? <Skeleton height={80} /> : snap.tasks.length === 0 ? (
            <EmptyState title="No tasks yet" description="Write what's on your mind. Based files it as a task, page, project update, reminder or agent." isCompact />
          ) : (
            <VStack gap={3} as="ul" className="task-list" aria-label="Tasks">
              {snap.tasks.map((t) => (
                <TaskCard key={t.id} task={t} runs={snap.runs.filter((r) => r.data.taskID === t.id && r.data.kind !== "main")} projectName={projectName}
                  onAnswer={(o) => act(() => rt.runner.answer(t.id, o))()} onConfirm={act(() => rt.runner.confirm(t.id))} onDismiss={act(() => rt.runner.dismiss(t.id))}
                  onUndo={act(() => rt.runner.undo(t.id))} onRetry={act(() => rt.runner.retry(t.id))} onOpen={(id) => { location.hash = "page-" + id; }} />
              ))}
            </VStack>
          )}
        </VStack>
      </div>
    </div>
  );
}

function clock(swift: number): string {
  const d = new Date(swift * 1000 + 978_307_200_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface CardProps {
  task: TaskView;
  runs: Rec<RunData>[];
  projectName: (id: string) => string | undefined;
  onAnswer: (option: string) => void;
  onConfirm: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  onRetry: () => void;
  onOpen: (pageID: string) => void;
}

function TaskCard({ task, runs, projectName, onAnswer, onConfirm, onDismiss, onUndo, onRetry, onOpen }: CardProps) {
  const d = task.data;
  const working = d.state === "understanding" || d.state === "executing" || runs.some((r) => r.data.status === "running");
  const plan = d.plan?.actions.filter((a) => a.type !== "ask" && a.type !== "answer") ?? [];
  const cost = (d.usage?.costUSD ?? 0) > 0 || runs.some((r) => r.data.costEUR > 0) ? runs.reduce((n, r) => n + r.data.costEUR, 0) : undefined;
  const firstPage = d.targets && d.plan?.actions.find((a) => a.type === "create_page") ? d.targets[d.plan.actions.find((a) => a.type === "create_page")!.id] : undefined;
  return (
    <li className="task-card" data-state={d.state} data-working={working ? "" : undefined} data-testid="task-card">
      <Card>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" hAlign="between">
            <HStack gap={2} vAlign="center">
              <StatusDot variant={DOT[d.state]} label={STATE_LABEL[d.state]} isPulsing={working} />
              <Text type="label" data-testid="task-state">{STATE_LABEL[d.state]}</Text>
              {d.waiting ? <Text type="supporting" color="secondary">{`· waiting: ${d.waiting}`}</Text> : null}
            </HStack>
            <Text type="code" color="secondary">{clock(d.createdAt)}</Text>
          </HStack>
          <Text type="body" display="block" className="task-input">{d.input}</Text>

          {d.state === "understanding" ? (
            <VStack gap={1} aria-label="Understanding"><Skeleton height={10} width="70%" /><Skeleton height={10} width="45%" index={1} /></VStack>
          ) : null}

          {plan.length > 0 && d.state !== "undone" ? (
            <VStack gap={1} as="ul" className="task-plan" aria-label="Plan">
              {plan.map((a) => {
                const dec = d.decisions?.[a.id];
                const done = d.applied?.includes(a.id);
                return (
                  <li key={a.id}>
                    <HStack gap={2} vAlign="center">
                      <Text type="body">{(done ? "✓ " : "") + actionLabel(a, projectName)}</Text>
                      {dec && DECISION_LABEL[dec] && !done ? <Badge variant={dec === "deny" ? "error" : "warning"} label={DECISION_LABEL[dec]} /> : null}
                    </HStack>
                  </li>
                );
              })}
            </VStack>
          ) : null}

          {runs.map((r) => (
            <HStack key={r.id} gap={2} vAlign="center" data-testid="task-run">
              <StatusDot variant={r.data.status === "done" ? "success" : r.data.status === "failed" ? "error" : r.data.status === "needsYou" ? "warning" : "accent"} label={r.data.status} isPulsing={r.data.status === "running"} />
              <Text type="body">{r.name}</Text>
              <Text type="code" color="secondary">{`${r.data.status} · ${formatEUR(r.data.costEUR)}${r.data.budgetEUR !== undefined ? ` of ${formatEUR(r.data.budgetEUR)}` : ""}`}</Text>
              {r.data.result && r.data.status !== "running" ? <Text type="supporting" color="secondary" maxLines={1}>{r.data.result}</Text> : null}
            </HStack>
          ))}

          {d.state === "question" && d.question ? (
            <VStack gap={2} className="task-ask">
              <Text type="label">{d.question.text}</Text>
              <HStack gap={2} wrap="wrap">
                {d.question.options.map((o) => <Button key={o} variant="secondary" size="sm" label={o} onClick={() => onAnswer(o)} />)}
              </HStack>
            </VStack>
          ) : null}

          {d.state === "proposal" ? (
            <VStack gap={2} className="task-ask">
              {(d.proposal ?? []).map((r) => <Text key={r} type="supporting" color="secondary">{r}</Text>)}
              <HStack gap={2} wrap="wrap">
                {plan.some((a) => d.decisions?.[a.id] !== "deny") ? <Button variant="primary" size="sm" label="Go ahead" onClick={onConfirm} /> : null}
                <Button variant="secondary" size="sm" label="File as note" onClick={onDismiss} />
              </HStack>
            </VStack>
          ) : null}

          {d.answer && d.state === "done" ? <Text type="body" display="block" className="task-answer" data-testid="task-answer">{d.answer}</Text> : null}

          {(d.state === "done" || d.state === "undone" || d.state === "filed") && d.result && !(d.state === "done" && d.answer && d.result === "Answered") ? <Text type="supporting" color="secondary" data-testid="task-result">{d.result}</Text> : null}
          {d.state === "failed" ? <Text type="supporting" className="task-error">{d.error ?? "Something went wrong."}</Text> : null}

          {d.state === "done" || d.state === "failed" || d.state === "filed" ? (
            <HStack gap={2} wrap="wrap" vAlign="center">
              {d.state === "done" && (d.undo?.length ?? 0) > 0 ? <Button variant="secondary" size="sm" label="Undo" onClick={onUndo} /> : null}
              {d.state === "done" && firstPage ? <Button variant="ghost" size="sm" label="Open page" onClick={() => onOpen(firstPage)} /> : null}
              {d.state === "filed" && d.noteID ? <Button variant="ghost" size="sm" label="Open Inbox" onClick={() => onOpen(INBOX_PAGE_ID)} /> : null}
              {d.state !== "done" ? <Button variant="secondary" size="sm" label="Try again" onClick={onRetry} /> : null}
              {cost !== undefined ? <Text type="code" color="secondary">{formatEUR(cost)}</Text> : null}
            </HStack>
          ) : null}
        </VStack>
      </Card>
    </li>
  );
}

