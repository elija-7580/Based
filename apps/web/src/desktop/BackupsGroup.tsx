// BSD-274: Einstellungen → Sync & server → Backups. Der lokale Server sichert stündlich (nur bei Änderungen) und
// beim Beenden nach ~/Documents/Based Backups (letzte 10, 24 stündlich, 30 täglich, 12 monatlich). Hier: letzter
// Stand, „Back up now“, Wiederherstellen mit Vorschau. Vor dem Wiederherstellen sichert der Server den aktuellen
// Stand – das Wiederherstellen lässt sich so selbst wieder zurücknehmen.
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Layout";
import { BasedButton } from "@based/ui/astryx";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { relative } from "../shell/format.js";
import { syncConfig } from "../shell/storage.js";
import { localServer } from "./localServer.js";

type Info = Awaited<ReturnType<ReturnType<typeof localServer>["backups"]>>;
const pages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;
const pagesText = (p: { added: number; changed: number; removed: number }) =>
  [`${pages(p.added)} ${p.added === 1 ? "comes" : "come"} back`, `${pages(p.changed)} ${p.changed === 1 ? "changes" : "change"}`, `${pages(p.removed)} ${p.removed === 1 ? "goes" : "go"} away`].join(", ");

export function BackupsGroup() {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [info, setInfo] = useState<Info>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ name: string; at: number; pages: { added: number; changed: number; removed: number } }>();
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
    try { setConfirm({ ...x, pages: (await ls.backupPreview(x.name)).pages }); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const restore = async () => {
    if (!confirm) return;
    const c = confirm;
    setConfirm(undefined); setBusy(true);
    try { await ls.backupRestore(c.name); setMessage(`Restored the backup from ${new Date(c.at).toLocaleString()}. The state before was backed up first – restore that one to undo.`); load(); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Group>
      <Row label="Backups" hint={`Every hour (when something changed) and when the app quits, into ${info?.dir ?? "Documents/Based Backups"}. Keeps the last 10, 24 hourly, 30 daily and 12 monthly.`}>
        <BasedButton label={busy ? "Backing up…" : "Back up now"} disabled={busy} onClick={() => void now()} />
      </Row>
      <Row label="Last backup"><Value testID="backup-last">{info?.last ? relative(new Date(info.last.at)) : info?.snapshots[0] ? relative(new Date(info.snapshots[0].at)) : "None yet"}</Value></Row>
      {!syncsHere ? <Text type="supporting" color="secondary" data-testid="backup-not-synced">Backups contain what the local server holds. Use it for sync (above) so they include this app's pages.</Text> : null}
      {info?.error ? <Text type="supporting" color="secondary" role="alert">The last backup failed: {info.error}</Text> : null}
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
        description={confirm ? `Your workspace becomes the state of ${new Date(confirm.at).toLocaleString()}: ${pagesText(confirm.pages)}. The current state is backed up first.` : ""}
        actionLabel="Restore" onAction={() => void restore()} />
    </Group>
  );
}
