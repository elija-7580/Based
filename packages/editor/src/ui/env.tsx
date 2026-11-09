// BSD-154: Was die eigenen Blöcke vom Editor brauchen (Store, Callbacks der Shell), per React-Context.
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { WorkspaceStore } from "@based/core";

export interface DatabaseRenderProps {
  /** Der Block `databaseInline` in der Seite. */
  blockID: string;
  databaseID: string;
  /** Aktive Ansicht (erste aus `props.viewIDs`), leer, wenn keine gesetzt ist. */
  viewID: string;
  viewIDs: readonly string[];
}

export interface EquationRenderProps {
  expression: string;
  /** Block-Gleichung (true) oder im Text (false). */
  displayMode: boolean;
}

export interface Person {
  id: string;
  name: string;
}

export interface EditorEnv {
  store: WorkspaceStore;
  /** Wurzel dieses Editors (Seite oder Synced-Block-Original). */
  rootID: string;
  /** Wurzeln der umgebenden Editoren (gegen Endlos-Verschachtelung von Synced Blocks). */
  ancestors: readonly string[];
  renderDatabase?: ((p: DatabaseRenderProps) => ReactNode) | undefined;
  renderEquation?: ((p: EquationRenderProps) => ReactNode) | undefined;
  onOpenPage?: ((pageID: string) => void) | undefined;
  people?: readonly Person[] | undefined;
  /** Zeigt den Inhalt eines Synced Blocks (ein eingebetteter Editor auf dessen Original). */
  renderSynced: (rootID: string) => ReactNode;
  /** Ausstehende Editor-Änderungen sofort schreiben (z. B. bevor eine neue Unterseite geöffnet wird). */
  flush: () => void;
}

export const EnvContext = createContext<EditorEnv | null>(null);

export function useEnv(): EditorEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error("Based-Block ohne PageEditor");
  return env;
}

/** Neu rendern, wenn sich der Store ändert. */
export function useStoreRevision(store: WorkspaceStore): number {
  return useSyncExternalStore(
    (cb) => store.observe(() => cb()),
    () => store.revision,
  );
}
