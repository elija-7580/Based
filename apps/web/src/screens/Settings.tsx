// Einstellungen: Darstellung (Theme, Stil, Marker, Dichte, Calm, Agent-Details) und Sync-Server (BSD-153). Nur
// Optionen, die wirken.
import { useState } from "react";
import type { Appearance } from "../appearance.js";
import { ImportExportSettings } from "../components/ImportExport.js";
import { SYNC_LABEL } from "../components/Sidebar.js";
import { syncConfig } from "../shell/storage.js";
import type { StoreClient } from "../worker/client.js";
import type { StatusInfo } from "../worker/protocol.js";

type Key = "theme" | "style" | "marker" | "density";
interface Group { key: Key; label: string; hint?: string; options: { value: string; label: string; swatch?: string }[] }

const GROUPS: Group[] = [
  { key: "theme", label: "Theme", options: [{ value: "light", label: "Light", swatch: "light" }, { value: "dark", label: "Dark", swatch: "dark" }] },
  { key: "style", label: "Style", hint: "Default is quiet; Bold adds character", options: [{ value: "default", label: "Default" }, { value: "bold", label: "Bold" }] },
  {
    key: "marker", label: "Marker", hint: "how Based marks its work",
    options: (["butter", "mint", "sky", "rose"] as const).map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1), swatch: m })),
  },
  { key: "density", label: "Density", options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] },
];

export function Settings({ value, onChange, client, status }: { value: Appearance; onChange: (a: Appearance) => void; client: StoreClient; status: StatusInfo }) {
  const toggle = (key: "calm" | "agentDetails", label: string, hint: string) => (
    <div className="setting inline">
      <div className="setting-label" id={`l-${key}`}>{label}</div>
      <div className="switch-row">
        <button type="button" role="switch" className="switch" aria-checked={value[key]} aria-labelledby={`l-${key}`} onClick={() => onChange({ ...value, [key]: !value[key] })}>
          <span className="knob" />
        </button>
        <span className="t-desc">{hint}</span>
      </div>
    </div>
  );
  return (
    <div className="content">
      <div className="settings">
        <div>
          <h1 className="t-title">Appearance</h1>
          <p className="t-desc" style={{ marginTop: "var(--space-1)" }}>Changes apply to the whole app — try them, then click around.</p>
        </div>
        {GROUPS.map((g) => (
          <div key={g.key} className="setting">
            <div>
              <div className="setting-label" id={`l-${g.key}`}>{g.label}</div>
              {g.hint ? <div className="t-desc">{g.hint}</div> : null}
            </div>
            <div role="radiogroup" aria-labelledby={`l-${g.key}`} className="choices">
              {g.options.map((o) => (
                <button key={o.value} type="button" role="radio" className="choice" aria-checked={value[g.key] === o.value} onClick={() => onChange({ ...value, [g.key]: o.value } as Appearance)}>
                  {o.swatch ? <span className={`swatch ${o.swatch}`} aria-hidden="true" /> : null}
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {toggle("calm", "Calm mode", "Agent marks turn grey — on with Focus")}
        {toggle("agentDetails", "Show agent details", "Models, run times and permissions on Home")}
        <SyncSettings client={client} status={status} />
        <ImportExportSettings client={client} />
      </div>
    </div>
  );
}

/** Sync-Server (Sync v2): URL und Token; leer = nur auf diesem Gerät. */
function SyncSettings({ client, status }: { client: StoreClient; status: StatusInfo }) {
  const saved = syncConfig.get();
  const [url, setURL] = useState(saved?.url ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const [connected, setConnected] = useState(!!saved);
  const connect = () => {
    const cfg = { url: url.trim(), token: token.trim() };
    if (!cfg.url) return;
    syncConfig.set(cfg);
    setConnected(true);
    void client.setSync(cfg);
  };
  const disconnect = () => {
    syncConfig.set(undefined);
    setConnected(false);
    void client.setSync(undefined);
  };
  return (
    <>
      <div style={{ marginTop: "var(--space-5)" }}>
        <h2 className="t-heading">Sync server</h2>
        <p className="t-desc" style={{ marginTop: "var(--space-1)" }}>
          {status.persistent ? "Your workspace is saved in this browser." : "This browser can't keep your workspace — changes are lost when you close the tab."}
          {" "}Connect a based-server to use it on your other devices.
        </p>
      </div>
      <form className="setting" onSubmit={(e) => { e.preventDefault(); connect(); }}>
        <div>
          <div className="setting-label">Server</div>
          <div className="t-desc" data-testid="sync-settings-status">{SYNC_LABEL[status.state]}{status.detail && status.state !== "synced" ? ` · ${status.detail}` : ""}</div>
        </div>
        <div className="fields">
          <label className="field">
            <span className="t-meta">Server URL</span>
            <input type="url" inputMode="url" placeholder="https://based.example.com" value={url} disabled={connected} onChange={(e) => setURL(e.target.value)} />
          </label>
          <label className="field">
            <span className="t-meta">Token</span>
            <input type="password" autoComplete="off" value={token} disabled={connected} onChange={(e) => setToken(e.target.value)} />
          </label>
          <div className="choices">
            {connected ? (
              <>
                <button type="button" className="btn" onClick={() => void client.syncNow()}>Sync now</button>
                <button type="button" className="btn ghost" onClick={disconnect}>Disconnect</button>
              </>
            ) : (
              <button type="submit" className="btn primary" disabled={!url.trim()}>Connect</button>
            )}
          </div>
        </div>
      </form>
    </>
  );
}
