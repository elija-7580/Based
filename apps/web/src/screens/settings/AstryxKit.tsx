// Design-Kit: die Based-Wrapper um Astryx (@based/ui/astryx) im Theme „Based Default“ auf einen Blick – Vorlage für
// andere Bereiche und Grundlage der Screenshots web-astryx-kit-*.png. Erreichbar über Settings → Diagnostics.
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { BasedButton, BasedConfirm, BasedDialog, BasedField, BasedIconButton, BasedMenu, BasedPopover } from "@based/ui/astryx";
import { useState } from "react";
import { Icon } from "../../icons.js";

export function AstryxKit() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState("Lecture notes");
  const [url, setURL] = useState("based.example");
  const [picked, setPicked] = useState("nothing yet");
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
            <BasedButton label="Small" size="sm" />
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
