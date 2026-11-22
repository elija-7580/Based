// BSD-274: Einstellungen → Sync & server → Backups. Der lokale Server sichert stündlich (nur bei Änderungen) und
// beim Beenden nach ~/Documents/Based Backups (letzte 10, 24 stündlich, 30 täglich, 12 monatlich). Hier: letzter
// Stand, „Back up now“, Wiederherstellen mit Vorschau. Vor dem Wiederherstellen sichert der Server den aktuellen
// Stand – das Wiederherstellen lässt sich so selbst wieder zurücknehmen.
// BSD-648: Ist der Stand beschädigt (abgeschnitten, unlesbare Zeilen), sagt die Rückfrage das zuerst, mit N von M Records.
// BSD-449: Ordner frei wählen („Change folder…“, Tauri-Ordnerdialog), z. B. ein externes Laufwerk. Fehlt der Ordner
// (Laufwerk ab), steht das hier – zurück zum Standardordner geht es nur auf ausdrücklichen Klick, nie still.
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { BasedButton } from "@based/ui/astryx";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { isTauri } from "../desktop.js";
import { relative } from "../shell/format.js";
import { syncConfig } from "../shell/storage.js";
import { localServer, PLACES } from "./localServer.js";
import { damagedBackupText, restoredMessage } from "./backupText.js";

type Info = Awaited<ReturnType<ReturnType<typeof localServer>["backups"]>>;
const pages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;
const pagesParts = (p: { added: number; changed: number; removed: number }) =>
  [`${pages(p.added)} ${p.added === 1 ? "comes" : "come"} back`, `${pages(p.changed)} ${p.changed === 1 ? "changes" : "change"}`, `${pages(p.removed)} ${p.removed === 1 ? "goes" : "go"} away`];
const pagesText = (p: { added: number; changed: number; removed: number }) => pagesParts(p).join(", ");
/** BSD-649: Rückfrage vor dem Wiederherstellen. Ein beschädigter Stand bringt nur den lesbaren Teil zurück, nichts geht weg. */
const restoreAsk = (c: { at: number; pages: { added: number; changed: number; removed: number }; damaged?: { readable: number; expected: number } }) => {
  const when = new Date(c.at).toLocaleString();
  if (c.damaged) return `${damagedBackupText(c.damaged)}Restoring it brings back the readable part from ${when} and removes nothing: ${pagesParts(c.pages).slice(0, 2).join(", ")}. The current state is backed up first.`;
  return `Your workspace becomes the state of ${when}: ${pagesText(c.pages)}. The current state is backed up first.`;
};

export function BackupsGroup() {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [info, setInfo] = useState<Info>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ name: string; at: number; pages: { added: number; changed: number; removed: number }; damaged?: { readable: number; expected: number } }>();
  const running = s.status === "running";
  const load = useCallback(() => { if (running) ls.backups().then(setInfo, (e: unknown) => setMessage(e instanceof Error ? e.message : String(e))); }, [ls, running]);
  useEffect(load, [load]);
  if (!running) return null;
  const syncsHere = syncConfig.get()?.url === s.url;
  const now = async () => {
    setBusy(true); setMessage(undefined);
    try { const r = await ls.backupNow(); setMessage(r.snapshot ? "Backed up." : "Nothing changed since the last backup."); load(); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const ask = async (x: { name: string; at: number }) => {
    try { const p = await ls.backupPreview(x.name); setConfirm({ ...x, pages: p.pages, ...(p.damaged ? { damaged: p.damaged } : {}) }); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const changeFolder = async (dir?: string) => {
    setMessage(undefined);
    try {
      const chosen = dir === undefined ? await ls.pickBackupDir() : dir === "" ? undefined : dir;
      if (dir === undefined && !chosen) return; // abgebrochen
      setBusy(true);
      await ls.setBackupDir(chosen);
      setMessage(chosen ? `Backups now go to ${chosen}.` : `Backups go to Documents/${PLACES.backupFolder} again.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const reveal = async () => {
    if (!info?.dir) return;
    try { const { revealItemInDir } = await import("@tauri-apps/plugin-opener"); await revealItemInDir(info.dir); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const unreachable = info?.reachable === false;
  const restore = async () => {
    if (!confirm) return;
    const c = confirm;
    setConfirm(undefined); setBusy(true);
    try { const r = await ls.backupRestore(c.name); setMessage(restoredMessage(c.at, r.missing?.length)); load(); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Group>
      <Row label="Backups" hint="Every hour (when something changed) and when the app quits. Keeps the last 10, 24 hourly, 30 daily and 12 monthly.">
        <BasedButton label={busy ? "Backing up…" : "Back up now"} disabled={busy} onClick={() => void now()} />
      </Row>
      <Row label="Folder" hint={`${info?.dir ?? s.backupDir ?? `Documents/${PLACES.backupFolder}`} — ${s.backupDir ? "chosen by you. If its drive isn't connected, backups pause until it is." : "the standard folder. You can choose another one, for example on an external drive."}`}>
        <HStack gap={2} wrap="wrap">
          {info?.dir && !unreachable && isTauri() ? <BasedButton label="Show in Finder" variant="ghost" disabled={busy} onClick={() => void reveal()} /> : null}
          {s.backupDir ? <BasedButton label="Use standard folder" variant="ghost" disabled={busy} onClick={() => void changeFolder("")} /> : null}
          <BasedButton label="Change folder…" variant="secondary" disabled={busy} onClick={() => void changeFolder()} />
        </HStack>
      </Row>
      {unreachable ? <Text type="supporting" color="secondary" role="alert" data-testid="backup-unreachable">{info?.error ?? "The backup folder isn't available."} No backups are made until it's back.</Text> : null}
      <Row label="Last backup"><Value testID="backup-last">{info?.last ? relative(new Date(info.last.at)) : info?.snapshots[0] ? relative(new Date(info.snapshots[0].at)) : "None yet"}</Value></Row>
      {!syncsHere ? <Text type="supporting" color="secondary" data-testid="backup-not-synced">Backups contain what the local server holds. Use it for sync (above) so they include this app's pages.</Text> : null}
      {info?.error && !unreachable ? <Text type="supporting" color="secondary" role="alert">The last backup failed: {info.error}</Text> : null}
      {message ? <Text type="supporting" color="secondary" role="status" data-testid="backup-message">{message}</Text> : null}
      {info && info.snapshots.length > 0 ? (
        <VStack gap={1}>
          <List aria-label="Backups" data-testid="backup-list">
            {info.snapshots.slice(0, 12).map((x) => (
              <ListItem key={x.name} label={new Date(x.at).toLocaleString()} description={relative(new Date(x.at))}
                endContent={<BasedButton label="Restore…" variant="ghost" disabled={busy} onClick={() => void ask(x)} />} />
            ))}
          </List>
        </VStack>
      ) : null}
      <AlertDialog isOpen={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(undefined); }} title="Restore this backup?"
        description={confirm ? restoreAsk(confirm) : ""}
        actionLabel="Restore" onAction={() => void restore()} />
    </Group>
  );
}
