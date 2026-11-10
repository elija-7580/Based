// Einstellungen im Notion-Stil (Vorlage: App/Shared/Views/Settings/SettingsView.swift): links die Seiten in den
// Gruppen Account und Workspace, rechts die Abschnitte der gewählten Seite – aus Astryx-Komponenten im Theme
// „Based Default“. Die Ansicht ist dünn: Seiten und „Not available yet“ kommen aus shell/settings.ts, die Abschnitte
// aus der Registry (settings/registry.ts); eingebaute Abschnitte stehen in settings/sections.tsx.
import { Card } from "@astryxdesign/core/Card";
import { Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useSyncExternalStore } from "react";
import type { Appearance } from "../appearance.js";
import type { Route } from "../shell/router.js";
import { resolveSettingsPage, SETTINGS_GROUPS, SETTINGS_PAGES } from "../shell/settings.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import { AstryxKit } from "./settings/AstryxKit.js";
import { settingsRegistry } from "./settings/registry.js";
import { registerBuiltinSettings } from "./settings/sections.js";
import "../brain/BrainSettings.js";
import "./settings/settings.css";

registerBuiltinSettings();

export interface SettingsProps {
  /** Gewählte Seite (ID aus SETTINGS_PAGES); fehlt sie, gilt „My settings“. */
  page?: string | undefined;
  value: Appearance;
  onChange: (a: Appearance) => void;
  client: StoreClient;
  state: ShellState;
  onNavigate: (r: Route) => void;
}

export function Settings({ page: pageID, value, onChange, client, state, onNavigate }: SettingsProps) {
  useSyncExternalStore(settingsRegistry.subscribe, settingsRegistry.getVersion);
  const kit = pageID === "kit";
  const page = resolveSettingsPage(pageID);
  const sections = settingsRegistry.sectionsFor(page.id);
  const missing = settingsRegistry.missingFor(page.id);
  const props = { client, state, appearance: value, setAppearance: onChange, navigate: onNavigate };

  const nav = (
    <VStack gap={4}>
      {SETTINGS_GROUPS.map((g) => (
        <List key={g.id} density="compact" header={<Text type="supporting" weight="semibold" color="secondary" className="settings-nav-head">{g.title}</Text>}>
          {SETTINGS_PAGES.filter((p) => p.group === g.id).map((p) => (
            <ListItem
              key={p.id}
              label={<Text type="body" weight={!kit && p.id === page.id ? "semibold" : "medium"}>{p.title}</Text>}
              isSelected={!kit && p.id === page.id}
              onClick={() => onNavigate({ name: "settings", page: p.id })}
              {...(settingsRegistry.status(p.id) === "unavailable" ? { endContent: <Text type="supporting" color="secondary">Not yet</Text> } : {})}
            />
          ))}
        </List>
      ))}
    </VStack>
  );

  return (
    <Layout
      height="fill"
      className="settings-screen"
      start={<LayoutPanel label="Settings pages" role="navigation" width={236} padding={3} className="settings-nav">{nav}</LayoutPanel>}
      content={
        <LayoutContent padding={8} label={kit ? "Design kit" : page.title}>
          {kit ? <AstryxKit /> : (
            <VStack gap={6} className="settings-page" data-testid="settings-page" data-page={page.id}>
              <VStack gap={1}>
                <Heading level={1}>{page.title}</Heading>
                <Text type="supporting" color="secondary" display="block">{page.summary}</Text>
              </VStack>
              {sections.map((s) => (
                <VStack key={s.id} gap={2} data-testid={`settings-section-${s.id}`}>
                  <VStack gap={0}>
                    <Heading level={2}>{s.title}</Heading>
                    {s.description ? <Text type="supporting" color="secondary" display="block">{s.description}</Text> : null}
                  </VStack>
                  <s.component {...props} />
                </VStack>
              ))}
              {missing.length ? (
                <VStack gap={2} data-testid="settings-missing">
                  <Heading level={2}>Not available yet</Heading>
                  <Card variant="transparent" className="settings-missing">
                    <VStack gap={2}>
                      <Text type="supporting" color="secondary" display="block">
                        The Mac app has these. Based Next doesn't yet — nothing here is switched on or stored.
                      </Text>
                      <List density="compact" listStyle="disc">
                        {missing.map((m) => <ListItem key={m} label={m} />)}
                      </List>
                    </VStack>
                  </Card>
                </VStack>
              ) : null}
            </VStack>
          )}
        </LayoutContent>
      }
    />
  );
}
