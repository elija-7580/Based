// Einstellungen → Agents & AI: Skills (BSD-198/163), Privacy-Redact (BSD-199), Memories (BSD-163). Angemeldet über
// die Registry (registerSettingsSection), Seite „agents“.
import { aiSetting } from "../shell/ai.js";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/Layout";
import { Redactor, REDACT_KIND_LABELS, REDACT_KINDS, type SkillRecord } from "@based/brain";
import { BasedButton } from "@based/ui/astryx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";
import type { BrainStatus } from "../worker/brain.js";
import { BrainClient } from "./client.js";
import { brainSettings } from "./settings.js";
import "./brain.css";

function useBrainStatus(client: BrainClient, revision: unknown): [BrainStatus | undefined, () => void] {
  const [status, setStatus] = useState<BrainStatus>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    void client.status().then((s) => { if (alive) setStatus(s); }, () => undefined);
    return () => { alive = false; };
  }, [client, revision, n]);
  return [status, () => setN((x) => x + 1)];
}

function download(bytes: ArrayBuffer, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SkillsSection({ client: store, state, navigate }: SettingsSectionProps) {
  const client = useRef(new BrainClient(store)).current;
  const settings = useSyncExternalStore(brainSettings().subscribe, brainSettings().getState);
  const [status, reload] = useBrainStatus(client, state.outline);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [message, setMessage] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  // AI-Schalter: automatische Skill-Auswahl und Korrekturen gehören zum Chat; Skills selbst bleiben (MCP liest sie).
  const ai = useSyncExternalStore(aiSetting.subscribe, aiSetting.get);
  useEffect(() => {
    if (status?.exists) void client.skills().then(setSkills, () => undefined);
    else setSkills([]);
  }, [client, status]);

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = await Promise.all([...files].map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
    const r = await client.importSkills(list);
    const names = r.imported.map((i) => i.name);
    setMessage([names.length ? `Imported ${names.join(", ")}.` : "", ...r.errors].filter(Boolean).join(" "));
    reload();
  };

  return (
    <VStack gap={4}>
      <Group>
        {ai ? (
          <Switch
            label="Pick skills automatically"
            description="While you type, Based picks up to two matching skills on this device. Remove or swap them before sending — Based learns from that."
            value={settings.skills.auto}
            onChange={(on) => brainSettings().update((s) => ({ ...s, skills: { auto: on } }))}
            labelPosition="start" labelSpacing="spread" width="100%"
          />
        ) : null}
        <Row label="Import skills" hint="SKILL.md files or ZIPs in the Agent Skills format (as used by Claude Code)">
          <input ref={file} type="file" accept=".md,.zip" multiple hidden data-testid="skill-import-input" onChange={(e) => { void importFiles(e.target.files); e.target.value = ""; }} />
          <BasedButton label="Import…" onClick={() => file.current?.click()} />
        </Row>
        {message ? <Text type="supporting" color="secondary" role="status">{message}</Text> : null}
        {ai ? (
          <Row label="Corrections" hint="Skills you removed or swapped are remembered as examples on this device">
            <BasedButton label="Forget corrections" variant="ghost" onClick={() => { brainSettings().clearCorrections(); setMessage("Corrections forgotten."); }} />
          </Row>
        ) : null}
      </Group>
      <Group>
        {skills.length === 0 ? (
          <Row label="No skills yet" hint="Import a SKILL.md, or add a row to the Skills database in Agent Brain." />
        ) : skills.map((s) => (
          <Switch key={s.id} label={s.name} description={s.description} value={s.enabled} labelPosition="start" labelSpacing="spread" width="100%"
            onChange={(on) => { setSkills(skills.map((x) => (x.id === s.id ? { ...x, enabled: on } : x))); void client.setSkillEnabled(s.id, on); }} />
        ))}
        <Row label="Agent Brain" hint="Skills and memories are databases in your workspace — they sync like every page and can't be deleted.">
          {status?.exists && status.rootID ? <BasedButton label="Open" variant="ghost" onClick={() => navigate({ name: "page", id: status.rootID! })} /> : null}
          {skills.length > 0 ? <BasedButton label="Export all (ZIP)" variant="ghost" onClick={() => void client.exportSkills().then((b) => download(b, "skills.zip"))} /> : null}
        </Row>
      </Group>
    </VStack>
  );
}

function PrivacySection({ client: store }: SettingsSectionProps) {
  const client = useRef(new BrainClient(store)).current;
  const settings = useSyncExternalStore(brainSettings().subscribe, brainSettings().getState);
  const r = settings.redact;
  const [names, setNames] = useState(r.names.join("\n"));
  const [known, setKnown] = useState<string[]>([]);
  const [sample, setSample] = useState("Write to anna.schmidt@example.org, IBAN DE89 3704 0044 0532 0130 00, call +49 30 1234567.");
  useEffect(() => { void client.personNames().then(setKnown, () => undefined); }, [client]);
  const preview = new Redactor({ names: [...known, ...r.names], kinds: new Set(r.kinds) }).redact(sample).text;
  const update = (patch: Partial<typeof r>) => brainSettings().update((s) => ({ ...s, redact: { ...s.redact, ...patch } }));
  return (
    <VStack gap={4}>
      <Group>
        <Switch
          label="Redact sensitive details"
          description="Before anything goes to an AI provider — your message, pages, search results and tool output — Based replaces names, emails, phone numbers, IBANs, card numbers, addresses and keys with placeholders and puts the real values back into the answer. Models on this computer are left alone."
          value={r.enabled} onChange={(on) => update({ enabled: on })} labelPosition="start" labelSpacing="spread" width="100%"
        />
        <Switch
          label="Ask before sending sensitive details"
          description="When your message contains details like these, Based shows what it found and lets you send anyway, redact and send, or use a model on this computer."
          value={r.check === true} onChange={(on) => update({ check: on })} labelPosition="start" labelSpacing="spread" width="100%"
        />
        <Text type="supporting" color="secondary">Detection runs on this device with rules and checksums. It is best effort, not a guarantee. Command-line agents (Claude Code, Codex) send text to their provider themselves — Based can only warn there.</Text>
      </Group>
      <Group>
        <Row label="What to redact" />
        <div className="brain-settings-kinds">
          {REDACT_KINDS.map((k) => (
            <Switch key={k} size="sm" label={REDACT_KIND_LABELS[k]} value={r.kinds.includes(k)} onChange={(on) => update({ kinds: on ? [...r.kinds, k] : r.kinds.filter((x) => x !== k) })} />
          ))}
        </div>
        <TextArea label="Names to redact" description={`One per line. People from your memories are included${known.length ? ` (${known.length})` : ""}.`} value={names} onChange={setNames}
          onBlur={() => update({ names: names.split("\n").map((n) => n.trim()).filter(Boolean) })} />
      </Group>
      <Group>
        <TextArea label="Try it" description="Nothing leaves this device." value={sample} onChange={setSample} />
        <pre className="brain-preview" data-testid="redact-preview">{preview}</pre>
      </Group>
    </VStack>
  );
}

function MemoriesSection({ client: store, state, navigate }: SettingsSectionProps) {
  const client = useRef(new BrainClient(store)).current;
  const settings = useSyncExternalStore(brainSettings().subscribe, brainSettings().getState);
  const [status] = useBrainStatus(client, state.outline);
  const ai = useSyncExternalStore(aiSetting.subscribe, aiSetting.get);
  return (
    <Group>
      {ai ? (
        <Switch
          label="Suggest memories from chats"
          description="After an answer, the chat model proposes up to three facts you stated about yourself. Nothing is saved until you click Save. Costs one short model call per answer."
          value={settings.memories.suggest} onChange={(on) => brainSettings().update((s) => ({ ...s, memories: { suggest: on } }))}
          labelPosition="start" labelSpacing="spread" width="100%"
        />
      ) : null}
      <Row label="Saved memories" hint={ai ? "Agents read them as context; edit or delete rows in the Memories database." : "MCP clients read them as context; edit or delete rows in the Memories database."}>
        <Value testID="memory-count">{status?.memories ?? 0}</Value>
        {status?.exists && status.rootID ? <BasedButton label="Open Agent Brain" variant="ghost" onClick={() => navigate({ name: "page", id: status.rootID! })} /> : null}
      </Row>
    </Group>
  );
}

registerSettingsSection({ id: "brain-skills", page: "agents", title: "Skills", order: 20, component: SkillsSection, provides: ["Skills"] });
registerSettingsSection({ id: "brain-privacy", page: "agents", title: "Privacy", order: 30, ai: true, component: PrivacySection });
registerSettingsSection({ id: "brain-memories", page: "agents", title: "Memories", order: 40, component: MemoriesSection });
