// BSD-160: Einstellungen des Hauptagenten auf der Seite „Agents & AI“ – Planer-Modell, Budget (€ pro Monat, Grenze
// pro Auftrag ohne Rückfrage, Kurs USD→€), Berechtigungen (Modus + Regeln wie Claude Code), gelernte Korrekturen,
// Projekte und Zeitpläne. Gespeichert als Record im Workspace (synct), nicht im Browser.
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { budgetLevel, formatEUR, formatFire, parseLayer, toMs, type AgentData, type PermissionMode, type ProjectStatus } from "@based/brain";
import { useEffect, useState, useSyncExternalStore } from "react";
import { aiConfig } from "../chat/aiConfig.js";
import { PERMISSIONS } from "../chat/AiSettingsSection.js";
import { Group, Row } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";

const SAME = "same";

export function AgentSettingsSection({ client, state }: SettingsSectionProps) {
  const snap = state.agents;
  const config = aiConfig();
  const ai = useSyncExternalStore(config.subscribe, config.getState);
  const main = snap?.main;
  const [rules, setRules] = useState("");
  const [budget, setBudget] = useState<number | null>(null);
  const [perTask, setPerTask] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [newProject, setNewProject] = useState("");
  const [status, setStatus] = useState<string>();
  const [loadedFor, setLoadedFor] = useState<AgentData | undefined>();

  useEffect(() => {
    if (state.ready && !snap) void client.agentSnapshot().catch(() => undefined);
  }, [state.ready, snap, client]);
  // Formular einmal aus dem gespeicherten Stand füllen (spätere Sync-Änderungen überschreiben keine Eingabe)
  useEffect(() => {
    if (!main || loadedFor) return;
    setLoadedFor(main);
    setRules(main.permissions.rules);
    setBudget(main.monthlyBudgetEUR ?? null);
    setPerTask(main.perTaskEUR ?? null);
    setRate(main.eurPerUSD ?? null);
  }, [main, loadedFor]);

  if (!snap || !main) return <Text type="supporting" color="secondary">Loading…</Text>;
  void ai;
  const save = (patch: Record<string, unknown>, clear: string[] = []) => client.agents({ op: "saveMain", patch, clear: clear as (keyof AgentData)[] }).then(() => setStatus("Saved"), (e: unknown) => setStatus(String(e)));
  const parsed = parseLayer(rules);
  const models = config.models().filter((m) => m.usable);
  const level = budgetLevel(snap.spentEUR, main.monthlyBudgetEUR);
  const examples = (main as { examples?: unknown[] }).examples?.length ?? 0;

  return (
    <VStack gap={4} data-testid="agent-settings">
      <Group>
        <Row label="Planner model" hint="A small, cheap model is enough: it only turns your input into a plan.">
          <Selector label="Planner model" isLabelHidden width={240} value={main.model ?? SAME}
            options={[{ value: SAME, label: "Same as chat" }, ...models.map((m) => ({ value: m.ref, label: m.ref }))]}
            onChange={(v) => void (v === SAME ? save({}, ["model"]) : save({ model: v }))} />
        </Row>
        <Row label="What the main agent may do alone" hint={PERMISSIONS.find((p) => p.mode === main.permissions.mode)?.desc}>
          <SegmentedControl label="What the main agent may do alone" size="sm" value={main.permissions.mode} onChange={(v) => void save({ mode: v as PermissionMode })}>
            {PERMISSIONS.map((p) => <SegmentedControlItem key={p.mode} value={p.mode} label={p.name} />)}
          </SegmentedControl>
        </Row>
        <TextArea label="Rules" width="100%" rows={4} value={rules} onChange={setRules}
          placeholder={"allow based.create_page\nask based.spawn_agent\ndeny based.*(path:Private/**)"}
          description={parsed.errors.length > 0 ? `Can't read: ${parsed.errors.join(" · ")}` : "One rule per line: allow, ask or deny, then a tool like based.spawn_agent (based.* for all), optionally with (pattern). (path:Projects/**) matches pages by their place: titles from the top, ** for any depth, Private/ or a teamspace name in front. Deny wins over ask, ask over allow. The rules apply to the chat too."} />
      </Group>

      <Group>
        <Row label="This month" hint={level === "exhausted" ? "Budget used up: new agents and scheduled runs need your OK." : level === "warning" ? "Over 80 % of the budget." : "API costs of the main agent and its sub-agents."}>
          <Text type="code" color="secondary" data-testid="agent-spent">{`${formatEUR(snap.spentEUR)}${main.monthlyBudgetEUR !== undefined ? ` of ${formatEUR(main.monthlyBudgetEUR)}` : ""}`}</Text>
        </Row>
        <HStack gap={3} wrap="wrap">
          <NumberInput label="Monthly budget" units="€" width={160} value={budget} hasClear onChange={setBudget} min={0} step={1} placeholder="No limit" />
          <NumberInput label="Without asking, per task" units="€" width={180} value={perTask} hasClear onChange={setPerTask} min={0} step={0.1} placeholder="No limit" />
          <NumberInput label="€ per US dollar" width={140} value={rate} hasClear onChange={setRate} min={0} step={0.01} placeholder="0.92" />
        </HStack>
        <Text type="supporting" color="secondary">Providers bill in dollars; Based converts with this rate. Subscriptions used through a CLI are not counted in euros.</Text>
      </Group>

      <HStack gap={3} vAlign="center">
        <Button variant="primary" label="Save" isDisabled={parsed.errors.length > 0} onClick={() => {
          const patch: Record<string, unknown> = { rules };
          const clear: string[] = [];
          if (budget === null) clear.push("monthlyBudgetEUR"); else patch.monthlyBudgetEUR = budget;
          if (perTask === null) clear.push("perTaskEUR"); else patch.perTaskEUR = perTask;
          if (rate === null) clear.push("eurPerUSD"); else patch.eurPerUSD = rate;
          void save(patch, clear);
        }} />
        {examples > 0 ? <Button variant="ghost" label={`Forget ${examples} learned correction${examples === 1 ? "" : "s"}`} onClick={() => void client.agents({ op: "clearExamples" })} /> : null}
        {status ? <Text type="supporting" color="secondary" role="status" data-testid="agent-settings-status">{status}</Text> : null}
      </HStack>

      <Group>
        <Text type="label">Projects</Text>
        {snap.projects.length === 0 ? <Text type="supporting" color="secondary">No projects yet. The main agent creates one when you file something into a new project.</Text> : null}
        {snap.projects.map((p) => (
          <Row key={p.id} label={p.name} hint={p.data.goal}>
            <SegmentedControl label={`Status of ${p.name}`} size="sm" value={p.data.status} onChange={(v) => void client.agents({ op: "updateProject", id: p.id, patch: { status: v as ProjectStatus } })}>
              <SegmentedControlItem value="active" label="Active" />
              <SegmentedControlItem value="paused" label="Paused" />
              <SegmentedControlItem value="done" label="Done" />
            </SegmentedControl>
          </Row>
        ))}
        <form onSubmit={(e) => { e.preventDefault(); if (newProject.trim()) void client.agents({ op: "createProject", name: newProject.trim() }).then(() => setNewProject("")); }}>
          <HStack gap={2} vAlign="end">
            <TextInput label="New project" value={newProject} onChange={setNewProject} placeholder="Name" width={240} />
            <Button type="submit" variant="secondary" label="Add" isDisabled={!newProject.trim()} />
          </HStack>
        </form>
      </Group>

      <Group>
        <Text type="label">Schedules</Text>
        <Text type="supporting" color="secondary">Scheduled runs start while Based is open in this browser or app.</Text>
        {snap.schedules.length === 0 ? <Text type="supporting" color="secondary">None yet — ask the main agent, e.g. “daily brief every morning at 6:30”.</Text> : null}
        {snap.schedules.map((s) => (
          <Row key={s.id} label={s.name} hint={`${s.data.when}${s.data.nextAt !== undefined ? ` · next ${formatFire(toMs(s.data.nextAt), Date.now())}` : " · no next time"}`}>
            <HStack gap={2} vAlign="center">
              <Switch label="On" isLabelHidden value={s.data.enabled} onChange={(on) => void client.agents({ op: "updateSchedule", id: s.id, patch: { enabled: on } })} />
              <Button variant="ghost" size="sm" label="Delete" onClick={() => void client.agents({ op: "deleteSchedule", id: s.id })} />
            </HStack>
          </Row>
        ))}
      </Group>
    </VStack>
  );
}

let registered = false;
/** Abschnitt einmal anmelden (Import aus App.tsx). */
export function registerAgentSettings() {
  if (registered) return;
  registered = true;
  registerSettingsSection({ id: "main-agent", page: "agents", title: "Main agent", order: 20, component: AgentSettingsSection, provides: ["Agents and the main agent"] });
}
registerAgentSettings();
