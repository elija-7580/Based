// BSD-222: Einstellungen → Connections: MCP-Server aus dem Katalog oder eigene (Streamable HTTP), Token verschlüsselt
// in diesem Browser, an/aus, „Auch für Agenten“, Verbindung testen. Die Werkzeuge erscheinen im Chat als
// `mcp__<name>__<werkzeug>` und laufen mit der Freigabe-Einstellung (schreibende fragen bei „Ask before edits“).
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { catalogUsable, connectionFromCatalog, MCP_CATALOG, validateConnection, type Connection } from "@based/brain";
import { BasedButton } from "@based/ui/astryx";
import { useState, useSyncExternalStore } from "react";
import { Group, Row } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";
import { mcpRuntime, type ConnectionStatus } from "./mcp.js";

function statusText(s: ConnectionStatus | undefined): string {
  switch (s?.status) {
    case "ready": return `Connected · ${s.tools} ${s.tools === 1 ? "tool" : "tools"}`;
    case "connecting": return "Connecting…";
    case "failed": return `Not connected: ${s.error ?? "unknown error"}`;
    case "disabled": return "Off";
    case "unsupported": return s.error ?? "Not available here";
    default: return "";
  }
}

function ConnectionRow({ c, status, client, onError }: { c: Connection; status: ConnectionStatus | undefined; client: SettingsSectionProps["client"]; onError: (m: string) => void }) {
  const rt = mcpRuntime(client);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    void f().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  return (
    <VStack gap={2} data-testid="mcp-connection" data-name={c.name}>
      <Row label={c.name} hint={c.data.url ?? c.data.command}>
        <HStack gap={2} vAlign="center">
          <BasedButton label="Test" variant="ghost" disabled={busy || !c.data.enabled} onClick={() => run(() => rt.test(c.id))} />
          <BasedButton label="Remove" variant="ghost" disabled={busy} onClick={() => run(() => rt.remove(c.id))} />
        </HStack>
      </Row>
      <Text type="supporting" color="secondary" data-testid="mcp-status">{statusText(status)}</Text>
      <Switch label="On" value={c.data.enabled} onChange={(on) => run(() => rt.update(c.id, { enabled: on }))} labelPosition="start" labelSpacing="spread" width="100%" />
      <Switch
        label="Also for agents"
        description="The main agent and scheduled agents may use these tools too (a project or agent can narrow it down)."
        value={c.data.exposeToAgents}
        onChange={(on) => run(() => rt.update(c.id, { exposeToAgents: on }))}
        labelPosition="start" labelSpacing="spread" width="100%"
      />
      {c.data.transport === "http" ? (
        <form onSubmit={(e) => { e.preventDefault(); if (token.trim()) run(async () => { await rt.update(c.id, {}, token); setToken(""); }); }}>
          <HStack gap={2} vAlign="end">
            <TextInput type="password" label="Token" value={token} onChange={setToken} autoComplete="off"
              placeholder={c.data.secretRef ? "Saved — enter a new token to replace it" : "Optional"} />
            <BasedButton type="submit" label="Save token" disabled={busy || !token.trim()} />
          </HStack>
        </form>
      ) : null}
    </VStack>
  );
}

function ConnectionsSection({ client }: SettingsSectionProps) {
  const rt = mcpRuntime(client);
  const state = useSyncExternalStore(rt.subscribe, rt.getState);
  const [name, setName] = useState("");
  const [url, setURL] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string>();
  const usable = MCP_CATALOG.filter((e) => catalogUsable(e, { stdio: false }));
  const later = MCP_CATALOG.filter((e) => !catalogUsable(e, { stdio: false }));
  const problem = name || url ? validateConnection({ name, transport: "http", url }) : undefined;

  const addCustom = async () => {
    try {
      await rt.add({ name: name.trim(), transport: "http", url: url.trim() }, token);
      setName(""); setURL(""); setToken("");
      setMessage(`Added ${name.trim()}.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <VStack gap={4}>
      <Group>
        <Text type="supporting" color="secondary">
          Connect MCP servers so Based can use their tools in the chat and for agents. Tokens are stored encrypted in this browser and only sent to that server. Tools that change something ask first unless you let Based work freely.
        </Text>
        {state.connections.length === 0 ? <Row label="No connections yet" hint="Add one from the list below or your own server." /> : null}
        {state.connections.map((c) => <ConnectionRow key={c.id} c={c} client={client} status={state.status[c.id]} onError={setMessage} />)}
        {message ? <Text type="supporting" color="secondary" role="status" data-testid="mcp-message">{message}</Text> : null}
      </Group>
      <Group>
        <Row label="Add a known server" hint={later.length ? `Sign-in for ${later.map((e) => e.name).join(", ")} comes later — you can add them as your own server with a token.` : undefined}>
          <HStack gap={2} wrap="wrap">
            {usable.map((e) => (
              <BasedButton key={e.id} label={e.name} variant="ghost" onClick={() => void rt.add(connectionFromCatalog(e)).then(() => setMessage(`Added ${e.name} — paste a token to connect.`), (err: unknown) => setMessage(String(err)))} />
            ))}
          </HStack>
        </Row>
      </Group>
      <Group>
        <form onSubmit={(e) => { e.preventDefault(); if (!problem && name.trim() && url.trim()) void addCustom(); }}>
          <VStack gap={3}>
            <Text type="label" weight="semibold">Your own server</Text>
            <TextInput label="Name" value={name} onChange={setName} placeholder="e.g. Tracker" />
            <TextInput type="url" label="URL" value={url} onChange={setURL} placeholder="https://…/mcp" description={problem && url ? problem : "Streamable HTTP endpoint"} />
            <TextInput type="password" label="Token" value={token} onChange={setToken} autoComplete="off" placeholder="Optional" description="Sent as Authorization: Bearer …" />
            <HStack gap={2}>
              <BasedButton type="submit" variant="primary" label="Add server" disabled={!name.trim() || !url.trim() || Boolean(problem)} />
            </HStack>
          </VStack>
        </form>
      </Group>
    </VStack>
  );
}

registerSettingsSection({ id: "mcp-connections", page: "connections", title: "MCP servers", order: 10, component: ConnectionsSection, provides: ["MCP connections"] });
