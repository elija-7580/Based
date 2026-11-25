// Einstellungen: links ein Suchfeld und die Seiten in den Gruppen App, Workspace und System (Elija 18.11.), rechts
// die Abschnitte der gewählten Seite – aus Astryx-Komponenten im Theme
// „Based Default“. Die Ansicht ist dünn: Seiten und „Coming later“ kommen aus shell/settings.ts, die Abschnitte
// aus der Registry (settings/registry.ts); eingebaute Abschnitte stehen in settings/sections.tsx.
import { Card } from "@astryxdesign/core/Card";
import { Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { BasedButton, BasedField } from "@based/ui/astryx";
import { openOverlay } from "@based/ui/native";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Appearance } from "../appearance.js";
import { Icon } from "../icons.js";
import type { Route } from "../shell/router.js";
import { aiSetting } from "../shell/ai.js";
import { settingsPageVisible } from "../shell/beta.js";
import { devViewPref } from "../shell/storage.js";
import { listedSettingsPages, resolveSettingsPage, searchSettings, SETTINGS_GROUPS, SETTINGS_PAGES, visibleSettingsPages, type SettingsHit } from "../shell/settings.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import { NARROW_WINDOW } from "../components/Sidebar.js";
import { AstryxKit } from "./settings/AstryxKit.js";
import { settingsRegistry } from "./settings/registry.js";
import { registerBuiltinSettings } from "./settings/sections.js";
import "../brain/BrainSettings.js";
import "../chat/ConnectionsSection.js";
import "../desktop/LocalServerSection.js";
import "../desktop/AIAppsSection.js";
import "../desktop/AIRequestsSection.js";
// BSD-595: bis 19.11.2026 in App.tsx (zog den Hauptagenten in den Start-Chunk)
import "../tasks/AgentSettingsSection.js";
import "./settings/settings.css";

registerBuiltinSettings();

export interface SettingsProps {
  /** Gewählte Seite (ID aus SETTINGS_PAGES); fehlt sie, gilt „Appearance“. */
  page?: string | undefined;
  value: Appearance;
  onChange: (a: Appearance) => void;
  client: StoreClient;
  state: ShellState;
  onNavigate: (r: Route) => void;
  /** Einstellungen verlassen: dorthin, wo man vorher war („Back“ über der Liste, Escape, ⌘,). */
  onClose: () => void;
}

const narrowQuery = () => globalThis.matchMedia?.(NARROW_WINDOW);
const isNarrow = () => narrowQuery()?.matches ?? false;
const subscribeNarrow = (f: () => void) => { const m = narrowQuery(); m?.addEventListener("change", f); return () => m?.removeEventListener("change", f); };

export function Settings({ page: pageID, value, onChange, client, state, onNavigate, onClose }: SettingsProps) {
  useSyncExternalStore(settingsRegistry.subscribe, settingsRegistry.getVersion);
  const ai = useSyncExternalStore(aiSetting.subscribe, aiSetting.get);
  const view = { ai };
  const dev = useSyncExternalStore(devViewPref.subscribe, devViewPref.get);
  // Seiten ohne eigenen Abschnitt stehen nur in der Entwickler-Ansicht in der Liste; ein alter Link fällt auf Appearance.
  const pages = listedSettingsPages(visibleSettingsPages(SETTINGS_PAGES, view).filter((p) => settingsPageVisible(p.id)), settingsRegistry, view, dev);
  const kit = pageID === "kit";
  const page = resolveSettingsPage(pageID, pages);
  const sections = settingsRegistry.sectionsFor(page.id, view);
  // Was noch fehlt, steht nur auf Seiten ohne eigene Abschnitte (sonst wäre die Seite leer) – auf Seiten mit echten
  // Einstellungen ist die Liste Entwickler-Wissen (Settings → Diagnostics → For developers), keine Nutzer-Information.
  const allMissing = settingsRegistry.missingFor(page.id, view);
  const missing = sections.length === 0 || dev ? allMissing : [];
  const props = { client, state, appearance: value, setAppearance: onChange, navigate: onNavigate };
  // Schmales Fenster (Handy): Liste und Seite passen nicht nebeneinander – erst die Liste, nach der Wahl die Seite
  // mit einem Weg zurück. Ohne gewählte Seite steht die Liste da.
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const narrowMode = !narrow ? "" : pageID === undefined ? " narrow-nav" : " narrow-page";

  // Suche: ersetzt die Seitenliste durch Treffer (Seiten, Abschnitte, einzelne Einstellungen). ↓/↑ wandern, Enter
  // öffnet, Escape leert. Bewusst nicht in ⌘K – dort stehen Seiten und Befehle, keine Einstellungen.
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const hits = searchSettings(query, pages, settingsRegistry, view);
  const cur = Math.min(active, Math.max(0, hits.length - 1));
  const target = useRef<string | undefined>(undefined);
  const open = (hit: SettingsHit) => {
    target.current = hit.section;
    setQuery("");
    setActive(0);
    onNavigate({ name: "settings", page: hit.page });
  };
  // Nach dem Öffnen eines Treffers zum Abschnitt rollen und ihn fokussieren (Screenreader lesen die Überschrift).
  useEffect(() => {
    const id = target.current;
    if (!id) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="settings-section-${CSS.escape(id)}"]`);
    if (!el) return;
    target.current = undefined;
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  });
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      setActive((cur + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === "Escape") {
      // mit Suchtext: leeren; im leeren Feld: Einstellungen verlassen
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery("");
      else onClose();
    }
  };
  // Escape verlässt die Einstellungen (wie ein Fenster) – nicht aus einem Eingabefeld heraus und nicht, solange ein
  // Menü oder Dialog offen ist (die schließt Escape zuerst).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      if (openOverlay(document, "[role=menu], [role=dialog], [role=listbox]")) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const searching = query.trim() !== "";

  const results = hits.length ? (
    <List density="compact" data-testid="settings-results" header={<Text type="supporting" weight="semibold" color="secondary" className="settings-nav-head">Results</Text>}>
      {hits.map((h, i) => (
        <ListItem
          key={h.page + "/" + (h.section ?? "") + "/" + h.label}
          label={<Text type="body" weight={i === cur ? "semibold" : "medium"}>{h.label}</Text>}
          description={h.where}
          isSelected={i === cur}
          onClick={() => open(h)}
        />
      ))}
    </List>
  ) : (
    <Text type="supporting" color="secondary" display="block" className="settings-no-results" data-testid="settings-no-results">No settings match “{query.trim()}”.</Text>
  );

  const nav = (
    <VStack gap={4}>
      <span className="settings-leave"><BasedButton label="Back" variant="ghost" icon={<Icon name="back" size={16} />} onClick={onClose} /></span>
      <span className="settings-search" data-testid="settings-search">
        <BasedField label="Search settings" labelHidden type="search" placeholder="Search settings" value={query}
          onChange={(v) => { setQuery(v); setActive(0); }} onEnter={() => { if (hits[cur]) open(hits[cur]); }} onKeyDown={onSearchKey} />
      </span>
      {searching ? results : SETTINGS_GROUPS.map((g) => (
        <List key={g.id} density="compact" header={<Text type="supporting" weight="semibold" color="secondary" className="settings-nav-head">{g.title}</Text>}>
          {pages.filter((p) => p.group === g.id).map((p) => (
            <ListItem
              key={p.id}
              label={<Text type="body" weight={!kit && p.id === page.id ? "semibold" : "medium"}>{p.title}</Text>}
              isSelected={!kit && p.id === page.id}
              onClick={() => onNavigate({ name: "settings", page: p.id })}
              {...(settingsRegistry.status(p.id, view) === "unavailable" ? { endContent: <Text type="supporting" color="secondary">Not yet</Text> } : {})}
            />
          ))}
        </List>
      ))}
    </VStack>
  );

  return (
    <Layout
      height="fill"
      className={"settings-screen" + narrowMode}
      start={<LayoutPanel label="Settings pages" role="navigation" width={236} padding={3} className="settings-nav">{nav}</LayoutPanel>}
      content={
        <LayoutContent padding={8} label={kit ? "Design kit" : page.title}>
          {kit ? <AstryxKit /> : (
            <VStack gap={6} className="settings-page" data-testid="settings-page" data-page={page.id}>
              {narrow ? <span className="settings-back"><BasedButton label="Settings" variant="ghost" icon={<Icon name="back" size={16} />} onClick={() => onNavigate({ name: "settings" })} /></span> : null}
              <VStack gap={1}>
                <Heading level={1}>{page.title}</Heading>
                <Text type="supporting" color="secondary" display="block">{page.summary}</Text>
              </VStack>
              {sections.map((s) => (
                <VStack key={s.id} gap={2} data-testid={`settings-section-${s.id}`} tabIndex={-1} className="settings-section">
                  {/* Eine Seite mit nur einem gleichnamigen Abschnitt (Appearance, Updates, About) nennt ihren Namen nicht zweimal. */}
                  {sections.length === 1 && s.title === page.title && !s.description ? null : (
                    <VStack gap={0}>
                      <Heading level={2}>{s.title}</Heading>
                      {s.description ? <Text type="supporting" color="secondary" display="block">{s.description}</Text> : null}
                    </VStack>
                  )}
                  <s.component {...props} />
                </VStack>
              ))}
              {missing.length ? (
                <VStack gap={2} data-testid="settings-missing">
                  <Heading level={2}>Coming later</Heading>
                  <Card variant="transparent" className="settings-missing">
                    <VStack gap={2}>
                      <Text type="supporting" color="secondary" display="block">
                        These settings come in a later version of Based. Nothing here is switched on yet.
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
