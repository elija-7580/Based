// Share-Panel am Seitenkopf (docs/sharing.md, BSD-219): veröffentlichen, Link kopieren, Links mit Rolle anlegen,
// widerrufen, Rollen von Personen ändern. Teilen läuft über den verbundenen Sync-Server; ohne Server ein ehrlicher
// Hinweis. Logik und HTTP in @based/sync (ShareAPI), hier nur die Ansicht (Astryx).
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { LINK_ROLES, SHARE_ROLE_LABEL, ShareAPI, publishedLink, shareErrorMessage, shareURL, type PageAccess, type ShareLinkInfo, type ShareRole } from "@based/sync";
import { BasedButton, BasedDialog, BasedMenu } from "@based/ui/astryx";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Route } from "../shell/router.js";
import { syncConfig } from "../shell/storage.js";
import "./share.css";

interface Props {
  pageID: string;
  title: string;
  onNavigate: (r: Route) => void;
}

/** Knopf „Share“ in der Kopfzeile und das Panel dazu. */
export function ShareButton({ pageID, title, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <BasedButton label="Share" variant="ghost" size="sm" onClick={() => setOpen(true)} />
      {open ? <SharePanel pageID={pageID} title={title} onNavigate={onNavigate} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const KIND_LABEL: Record<ShareLinkInfo["kind"], string> = { access: "Anyone with the link", invite: "Invite link", publish: "Published to the web" };

function SharePanel({ pageID, title, onNavigate, onClose }: Props & { onClose: () => void }) {
  const config = syncConfig.get();
  const url = config?.url, token = config?.token;
  const api = useMemo(() => (url && token !== undefined ? new ShareAPI({ url, token }) : undefined), [url, token]);
  const [access, setAccess] = useState<PageAccess | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<ShareRole>("view");
  /** Gerade angelegter Link: das Geheimnis gibt es nur jetzt. */
  const [fresh, setFresh] = useState<{ url: string; kind: ShareLinkInfo["kind"] } | undefined>();
  const [copied, setCopied] = useState<string | undefined>();

  const load = useCallback(async () => {
    if (!api) return;
    setError(undefined);
    try {
      setAccess(await api.access(pageID));
    } catch (e) {
      setError(shareErrorMessage(e));
    }
  }, [api, pageID]);
  useEffect(() => void load(), [load]);

  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
      await load();
    } catch (e) {
      setError(shareErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const copyURL = async (url: string) => {
    setCopied((await copy(url)) ? url : undefined);
  };

  const done = <BasedButton label="Done" onClick={onClose} />;
  const heading = `Share “${title || "Untitled"}”`;

  if (!config || !api) {
    return (
      <BasedDialog open onClose={onClose} title={heading} actions={<>{done}<BasedButton label="Open settings" variant="primary" onClick={() => { onClose(); onNavigate({ name: "settings", page: "sync" }); }} /></>}>
        <Banner status="info" title="Sharing needs a sync server" description="Pages are shared through your own based-server. Connect one in Settings → Sync & server to publish this page or share a link. Nothing leaves this device until you do." />
      </BasedDialog>
    );
  }

  const published = publishedLink(access);
  const publishedURL = published?.path ? shareURL(config.url, published.path) : undefined;
  const others = (access?.links ?? []).filter((l) => l.kind !== "publish" && l.active);
  const roleItems = LINK_ROLES.map((r) => ({ label: SHARE_ROLE_LABEL[r], onSelect: () => setRole(r) }));

  return (
    <BasedDialog open onClose={onClose} title={heading} subtitle={`Through ${new URL(config.url).host}`} width={520} busy={busy} actions={done}>
      <VStack gap={5}>
        {error ? <Banner status="error" title="Couldn't update sharing" description={error} endContent={<BasedButton size="sm" label="Try again" onClick={() => void load()} />} /> : null}

        <section className="share-section" aria-label="Publish to web">
          <VStack gap={2}>
            <Text type="label" display="block">Publish to web</Text>
            {published && publishedURL ? (
              <>
                <Text type="supporting" color="secondary" display="block">Anyone with the link can read this page and its sub-pages. It's read-only and needs no account.</Text>
                <Text type="code" display="block" data-testid="share-published-url" className="share-url">{publishedURL}</Text>
                <HStack gap={2} wrap="wrap">
                  <BasedButton label={copied === publishedURL ? "Copied" : "Copy link"} onClick={() => void copyURL(publishedURL)} />
                  <Link href={publishedURL} target="_blank">Open</Link>
                  <BasedButton label="Unpublish" variant="danger" disabled={busy} onClick={() => void act(() => api.revoke(published.id))} />
                </HStack>
                <CheckboxInput label="Allow embeds on this published page" description="Shows embedded videos, maps and other sites in a sandboxed frame. Off: they appear as links, and the page loads nothing from other sites."
                  value={published.allowEmbeds === true} isDisabled={busy} data-testid="share-allow-embeds"
                  onChange={(v) => void act(async () => { await api.setEmbeds(published.id, v); })} />
              </>
            ) : (
              <>
                <Text type="supporting" color="secondary" display="block">Make a read-only copy of this page and its sub-pages readable on the web, without an account.</Text>
                <HStack gap={2}>
                  <BasedButton label="Publish" variant="primary" disabled={busy || access === undefined} onClick={() => void act(async () => { await api.publish(pageID); })} />
                </HStack>
              </>
            )}
          </VStack>
        </section>

        <section className="share-section" aria-label="Share a link">
          <VStack gap={2}>
            <Text type="label" display="block">Share a link</Text>
            <Text type="supporting" color="secondary" display="block">A link for people without an account, or an invite that gives one person their own sign-in. The link is shown once — copy it now.</Text>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <BasedMenu label={SHARE_ROLE_LABEL[role]} items={roleItems} />
              <BasedButton label="Create link" disabled={busy || access === undefined} onClick={() => void act(async () => {
                const l = await api.createLink(pageID, "access", role);
                if (l.path) setFresh({ url: shareURL(config.url, l.path), kind: "access" });
              })} />
              <BasedButton label="Create invite" variant="ghost" disabled={busy || access === undefined} onClick={() => void act(async () => {
                const l = await api.createLink(pageID, "invite", role);
                if (l.path) setFresh({ url: shareURL(config.url, l.path), kind: "invite" });
              })} />
            </HStack>
            {fresh ? (
              <VStack gap={1}>
                <Text type="code" display="block" data-testid="share-new-url" className="share-url">{fresh.url}</Text>
                <HStack gap={2}><BasedButton size="sm" label={copied === fresh.url ? "Copied" : "Copy link"} onClick={() => void copyURL(fresh.url)} /></HStack>
              </VStack>
            ) : null}
            {others.length > 0 ? (
              <List density="compact" hasDividers edge="flush" header={<Text type="supporting" color="secondary">Active links</Text>}>
                {others.map((l) => (
                  <ListItem key={l.id} label={KIND_LABEL[l.kind]} description={`${SHARE_ROLE_LABEL[l.role]}${l.inherited ? " · from a page above" : ""}`}
                    endContent={l.inherited ? undefined : <BasedButton size="sm" variant="ghost" label="Revoke" disabled={busy} onClick={() => void act(() => api.revoke(l.id))} />} />
                ))}
              </List>
            ) : null}
          </VStack>
        </section>

        {access && access.people.length > 0 ? (
          <section className="share-section" aria-label="People with access">
            <List density="compact" hasDividers edge="flush" header={<Text type="label">People with access</Text>}>
              {access.people.map((p) => (
                <ListItem key={p.id} label={p.name} description={p.inherited ? `${SHARE_ROLE_LABEL[p.role]} · from a page above` : undefined}
                  endContent={p.inherited ? <Text type="supporting" color="secondary">{SHARE_ROLE_LABEL[p.role]}</Text> : (
                    <BasedMenu size="sm" variant="ghost" align="end" label={SHARE_ROLE_LABEL[p.role]} items={[
                      ...(["full", "edit", "comment", "view"] as const).map((r) => ({ label: SHARE_ROLE_LABEL[r], onSelect: () => void act(() => api.setRole(p.userID, pageID, r)) })),
                      {},
                      { label: "Remove", danger: true, onSelect: () => void act(() => api.setRole(p.userID, pageID, null)) },
                    ]} />
                  )} />
              ))}
            </List>
          </section>
        ) : null}
      </VStack>
    </BasedDialog>
  );
}
