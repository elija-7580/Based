// BSD-235 Teil 3: Gast-Link widerrufen oder abgelaufen (/share/v1/me → 401/403/404). Statt eines leeren Gast-
// Arbeitsbereichs ein klarer Hinweis; „Open Based“ startet den eigenen Arbeitsbereich (ohne ?guest=).
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";

export function GuestRevoked({ onOpenBased }: { onOpenBased: () => void }) {
  return (
    <Center minHeight="100dvh" padding={6}>
      <EmptyState
        headingLevel={1}
        title="This link no longer works"
        description="The owner turned off this link, or it was removed. Ask them for a new one."
        actions={<Button variant="secondary" label="Open Based" onClick={onOpenBased} />}
      />
    </Center>
  );
}
