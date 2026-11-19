// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-581: Einstellungen → System → „Connect AI apps“. Ein Dialog, zwei Ziele (Entscheidung Elija 18.11.):
// „This Mac“ (lokaler Server, der Client startet `based mcp`, kein Token in fremden Dateien) und „Server“ (Based Cloud
// oder eigener based-server, je Client ein eigenes widerrufbares Token). Der MCP ist auf beiden derselbe.
// Schnipsel und Regeln stehen in aiApps.ts (getestet).
import { BasedButton, BasedDialog, BasedSwitcher } from "@based/ui/astryx";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Group, Lines, Note, Row, Snippet, Value } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";
import { settingsPageVisible } from "../shell/beta.js";
import { relative } from "../shell/format.js";
import { syncConfig } from "../shell/storage.js";
import { AI_APP_CLIENTS, macSetup, serverSetup, serverTarget, tokenName, whereToPaste, type AIAppClient, type AIAppTarget } from "./aiApps.js";
import { localServer, PLACES } from "./localServer.js";
import { SemanticSearchSetup } from "./SemanticSearchSetup.js";

interface ServerToken { id: string; name: string; createdAt: number; lastSeenAt?: number }

const TARGETS = [{ id: "mac", label: "This Mac" }, { id: "server", label: "Server" }] as const;

async function serverCall<T>(target: { url: string; token: string }, method: "GET" | "POST" | "DELETE", route: string, body?: unknown): Promise<T> {
  const r = await fetch(`${target.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${target.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 403) throw new Error("This server only lets its owner add apps. Sign in with the owner token under Sync & server.");
  if (!r.ok) throw new Error(`The server answered ${r.status}. Check the connection under Sync & server.`);
  return (await r.json()) as T;
}

function copy(text: string): Promise<boolean> {
  return navigator.clipboard?.writeText(text).then(() => true, () => false) ?? Promise.resolve(false);
}

/** Eine Zeile je Client: Name, wo man es einfügt, „Copy setup“; darunter das kopierte Schnipsel. */
function ClientRows({ make, disabled }: { make: (c: AIAppClient) => Promise<string>; disabled: boolean }) {
  const [shown, setShown] = useState<{ client: AIAppClient; text: string; copied: boolean }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<AIAppClient>();
  const run = async (client: AIAppClient) => {
    if (busy) return;
    setError(undefined);
    setBusy(client);
    try {
      const text = await make(client);
      setShown({ client, text, copied: await copy(text) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Lines gap={3} testID="ai-apps-clients">
      {AI_APP_CLIENTS.map((c) => (
        <Lines key={c.id} gap={2}>
          <Row label={c.name} hint={whereToPaste(c.id)}>
            <BasedButton label="Copy setup" ariaLabel={`Copy setup for ${c.name}`} disabled={disabled || busy !== undefined} busy={busy === c.id} onClick={() => void run(c.id)} />
          </Row>
          {shown?.client === c.id ? (
            <Lines gap={1} testID={`ai-apps-setup-${c.id}`}>
              <Snippet>{shown.text}</Snippet>
              <Note>{shown.copied ? `Copied. Paste it into ${c.name}.` : "Select the text above and copy it."}</Note>
            </Lines>
          ) : null}
        </Lines>
      ))}
      {error ? <Note testID="ai-apps-error">{error}</Note> : null}
    </Lines>
  );
}

function localHint(enabled: boolean, status: string, error: string | undefined): string {
  if (!enabled) return "Apps reach Based through a small server on this Mac (127.0.0.1 only). It is off.";
  if (status === "running") return "Running. Apps reach Based on this Mac while the app is open.";
  if (status === "failed") return `Stopped with an error${error ? `: ${error}` : "."}`;
  return "Starting…";
}

function MacTarget() {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  useEffect(() => { void ls.cliStatus(); }, [ls]);
  if (s.status === "unavailable") {
    return <Note testID="ai-apps-mac-unavailable">Open Based on your Mac to connect apps there. The Mac app runs Based for them while it is open.</Note>;
  }
  const command = s.cli.target ?? PLACES.cliName;
  return (
    <Lines gap={4}>
      <Row label="Local server" hint={localHint(s.enabled, s.status, s.error)}>
        {s.enabled
          ? <BasedButton label="Turn off" variant="ghost" onClick={() => void ls.setEnabled(false)} />
          : <BasedButton label="Turn on" onClick={() => void ls.setEnabled(true)} />}
      </Row>
      <Row label="Command line tool" hint={s.cli.installed ? `Apps start \`${PLACES.cliName} mcp\`. Installed at ${s.cli.target ?? ""}.` : `Apps start \`${PLACES.cliName} mcp\`, so no token ends up in their settings. Install the command first.`}>
        {s.cli.installed ? null : <BasedButton label="Install…" disabled={s.cli.busy} onClick={() => void ls.installCli()} />}
      </Row>
      {s.cli.message ? <Note>{s.cli.message}</Note> : null}
      <ClientRows disabled={!s.cli.installed} make={async (c) => macSetup(c, command)} />
    </Lines>
  );
}

function ServerTarget({ onOpenSync }: { onOpenSync: () => void }) {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const target = serverTarget(syncConfig.get(), s.url);
  const [tokens, setTokens] = useState<ServerToken[]>([]);
  const [error, setError] = useState<string>();
  const url = target?.url, token = target?.token;
  const load = useCallback(() => {
    if (!url || !token) return;
    serverCall<{ devices: ServerToken[] }>({ url, token }, "GET", "/devices").then((v) => setTokens(v.devices), () => setTokens([]));
  }, [url, token]);
  useEffect(load, [load]);
  if (!target) {
    return (
      <Lines gap={3}>
        <Note testID="ai-apps-no-server">Connect this workspace to a Based server first. Apps then reach the same pages through it.</Note>
        <Row label="Sync & server"><BasedButton label="Open Sync & server" onClick={onOpenSync} /></Row>
      </Lines>
    );
  }
  const command = s.cli.target ?? PLACES.cliName;
  const make = async (c: AIAppClient) => {
    const r = await serverCall<{ token: string }>(target, "POST", "/devices", { name: tokenName(c, tokens.map((t) => t.name)) });
    load();
    return serverSetup(c, target.url, r.token, command);
  };
  return (
    <Lines gap={4}>
      <Row label="Server"><Value testID="ai-apps-server-url">{target.url}</Value></Row>
      <Note>Each app gets its own token, shown once in the setup you copy. Revoke it here when you stop using the app. With end-to-end encryption, the server only serves areas that are open to agents.</Note>
      <ClientRows disabled={false} make={make} />
      {tokens.length > 0 ? (
        <Lines gap={2} testID="ai-apps-tokens">
          <Note>Apps and devices with their own token</Note>
          {tokens.map((t) => (
            <Row key={t.id} label={t.name} hint={t.lastSeenAt ? `Last used ${relative(new Date(t.lastSeenAt))}` : `Added ${relative(new Date(t.createdAt))}`}>
              <BasedButton label="Revoke" variant="ghost" ariaLabel={`Revoke ${t.name}`} onClick={() => {
                setError(undefined);
                serverCall(target, "DELETE", `/devices/${encodeURIComponent(t.id)}`).then(load, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
              }} />
            </Row>
          ))}
        </Lines>
      ) : null}
      {error ? <Note>{error}</Note> : null}
    </Lines>
  );
}

export function ConnectAIAppsDialog({ open, onClose, onOpenSync }: { open: boolean; onClose: () => void; onOpenSync: () => void }) {
  const [target, setTarget] = useState<AIAppTarget>("mac");
  return (
    <BasedDialog open={open} onClose={onClose} title="Connect AI apps" subtitle="Use Based from Claude Code, Claude Desktop or Cursor." width={640} testID="ai-apps-dialog"
      actions={<BasedButton label="Done" variant="primary" onClick={onClose} />}>
      <BasedSwitcher label="Where Based runs for the app" items={TARGETS} value={target} onChange={(v) => setTarget(v as AIAppTarget)} testID="ai-apps-target" />
      {target === "mac" ? <MacTarget /> : <ServerTarget onOpenSync={onOpenSync} />}
    </BasedDialog>
  );
}

function AIAppsSection({ navigate }: SettingsSectionProps) {
  const [open, setOpen] = useState(false);
  const rules = settingsPageVisible("agents");
  return (
    <Group>
      <Row label="Claude Code, Claude Desktop, Cursor"
        hint={`Connected apps search, read and write your pages and databases through MCP, as you can in Based.${rules ? " Writing follows the permission rules under Agents & AI." : ""}`}>
        <BasedButton label="Connect…" variant="primary" onClick={() => setOpen(true)} />
      </Row>
      <SemanticSearchSetup onOpenSync={() => navigate({ name: "settings", page: "sync" })} />
      {rules ? <Row label="Permission rules"><BasedButton label="Open Agents & AI" variant="ghost" onClick={() => navigate({ name: "settings", page: "agents" })} /></Row> : null}
      {open ? <ConnectAIAppsDialog open onClose={() => setOpen(false)} onOpenSync={() => { setOpen(false); navigate({ name: "settings", page: "sync" }); }} /> : null}
    </Group>
  );
}

registerSettingsSection({ id: "ai-apps", page: "ai-apps", title: "AI apps", order: 10, component: AIAppsSection, keywords: ["MCP", "Claude Code", "Claude Desktop", "Cursor", "Connect AI apps", "based mcp"] });
