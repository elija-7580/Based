// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-595: Zustand des Chat-Panels ohne den Chat selbst (bis 19.11.2026 in chat/runtime.ts). Kopfzeile, Befehle und
// Seitenansicht lesen ihn, ohne den Chat-Code (Anbieter, Werkzeuge, Agent Brain) in den Start-Chunk zu ziehen.

const panelListeners = new Set<(open: boolean) => void>();
/** Das Chat-Panel öffnen (ChatDock hört zu). */
export function openChatPanel() {
  for (const fn of panelListeners) fn(true);
}
export function onOpenChatPanel(fn: (open: boolean) => void): () => void {
  panelListeners.add(fn);
  return () => void panelListeners.delete(fn);
}

// BSD-168: Zustand des Panels für den AI-Knopf in der Kopfzeile (aktiv, solange das Panel offen ist; wie Swift
// NotionChrome „Ask AI (⌘J)“). ChatDock meldet jede Änderung, der Knopf liest per useSyncExternalStore.
let panelOpen = false;
const panelStateListeners = new Set<() => void>();
export function setChatPanelOpen(open: boolean) {
  if (panelOpen === open) return;
  panelOpen = open;
  for (const fn of panelStateListeners) fn();
}
export const isChatPanelOpen = (): boolean => panelOpen;
export function subscribeChatPanel(fn: () => void): () => void {
  panelStateListeners.add(fn);
  return () => void panelStateListeners.delete(fn);
}
/** Panel auf/zu wie ⌘J. */
export function toggleChatPanel() {
  const next = !panelOpen;
  for (const fn of panelListeners) fn(next);
}
