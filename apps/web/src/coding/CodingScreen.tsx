// BSD-223 Teil 4: Coding-Agenten (#coding) – Sitzungen mit Konsole (Transkript wie im Chat, Modus, Stopp,
// Agentenwechsel), Freigabe-Inbox oben (jedes Gerät mit derselben Server-Verbindung sieht sie), CLI-Verlauf
// (Claude Code, Codex) mit Fortsetzen und Setup-Doctor. Alles läuft auf dem based-server (`--coding-root`).
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { cliResumeCommand, cliSessionsByProject, codingErrorMessage, foldTranscript, type AgentStatus, type CliSession, type DoctorTool, type InboxItem, type TranscriptItem } from "@based/brain";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChatMessages } from "../chat/ChatMessages.js";
import { PERMISSIONS } from "../chat/AiSettingsSection.js";
import { codingModelFor, useCodingConnection } from "./connection.js";
import type { CodingModel } from "./model.js";
import "./coding.css";

type Pane = "sessions" | "history" | "setup";

const STATE_DOT = { starting: "accent", idle: "success", running: "accent", failed: "error", closed: "neutral" } as const;
const noop = () => {};

export function CodingScreen() {
  const { connection, local, pending, turnOnLocal } = useCodingConnection();
  if (connection) return <CodingBody model={codingModelFor(connection)} />;
  // BSD-251: in der Desktop-App genügt der lokale Server – ein Klick, kein eigener Server nötig.
  const desktop = local.status !== "unavailable";
  const problem = local.error ?? (local.node && !local.node.ok ? local.node.message : undefined);
  return (
    <VStack className="coding" gap={4}>
      <Text as="h1" type="large" weight="bold">Coding agents</Text>
      {pending ? <Text type="supporting" role="status">Starting the local server…</Text> : desktop ? (
        <>
          <EmptyState title="Turn on the local server" description="Coding agents (Claude Code, Codex …) and your CLI conversations run through a small Based server on this Mac. It only listens on this computer and needs Node.js 22 or newer."
            actions={<Button variant="primary" label="Turn on" onClick={() => void turnOnLocal()} data-testid="coding-local-on" />} />
          {problem ? <Banner status="error" title="Local server" description={problem} /> : null}
        </>
      ) : (
        <EmptyState title="Connect a based-server" description="Coding agents (Claude Code, Codex, Gemini CLI …) run on your based-server. Connect one in Settings → Sync & server and start it with --coding-root <folder>." />
      )}
    </VStack>
  );
}

function CodingBody({ model }: { model: CodingModel }) {
  const s = useSyncExternalStore(model.subscribe, model.getState);
  const [pane, setPane] = useState<Pane>("sessions");
  useEffect(() => { void model.start(); }, [model]);

  return (
    <VStack className="coding" gap={4} data-testid="coding-screen">
      <HStack hAlign="between" vAlign="center">
        <Text as="h1" type="large" weight="bold">Coding agents</Text>
        <SegmentedControl label="View" value={pane} onChange={(v) => setPane(v as Pane)}>
          <SegmentedControlItem value="sessions" label="Sessions" />
          <SegmentedControlItem value="history" label="CLI history" />
          <SegmentedControlItem value="setup" label="Setup" />
        </SegmentedControl>
      </HStack>
      {s.error ? <Banner status="error" title="Coding agents" description={s.error} /> : null}
      {s.inbox.length > 0 ? <Inbox items={s.inbox} onAnswer={(id, opt) => void model.answer(id, opt)} /> : null}
      {pane === "sessions" ? <Sessions model={model} /> : pane === "history" ? <History model={model} onOpened={() => setPane("sessions")} /> : <Setup model={model} />}
    </VStack>
  );
}

function Inbox({ items, onAnswer }: { items: readonly InboxItem[]; onAnswer: (id: string, optionId: string | undefined) => void }) {
  return (
    <VStack gap={2} data-testid="coding-inbox">
      {items.map((it) => (
        <Card key={it.id} padding={3} className="coding-ask" data-testid="coding-permission">
          <VStack gap={2}>
            <Text weight="semibold">{it.agent} wants to: {it.title}</Text>
            {it.argument && !it.title.includes(it.argument) ? <Text type="supporting" className="coding-mono">{it.argument}</Text> : null}
            <HStack gap={2} wrap="wrap">
              {it.options.map((o) => (
                <Button key={o.optionId} size="sm" variant={o.kind.startsWith("allow") ? (o.kind === "allow_once" ? "primary" : "secondary") : "secondary"} onClick={() => onAnswer(it.id, o.optionId)} label={o.name} />
              ))}
              <Button size="sm" variant="ghost" onClick={() => onAnswer(it.id, undefined)} label="Cancel" />
            </HStack>
          </VStack>
        </Card>
      ))}
    </VStack>
  );
}

function Sessions({ model }: { model: CodingModel }) {
  const s = useSyncExternalStore(model.subscribe, model.getState);
  const current = s.sessions.find((x) => x.id === s.selected);
  const [text, setText] = useState("");
  const send = async () => { if (await model.send(text)) setText(""); };
  const running = current?.state === "running";
  return (
    <HStack gap={4} vAlign="start" className="coding-split">
      <VStack gap={3} className="coding-side">
        <NewSession model={model} />
        <List aria-label="Sessions" data-testid="coding-sessions">
          {s.sessions.map((x) => (
            <ListItem key={x.id} label={`${x.agentName} · ${x.cwd.split("/").pop() || x.cwd}`} description={x.error ?? x.state}
              startContent={<StatusDot variant={STATE_DOT[x.state]} label={x.state} />} isSelected={x.id === s.selected} onClick={() => model.select(x.id)} />
          ))}
        </List>
      </VStack>
      <VStack gap={3} className="coding-main">
        {!current ? (
          <EmptyState title="No session open" description="Start a session on the left, or continue a conversation from the CLI history." isCompact />
        ) : (
          <>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text weight="semibold">{current.agentName}</Text>
              <Text type="supporting" className="coding-mono">{current.cwd}</Text>
              <Selector label="Permissions" isLabelHidden value={current.mode} width="auto"
                options={PERMISSIONS.map((p) => ({ value: p.mode, label: p.name }))} onChange={(v) => v && void model.setMode(v)} />
              <SwitchAgent model={model} from={current.id} cwd={current.cwd} />
              <Button size="sm" variant="ghost" onClick={() => void model.close(current.id)} isDisabled={current.state === "closed"} label="End session" />
            </HStack>
            <Console items={s.items} running={running} />
            <HStack gap={2} vAlign="end" className="coding-composer">
              <TextArea label="Message" isLabelHidden placeholder={`Ask ${current.agentName}…`} value={text} onChange={setText} rows={2}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
              {running
                ? <Button variant="secondary" onClick={() => void model.cancel()} label="Stop" />
                : <Button variant="primary" onClick={() => void send()} isDisabled={!text.trim() || current.state !== "idle"} data-testid="coding-send" label="Send" />}
            </HStack>
          </>
        )}
      </VStack>
    </HStack>
  );
}

function Console({ items, running }: { items: readonly TranscriptItem[]; running: boolean }) {
  return (
    <VStack className="coding-console" data-testid="coding-console">
      <ChatMessages items={items} running={running} approvals={[]} onAnswer={noop} onRetry={noop}
        empty={<EmptyState title="Say what to do" description="The agent works in this folder. File edits and commands ask first, unless the permission mode allows them." isCompact />} />
    </VStack>
  );
}

function NewSession({ model }: { model: CodingModel }) {
  const s = useSyncExternalStore(model.subscribe, model.getState);
  const [agent, setAgent] = useState<string>();
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = agent ?? s.agents[0]?.id;
  const start = async () => {
    if (!chosen || !cwd.trim()) return;
    setBusy(true);
    await model.create({ agent: chosen, cwd: cwd.trim() });
    setBusy(false);
  };
  return (
    <Card padding={3}>
      <VStack gap={2}>
        <Selector label="Agent" value={chosen ?? ""} width="100%" options={s.agents.map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => v && setAgent(v)} />
        <TextInput label="Folder on the server" placeholder="/home/me/code/project" value={cwd} onChange={setCwd} onEnter={() => void start()} />
        <Button variant="primary" onClick={() => void start()} isDisabled={busy || !chosen || !cwd.trim()} data-testid="coding-start" label={busy ? "Starting…" : "Start session"} />
      </VStack>
    </Card>
  );
}

function SwitchAgent({ model, from, cwd }: { model: CodingModel; from: string; cwd: string }) {
  const s = useSyncExternalStore(model.subscribe, model.getState);
  return (
    <Selector label="Switch agent" isLabelHidden placeholder="Switch agent…" value="" width="auto"
      options={s.agents.map((a) => ({ value: a.id, label: `Continue with ${a.name}` }))}
      onChange={(v) => v && void model.create({ agent: v, cwd, handoffFrom: from })} />
  );
}

function History({ model, onOpened }: { model: CodingModel; onOpened: () => void }) {
  const s = useSyncExternalStore(model.subscribe, model.getState);
  const [list, setList] = useState<CliSession[]>();
  const [open, setOpen] = useState<{ session: CliSession; items: TranscriptItem[] }>();
  const [error, setError] = useState<string>();
  useEffect(() => { model.client.history().then(setList, (e: unknown) => setError(codingErrorMessage(e))); }, [model]);
  const groups = useMemo(() => cliSessionsByProject(list ?? []), [list]);
  const show = async (x: CliSession) => {
    try {
      const r = await model.client.historyTranscript(x.tool, x.id);
      setOpen({ session: r.session, items: foldTranscript(r.events).items });
    } catch (e) { setError(codingErrorMessage(e)); }
  };
  const resume = async (x: CliSession) => {
    const agent = s.agents.find((a) => a.id === x.tool);
    if (!agent) { setError(`No ${x.tool} agent is enabled on the server.`); return; }
    const created = await model.create({ agent: agent.id, cwd: x.cwd, resume: x.id });
    if (created) onOpened();
  };
  if (error) return <Banner status="error" title="CLI history" description={error} />;
  if (!list) return <Text type="supporting">Loading…</Text>;
  if (list.length === 0) return <EmptyState title="No CLI conversations" description="Conversations from Claude Code (~/.claude/projects) and Codex (~/.codex/sessions) on the server appear here." isCompact />;
  return (
    <HStack gap={4} vAlign="start" className="coding-split">
      <VStack gap={3} className="coding-side" data-testid="coding-history">
        {groups.map((g) => (
          <VStack key={g.cwd} gap={1}>
            <Text type="supporting" weight="semibold">{g.project}</Text>
            <List aria-label={g.project}>
              {g.sessions.map((x) => (
                <ListItem key={`${x.tool}-${x.id}`} label={x.title} description={`${x.tool === "codex" ? "Codex" : "Claude Code"} · ${new Date(x.updatedAt).toLocaleString()}`}
                  isSelected={open?.session.id === x.id} onClick={() => void show(x)} />
              ))}
            </List>
          </VStack>
        ))}
      </VStack>
      <VStack gap={3} className="coding-main">
        {open ? (
          <>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text weight="semibold">{open.session.title}</Text>
              <Button size="sm" variant="primary" onClick={() => void resume(open.session)} label="Continue in Based" />
            </HStack>
            <CodeBlock code={cliResumeCommand(open.session)} language="bash" hasLanguageLabel={false} />
            <Console items={open.items} running={false} />
          </>
        ) : <EmptyState title="Pick a conversation" description="Read it here, continue it in Based, or copy the command to resume it in a terminal." isCompact />}
      </VStack>
    </HStack>
  );
}

const READY_DOT: Record<AgentStatus["state"], "success" | "warning" | "error" | "neutral"> = { ready: "success", needsLogin: "warning", missing: "error", unknown: "neutral" };

function Setup({ model }: { model: CodingModel }) {
  const [doc, setDoc] = useState<{ tools: DoctorTool[]; agents: AgentStatus[] }>();
  const [error, setError] = useState<string>();
  const [tests, setTests] = useState<Record<string, string>>({});
  const load = () => { model.client.doctor().then(setDoc, (e: unknown) => setError(codingErrorMessage(e))); };
  useEffect(load, [model]);
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "Testing…" }));
    try {
      const r = await model.client.testAgent(id);
      setTests((t) => ({ ...t, [id]: r.message }));
    } catch (e) { setTests((t) => ({ ...t, [id]: codingErrorMessage(e) })); }
  };
  if (error) return <Banner status="error" title="Setup" description={error} />;
  if (!doc) return <Text type="supporting">Checking the server…</Text>;
  return (
    <VStack gap={4} data-testid="coding-setup">
      <VStack gap={2}>
        <HStack hAlign="between" vAlign="center">
          <Text weight="semibold">Agents</Text>
          <Button size="sm" variant="ghost" onClick={load} label="Check again" />
        </HStack>
        <List aria-label="Agents">
          {doc.agents.map((a) => (
            <ListItem key={a.id} label={a.name} description={tests[a.id] ?? a.summary} startContent={<StatusDot variant={READY_DOT[a.state]} label={a.state} />}
              endContent={<Button size="sm" variant="secondary" onClick={() => void test(a.id)} label="Test" />} />
          ))}
        </List>
        {doc.agents.filter((a) => a.fix).map((a) => (
          <VStack key={a.id} gap={1}>
            <Text type="supporting">To fix {a.name}, run on the server:</Text>
            <CodeBlock code={a.fix!} language="bash" hasLanguageLabel={false} />
          </VStack>
        ))}
      </VStack>
      <VStack gap={2}>
        <Text weight="semibold">Tools on the server</Text>
        <List aria-label="Tools">
          {doc.tools.map((t) => (
            <ListItem key={t.id} label={t.name} description={t.path ? `${t.version ?? ""} ${t.path}`.trim() : `Not found – ${t.install}`}
              startContent={<StatusDot variant={t.path ? "success" : t.required ? "error" : "neutral"} label={t.path ? "found" : "missing"} />} />
          ))}
        </List>
      </VStack>
    </VStack>
  );
}
