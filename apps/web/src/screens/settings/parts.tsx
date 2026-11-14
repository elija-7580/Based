// Kleine Bausteine der Einstellungs-Abschnitte (Astryx): Gruppe = Fläche, Zeile = Beschriftung links, Bedienung rechts.
import { Card } from "@astryxdesign/core/Card";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/** Zeilen einer Gruppe auf einer Fläche (surface-raised, Radius 18) – gruppiert wird mit Flächen, nicht mit Linien. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <Card>
      <VStack gap={4}>{children}</VStack>
    </Card>
  );
}

/** Eine Einstellung: links Name und Hinweis, rechts die Bedienung. `labelID` verbindet die Bedienung mit dem Namen. */
export function Row({ label, hint, labelID, children }: { label: string; hint?: ReactNode; labelID?: string; children?: ReactNode }) {
  return (
    <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
      <StackItem size="fill">
        <VStack gap={0}>
          <Text type="label" weight="semibold" display="block" {...(labelID ? { id: labelID } : {})}>{label}</Text>
          {hint ? <Text type="supporting" color="secondary" display="block">{hint}</Text> : null}
        </VStack>
      </StackItem>
      {children}
    </HStack>
  );
}

/** Nur-Lese-Wert in einer Zeile (Daten in Mono). */
export function Value({ children, mono = false, testID }: { children: ReactNode; mono?: boolean; testID?: string }) {
  return <Text type={mono ? "code" : "body"} color="secondary" {...(mono ? { "data-selectable": "" } : {})} {...(testID ? { "data-testid": testID } : {})}>{children}</Text>;
}

/** Untereinander (Listen in einer Gruppe), optional mit Test-ID. */
export function Lines({ children, gap = 2, testID }: { children: ReactNode; gap?: 0 | 1 | 2 | 3 | 4; testID?: string }) {
  return <VStack gap={gap} {...(testID ? { "data-testid": testID } : {})}>{children}</VStack>;
}

/** Kleine Zusatzzeile unter einer Zeile (z. B. aufgeklappte Schritte); `mono` für Zeiten und Namen. */
export function Note({ children, mono = false, testID }: { children: ReactNode; mono?: boolean; testID?: string }) {
  return <Text type={mono ? "code" : "supporting"} color="secondary" display="block" {...(mono ? { "data-selectable": "" } : {})} {...(testID ? { "data-testid": testID } : {})}>{children}</Text>;
}
