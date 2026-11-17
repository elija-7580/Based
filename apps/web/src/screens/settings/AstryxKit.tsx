// Design-Kit: die Based-Wrapper um Astryx (@based/ui/astryx) im Theme „Based Default“ auf einen Blick – Vorlage für
// andere Bereiche und Grundlage der Screenshots web-astryx-kit-*.png. Erreichbar über Settings → Diagnostics.
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { BasedButton, BasedChip, BasedConfirm, BasedDialog, BasedField, BasedIconButton, BasedKeys, BasedMediaPlayer, BasedMenu, BasedPopover, BasedTabs, BasedToken } from "@based/ui/astryx";
import { useState } from "react";
import { Icon } from "../../icons.js";

export function AstryxKit() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState("Lecture notes");
  const [url, setURL] = useState("based.example");
  const [picked, setPicked] = useState("nothing yet");
  const [tab, setTab] = useState("notes");
  const [chip, setChip] = useState(true);
  return (
    <VStack gap={6} className="kit" data-testid="astryx-kit">
      <VStack gap={1}>
        <Heading level={1}>Design kit</Heading>
        <Text type="supporting" color="secondary" display="block">Based wrappers around Astryx. Import them from @based/ui/astryx.</Text>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>Buttons</Heading>
        <Card>
          <HStack gap={2} wrap="wrap" vAlign="center">
            <BasedButton label="Ask" variant="primary" />
            <BasedButton label="Export…" />
            <BasedButton label="Cancel" variant="ghost" />
            <BasedButton label="Delete" variant="danger" />
            <BasedButton label="Disabled" disabled />
            <BasedButton label="Small" />
            <BasedIconButton label="Close" tooltip="Close (Esc)" icon={<Icon name="close" size={16} />} />
            <BasedIconButton label="Add to Favorites" pressed={false} icon={<Icon name="star" size={16} />} />
            <Badge label="3" />
          </HStack>
        </Card>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>Form fields</Heading>
        <Card>
          <VStack gap={4}>
            <BasedField label="Page name" value={name} onChange={setName} hint="Shown in the sidebar" />
            <BasedField label="Server URL" type="url" value={url} onChange={setURL} error={/^https?:\/\//.test(url) ? "" : "The address must start with https://"} />
            <BasedField label="Token" type="password" value="secret" onChange={() => undefined} disabled />
          </VStack>
        </Card>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>Menu, popover, dialog</Heading>
        <Card>
          <VStack gap={3}>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <BasedMenu
                label="Page menu"
                items={[
                  { label: "Rename", onSelect: () => setPicked("Rename") },
                  { label: "Duplicate", description: "Copies the page and its sub-pages", onSelect: () => setPicked("Duplicate") },
                  {},
                  { label: "Move to Trash", danger: true, onSelect: () => setPicked("Move to Trash") },
                ]}
              />
              <BasedPopover label="About the marker" trigger={<BasedButton label="Popover" />} width={280}>
                <Text type="body" display="block">The marker means one thing: an agent wrote or changed this. It is never a button colour.</Text>
              </BasedPopover>
              <BasedButton label="Open dialog" onClick={() => setDialog(true)} />
              <BasedButton label="Confirm…" variant="danger" onClick={() => setConfirm(true)} />
            </HStack>
            <Text type="supporting" color="secondary" display="block" data-testid="kit-picked">Last menu choice: {picked}</Text>
          </VStack>
        </Card>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>Tabs and tokens</Heading>
        <Card>
          <VStack gap={3}>
            <BasedTabs label="Meeting" value={tab} onChange={setTab} tabs={[{ id: "summary", label: "Summary" }, { id: "notes", label: "Notes" }, { id: "transcript", label: "Transcript" }]} />
            <HStack gap={2} wrap="wrap" vAlign="center">
              <BasedToken label="Agenda: release" onRemove={() => setPicked("Removed token")} />
              <BasedToken label="Ada" color="blue" onClick={() => setPicked("Ada")} />
              <BasedToken label="1:05" mono onClick={() => setPicked("1:05")} description="Play from here" />
              <BasedToken label="0:00" mono disabled />
            </HStack>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <BasedChip label="Title only" pressed={chip} onChange={setChip} />
              <BasedChip label="In this page" pressed={!chip} onChange={(on) => setChip(!on)} tooltip="Only this page and its sub-pages" />
              <BasedChip label="Shared only" pressed={false} onChange={() => undefined} disabled />
            </HStack>
            {/* Tastenkürzel in der Schreibweise des Tastatur-Registers (shell/keymap.ts) */}
            <HStack gap={4} wrap="wrap" vAlign="center" data-testid="kit-keys">
              <BasedKeys keys="Mod+K" />
              <BasedKeys keys="Mod+Shift+/" />
              <BasedKeys keys="Tab / Shift+Tab" />
              <BasedKeys keys="Arrows" />
            </HStack>
          </VStack>
        </Card>

        {/* BSD-447: Wiedergabe für Video- und Audio-Blöcke (statt der Browser-Steuerleiste) */}
        <Heading level={2}>Media</Heading>
        <Card>
          <BasedMediaPlayer src={SILENCE} kind="audio" label="Two seconds of silence.wav" testID="kit-media" />
        </Card>
      </VStack>

      <BasedDialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Rename page"
        subtitle="The link to this page stays the same."
        form
        actions={<>
          <BasedButton label="Cancel" variant="ghost" onClick={() => setDialog(false)} />
          <BasedButton label="Rename" variant="primary" onClick={() => setDialog(false)} />
        </>}
      >
        <BasedField label="Page name" value={name} onChange={setName} />
      </BasedDialog>
      <BasedConfirm open={confirm} onClose={() => setConfirm(false)} title="Empty the Trash?" description="3 pages will be deleted for good. This can't be undone." actionLabel="Empty Trash" onConfirm={() => undefined} />
    </VStack>
  );
}

/** Zwei Sekunden Stille als WAV (8 kHz, 8 bit, mono) – damit der Player im Kit etwas zum Abspielen hat. */
const SILENCE = (() => {
  const n = 16000, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
  const w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
  b.fill(128, 44);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return "data:audio/wav;base64," + btoa(s);
})();
