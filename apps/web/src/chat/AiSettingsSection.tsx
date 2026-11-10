// BSD-159: Einstellungen für die KI (BYOK) – Anbieter, Schlüssel, Modelle, Freigaben. Als eigene Sektion, damit
// Settings.tsx sie mit einer Zeile einbinden kann (`<AiSettingsSection />`); der Chat zeigt sie auch selbst.
// Schlüssel gehen nur in die verschlüsselte Ablage (shell/secrets.ts) und werden nie wieder angezeigt. Hier wird
// nichts ins Netz geschickt.
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { PermissionMode } from "@based/brain";
import { useState, useSyncExternalStore } from "react";
import { aiConfig, parseModelList, PROVIDERS, providerInfo, type AiConfig, type ProviderKind } from "./aiConfig.js";
import "./chat.css";

export const PERMISSIONS: { mode: PermissionMode; name: string; desc: string }[] = [
  { mode: "ask", name: "Ask every time", desc: "Confirm each action, also searching and reading" },
  { mode: "askEdits", name: "Ask before edits", desc: "Reads freely, asks before writing" },
  { mode: "free", name: "Work freely", desc: "Edits without asking — every change is one undo step" },
];

export function AiSettingsSection({ config = aiConfig(), compact = false }: { config?: AiConfig; compact?: boolean }) {
  const state = useSyncExternalStore(config.subscribe, config.getState);
  const [kind, setKind] = useState<ProviderKind>(() => config.activeModel()?.kind ?? "anthropic");
  const info = providerInfo(kind);
  const p = state.settings.providers[kind];
  const [key, setKey] = useState("");
  const [models, setModels] = useState(p.models.join(", "));
  const [baseURL, setBaseURL] = useState(p.baseURL);
  const [saved, setSaved] = useState<string | undefined>();

  const pick = (k: ProviderKind) => {
    setKind(k);
    setKey("");
    setModels(state.settings.providers[k].models.join(", "));
    setBaseURL(state.settings.providers[k].baseURL);
    setSaved(undefined);
  };

  const save = async () => {
    config.setProvider(kind, { models: parseModelList(models), baseURL: baseURL.trim() });
    if (key.trim()) await config.setKey(kind, key);
    setKey("");
    const list = parseModelList(models);
    if (list.length > 0 && !config.models().some((m) => m.ref === state.settings.model && m.usable)) config.setModel(`${kind}/${list[0]}`);
    setSaved("Saved");
  };

  const hasKey = state.hasKey[kind];
  const needsKey = info.needsKey && !hasKey && !key.trim();
  return (
    <section className={"ai-settings" + (compact ? " compact" : "")} aria-labelledby="ai-settings-title" data-testid="ai-settings">
      <div>
        <h2 className="t-heading" id="ai-settings-title">AI models</h2>
        <p className="t-desc">
          Use your own API key or a model on this computer. Keys are stored encrypted in this browser and only sent to the provider you choose — when you send a message.
        </p>
      </div>
      <SegmentedControl label="Provider" value={kind} onChange={(v) => pick(v as ProviderKind)} layout={compact ? "fill" : "hug"} size="sm">
        {PROVIDERS.map((x) => <SegmentedControlItem key={x.kind} value={x.kind} label={x.kind === "compatible" ? "Other" : x.name} />)}
      </SegmentedControl>
      <p className="t-desc">{info.hint}{kind === "ollama" ? " Ollama must allow this app's address (OLLAMA_ORIGINS)." : ""}</p>
      <form className="fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {info.needsKey || info.optionalKey ? (
          <TextInput
            type="password"
            label="API key"
            value={key}
            onChange={setKey}
            autoComplete="off"
            placeholder={hasKey ? "Saved — enter a new key to replace it" : info.optionalKey ? "Optional" : "Paste your key"}
            description={hasKey ? "A key is saved for this provider." : undefined}
          />
        ) : null}
        <TextInput type="url" label="Server" value={baseURL} onChange={setBaseURL} placeholder="https://…" />
        <TextArea label="Models" value={models} onChange={setModels} placeholder={info.modelsPlaceholder} description="The first one is used unless you pick another in the chat." />
        <div className="ai-actions">
          <Button type="submit" variant="primary" label="Save" isDisabled={needsKey || !baseURL.trim() || parseModelList(models).length === 0} />
          {hasKey ? <Button variant="ghost" label="Remove key" onClick={() => void config.setKey(kind, undefined).then(() => setSaved("Key removed"))} /> : null}
          {saved ? <span className="t-meta" role="status">{saved}</span> : null}
        </div>
      </form>
      <div className="fields">
        <span className="setting-label" id="ai-permission">What Based may do alone</span>
        <SegmentedControl label="What Based may do alone" value={state.settings.permission} onChange={(v) => config.setPermission(v as PermissionMode)} size="sm" layout={compact ? "fill" : "hug"}>
          {PERMISSIONS.map((x) => <SegmentedControlItem key={x.mode} value={x.mode} label={x.name} />)}
        </SegmentedControl>
        <p className="t-desc">{PERMISSIONS.find((x) => x.mode === state.settings.permission)?.desc}</p>
      </div>
    </section>
  );
}
