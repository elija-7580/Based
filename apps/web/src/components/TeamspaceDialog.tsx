// Teamspace anlegen oder bearbeiten (Name, Icon) und löschen. Astryx-Dialoge; geschrieben wird im Store-Worker in das
// Workspace-Record (`teamspaces: [{id, name, icon?, createdAt}]`, wie die Swift-App).
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { BasedButton, BasedDialog, BasedField } from "@based/ui/astryx";
import { useState } from "react";
import { Icon } from "../icons.js";
import type { StoreClient } from "../worker/client.js";

/** Auswahl für das Icon (Emoji wie bei Seiten); „None“ zeigt das Standard-Symbol. */
export const TEAMSPACE_ICONS = ["🏠", "🎨", "🧪", "📚", "💼", "🛠️", "📣", "🌱", "🚀", "💡", "🗂️", "🎓"] as const;

export interface TeamspaceEdit {
  /** Fehlt: neuer Teamspace. */
  id?: string;
  name: string;
  icon?: string;
}

export function TeamspaceDialog({ client, teamspace, onClose, onSaved }: { client: StoreClient; teamspace: TeamspaceEdit; onClose: () => void; onSaved?: (id: string) => void }) {
  const [name, setName] = useState(teamspace.name);
  const [icon, setIcon] = useState<string | undefined>(teamspace.icon);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const isNew = teamspace.id === undefined;
  const trimmed = name.trim();

  const save = async () => {
    if (busy || trimmed === "") return;
    setBusy(true);
    try {
      let id = teamspace.id;
      if (id === undefined) {
        id = await client.command<string>({ op: "createTeamspace", name: trimmed, ...(icon ? { icon } : {}) });
      } else {
        if (trimmed !== teamspace.name) await client.command({ op: "renameTeamspace", id, name: trimmed });
        if (icon !== teamspace.icon) await client.command({ op: "setTeamspaceIcon", id, ...(icon ? { icon } : {}) });
      }
      onSaved?.(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    // BSD-352: Hülle, Name und Knöpfe aus @based/ui/astryx; „busy“ nur am Knopf, damit der Dialog beim Speichern
    // nicht seine Art wechselt.
    <BasedDialog open onClose={onClose} title={isNew ? "New teamspace" : "Edit teamspace"} subtitle="A teamspace groups pages in the sidebar." form testID="teamspace-dialog"
      actions={<>
        <BasedButton label="Cancel" variant="ghost" onClick={onClose} />
        <BasedButton label={isNew ? "Create teamspace" : "Save"} variant="primary" disabled={trimmed === ""} busy={busy} onClick={() => void save()} />
      </>}>
      <BasedField label="Name" placeholder="Design, Research, Family…" value={name} onChange={setName} onEnter={() => void save()} autoFocus required />
      <VStack gap={2}>
        <Text type="label">Icon</Text>
        <HStack gap={1} wrap="wrap" role="group" aria-label="Icon">
          <ToggleButton label="No icon" isIconOnly icon={<Icon name="teamspace" size={16} />} isPressed={icon === undefined} onPressedChange={() => setIcon(undefined)} />
          {TEAMSPACE_ICONS.map((e) => (
            <ToggleButton key={e} label={`Icon ${e}`} isPressed={icon === e} onPressedChange={() => setIcon(e)}>{e}</ToggleButton>
          ))}
        </HStack>
      </VStack>
      {error ? <p role="alert" className="dialog-error">{error}</p> : null}
    </BasedDialog>
  );
}

/** Löschen bestätigen: die Seiten bleiben und wandern nach Private. */
export function DeleteTeamspaceDialog({ client, id, name, pages, onClose }: { client: StoreClient; id: string; name: string; pages: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog
      isOpen
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`Delete teamspace “${name}”?`}
      description={pages > 0 ? `Its ${pages === 1 ? "page moves" : `${pages} pages move`} to Private. Nothing is deleted, and you can undo this.` : "It has no pages. You can undo this."}
      actionLabel="Delete teamspace"
      isActionLoading={busy}
      onAction={() => {
        setBusy(true);
        void client.command({ op: "deleteTeamspace", id }).finally(onClose);
      }}
    />
  );
}
