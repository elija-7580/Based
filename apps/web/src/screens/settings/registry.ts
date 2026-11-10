// Die Registry der Einstellungs-Abschnitte für die Web-Shell. Andere Bereiche (AI, Agenten, MCP …) melden hier
// ihren Abschnitt an und müssen Settings.tsx nicht anfassen:
//
//   import { registerSettingsSection } from "../screens/settings/registry.js";
//   registerSettingsSection({ id: "ai-keys", page: "agents", title: "API keys", component: AIKeysSection,
//     provides: ["API keys for AI providers"] });
//
// `page` ist eine ID aus shell/settings.ts (SETTINGS_PAGES); `provides` nimmt Einträge aus „Not available yet“.
import type { ComponentType } from "react";
import type { Appearance } from "../../appearance.js";
import type { Route } from "../../shell/router.js";
import { SettingsRegistry, type SettingsSection } from "../../shell/settings.js";
import type { ShellState, StoreClient } from "../../worker/client.js";

/** Was jeder Abschnitt bekommt. */
export interface SettingsSectionProps {
  client: StoreClient;
  state: ShellState;
  appearance: Appearance;
  setAppearance: (a: Appearance) => void;
  navigate: (r: Route) => void;
}

export type SettingsSectionComponent = ComponentType<SettingsSectionProps>;

export const settingsRegistry = new SettingsRegistry<SettingsSectionComponent>();

/** Abschnitt anmelden; die Rückgabe meldet ihn wieder ab. */
export const registerSettingsSection = (section: SettingsSection<SettingsSectionComponent>): (() => void) => settingsRegistry.register(section);
