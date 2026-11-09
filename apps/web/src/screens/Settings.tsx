// Einstellungen → Darstellung: Theme, Stil, Marker, Dichte, Calm, Agent-Details.
import type { Appearance } from "../appearance.js";

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

export function Settings({ value, onChange }: { value: Appearance; onChange: (a: Appearance) => void }) {
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
      </div>
    </div>
  );
}
