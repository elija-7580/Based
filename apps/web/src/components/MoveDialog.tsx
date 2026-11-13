// „Move to…“: Ziel für eine oder mehrere Seiten wählen – Private, ein Teamspace oder eine andere Seite. Aus der
// Seitenleiste (Seitenmenü) und der Library (Bulk-Aktion). Astryx-Dialog mit Suchfeld und Liste; die Ziele kommen aus
// der Seitenleisten-Struktur, verschoben wird im Store-Worker (ein Undo-Schritt).
import { useReturnFocus } from "@based/ui/native";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { PRIVATE_SECTION, type Outline } from "@based/core";
import { useMemo, useState } from "react";
import { Icon } from "../icons.js";
import type { ShellState, StoreClient } from "../worker/client.js";

export type MoveTarget = { kind: "section"; id: string; label: string; icon?: string } | { kind: "page"; id: string; label: string; path: string; icon?: string };

const MAX_PAGES = 40;

/** Seiten, in die `ids` nicht dürfen: sie selbst und alles darunter. */
function blocked(outline: Outline, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const k of outline.children[id] ?? []) walk(k);
  };
  ids.forEach(walk);
  return out;
}

/** Ziele für „Move to…“: Abschnitte zuerst, dann Seiten (keine Datenbanken, nichts unterhalb der bewegten Seiten). */
export function moveTargets(outline: Outline, titles: ReadonlyMap<string, string>, ids: readonly string[], query: string, limit = MAX_PAGES): { sections: MoveTarget[]; pages: MoveTarget[]; more: number } {
  const q = query.trim().toLowerCase();
  const sections: MoveTarget[] = [];
  for (const s of outline.sections) {
    if (q && !s.name.toLowerCase().includes(q)) continue;
    const t: MoveTarget = { kind: "section", id: s.id, label: s.name };
    if (s.icon) t.icon = s.icon;
    sections.push(t);
  }
  const no = blocked(outline, ids);
  const sectionName = new Map(outline.sections.map((s) => [s.id, s.name]));
  const pages: MoveTarget[] = [];
  let more = 0;
  for (const [id, node] of Object.entries(outline.nodes)) {
    if (node.kind !== "page" || no.has(id)) continue;
    const label = titles.get(id) ?? "Untitled";
    if (q && !label.toLowerCase().includes(q)) continue;
    if (pages.length >= limit) { more += 1; continue; }
    const chain: string[] = [];
    for (let p = node.parent, n = 0; p && n < 50; p = outline.nodes[p]?.parent, n++) chain.unshift(titles.get(p) ?? "Untitled");
    const t: MoveTarget = { kind: "page", id, label, path: [sectionName.get(node.section) ?? "Private", ...chain].join(" / ") };
    if (node.icon) t.icon = node.icon;
    pages.push(t);
  }
  pages.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));
  return { sections, pages, more };
}

export function MoveDialog({ client, state, ids, onClose, onMoved }: { client: StoreClient; state: ShellState; ids: readonly string[]; onClose: () => void; onMoved?: (target: MoveTarget) => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  useReturnFocus(); // BSD-304
  const [error, setError] = useState<string | undefined>();
  const outline = state.outline;
  const targets = useMemo(() => (outline ? moveTargets(outline, state.titles, ids, query) : { sections: [], pages: [], more: 0 }), [outline, state.titles, ids, query]);
  const what = ids.length === 1 ? `“${state.titles.get(ids[0]!) ?? "Untitled"}”` : `${ids.length} items`;

  const move = async (t: MoveTarget) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const ok = t.kind === "section"
        ? await client.command<boolean>({ op: "moveToSection", ids: [...ids], section: t.id })
        : await client.command<boolean>({ op: "moveInto", ids: [...ids], parent: t.id });
      if (ok === false) {
        setError("Nothing to move there — a page can't go inside itself.");
        setBusy(false);
        return;
      }
      onMoved?.(t);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const tile = (t: MoveTarget) => (
    <span className="move-tile" aria-hidden="true">
      {t.icon ?? <Icon name={t.kind === "page" ? "page" : t.id === PRIVATE_SECTION ? "lock" : "teamspace"} size={16} />}
    </span>
  );

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} width={480} purpose="info" data-testid="move-dialog">
      <Layout
        header={<DialogHeader title={`Move ${what} to`} onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <TextInput type="search" label="Find a page or teamspace" isLabelHidden placeholder="Find a page or teamspace" value={query} onChange={setQuery} hasAutoFocus hasClear />
              {error ? <p role="alert" className="dialog-error">{error}</p> : null}
              <div className="move-list">
                {targets.sections.length ? (
                  <List density="compact" header={<Text type="label" color="secondary">Sections</Text>}>
                    {targets.sections.map((t) => (
                      <ListItem key={t.id} label={t.label} startContent={tile(t)} isDisabled={busy} onClick={() => void move(t)} />
                    ))}
                  </List>
                ) : null}
                {targets.pages.length ? (
                  <List density="compact" header={<Text type="label" color="secondary">Pages</Text>}>
                    {targets.pages.map((t) => (
                      <ListItem key={t.id} label={t.label} description={t.kind === "page" ? t.path : undefined} startContent={tile(t)} isDisabled={busy} onClick={() => void move(t)} />
                    ))}
                  </List>
                ) : null}
                {targets.more > 0 ? <Text type="supporting" color="secondary">{targets.more} more — type to narrow down.</Text> : null}
                {targets.sections.length + targets.pages.length === 0 ? <Text type="body" color="secondary">No matching destination.</Text> : null}
              </div>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
