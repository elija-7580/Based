// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-609 (Entscheidung Elija 19.11.: „zeigen“): Based Notes Beta hat keine Inbox. Rückfragen von KI-Apps über MCP
// (Delete forever, Papierkorb leeren, Teilen, Skill speichern) warten hier, auf der Seite „Connect AI apps“, als
// schlichte Liste: Frage, welche App, was beim Erlauben passiert, Allow/Decline. Nur auf beta – Based Next fragt in der
// Inbox. Beantwortet wird ohne Agenten-Werkzeuge (Worker-Op `answerRequest`, BSD-595): Erlauben vermerkt die
// Zustimmung, der Server, der die Anfrage angelegt hat, führt sie aus. Liste und Sätze: openToolRequests (@based/brain).
import { BasedButton } from "@based/ui/astryx";
import { openToolRequests } from "@based/brain";
import { useEffect, useMemo, useState } from "react";
import { Group, Lines, Note, Row } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";
import { CHANNEL } from "../shell/beta.js";
import { askedWhen } from "./aiApps.js";

function AIRequestsSection({ client, state }: SettingsSectionProps) {
  const snap = state.agents;
  useEffect(() => {
    if (state.ready && !snap) void client.agentSnapshot().catch(() => undefined);
  }, [state.ready, snap, client]);
  const requests = useMemo(() => openToolRequests(snap?.runs ?? []), [snap]);
  const [busy, setBusy] = useState<string>();
  const [status, setStatus] = useState<string>();

  const answer = (id: string, ok: boolean) => {
    if (busy) return;
    setBusy(id);
    setStatus(undefined);
    client.agents<string>({ op: "answerRequest", id, ok }).then(
      () => setStatus(ok ? "Allowed. Based carries it out now." : "Declined. Nothing was changed."),
      () => setStatus("Couldn't save the answer. Try again."),
    ).finally(() => setBusy(undefined));
  };

  return (
    <Group>
      {requests.length === 0 ? (
        <Note testID="ai-requests-empty">When an AI app asks before it deletes or shares something, the request waits here.</Note>
      ) : (
        <Lines gap={4} testID="ai-requests">
          {requests.map((r) => (
            <Lines key={r.id} gap={0} testID="ai-request">
              <Row label={r.question} hint={`${r.app} asked ${askedWhen(r.askedAt)}. ${r.effect}`}>
                <BasedButton label="Decline" variant="ghost" ariaLabel={`Decline: ${r.question}`} disabled={busy !== undefined} onClick={() => answer(r.id, false)} />
                <BasedButton label="Allow" ariaLabel={`Allow: ${r.question}`} disabled={busy !== undefined && busy !== r.id} busy={busy === r.id} onClick={() => answer(r.id, true)} />
              </Row>
            </Lines>
          ))}
        </Lines>
      )}
      {status ? <Note testID="ai-requests-status">{status}</Note> : null}
    </Group>
  );
}

if (CHANNEL === "beta") {
  registerSettingsSection({ id: "ai-requests", page: "ai-apps", title: "Requests from AI apps", order: 5, component: AIRequestsSection, keywords: ["Requests", "Allow", "Decline", "Delete forever"] });
}
