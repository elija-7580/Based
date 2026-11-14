// BSD-418: Settings → Diagnostics → Hangs – wie der Reiter „Hangs“ der Swift-App (DiagnosticsView.swift): Kennzahlen der
// Sitzung, Liste (Zeit, Dauer, Quelle, Aktivität, Ursache, Schritte aufklappbar), Hänger früherer Sitzungen und der
// Hänger, in dem die vorige Sitzung endete. Nur Bausteine aus parts.tsx und @based/ui/astryx.
import { formatHangMs, ongoingHangNotice, type HangRecord, type HangSessionData, type HangSource } from "@based/core";
import { BasedButton } from "@based/ui/astryx";
import { useState, useSyncExternalStore } from "react";
import { hangAttribution, hangHistory, hangMonitor } from "../../shell/hangs.js";
import { Group, Lines, Note, Row, Value } from "./parts.js";
import type { SettingsSectionProps } from "./registry.js";

const SOURCE: Record<HangSource, string> = { main: "Main thread", input: "Slow input", worker: "Store" };
const SHOWN = 20;

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
const day = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function summary(count: number, blockedMs: number) {
  return count ? `${plural(count, "hang")} · ${formatHangMs(blockedMs)} blocked` : "No hangs";
}

/** Ein Hänger: Dauer und Quelle, darunter Zeit, Aktivität und Ursache; Schritte davor aufklappbar. */
function HangItem({ hang, withDay = false }: { hang: HangRecord; withDay?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = `${formatHangMs(hang.ms)}${hang.ongoing ? "+" : ""} · ${SOURCE[hang.source]}${hang.ongoing ? " · still blocked when the session ended" : ""}`;
  const hint = [withDay ? day(hang.at) : clock(hang.at), hang.activity ? `during ${hang.activity}` : "", hang.culprit ? `in ${hang.culprit}` : ""].filter(Boolean).join(" · ");
  return (
    <Lines gap={1} testID="hang-item">
      <Row label={label} hint={hint}>
        {hang.breadcrumbs.length ? (
          <BasedButton label={open ? "Hide steps" : `Steps (${hang.breadcrumbs.length})`} variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}
            ariaLabel={open ? "Hide the steps before this hang" : "Show the steps before this hang"} />
        ) : null}
      </Row>
      {open ? <Note testID="hang-steps">{`Steps before: ${hang.breadcrumbs.join(" › ")}`}</Note> : null}
    </Lines>
  );
}

function HangList({ hangs, withDay = false, testID }: { hangs: readonly HangRecord[]; withDay?: boolean; testID: string }) {
  const [all, setAll] = useState(false);
  const newest = [...hangs].reverse();
  const shown = all ? newest : newest.slice(0, SHOWN);
  return (
    <Lines gap={3} testID={testID}>
      {shown.map((h, i) => <HangItem key={`${h.at}-${h.source}-${i}`} hang={h} withDay={withDay} />)}
      {newest.length > SHOWN ? <BasedButton label={all ? "Show fewer" : `Show all ${newest.length}`} variant="ghost" size="sm" onClick={() => setAll((a) => !a)} /> : null}
    </Lines>
  );
}

function PreviousSession({ session }: { session: HangSessionData }) {
  const [open, setOpen] = useState(false);
  const s = session.stats;
  const hint = s.count ? `${summary(s.count, s.blockedMs)} · p95 ${formatHangMs(s.p95)} · max ${formatHangMs(s.max)}` : "No hangs";
  return (
    <Lines gap={3} testID="hang-session">
      <Row label={`Session from ${day(session.startedAt)}`} hint={hint}>
        {session.hangs.length ? <BasedButton label={open ? "Hide hangs" : "Show hangs"} variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} /> : null}
      </Row>
      {open ? <HangList hangs={session.hangs} withDay testID="hang-session-list" /> : null}
    </Lines>
  );
}

const ATTRIBUTION = {
  loaf: "Causes come from the browser’s frame timing: the script and function that ran longest.",
  longtask: "This browser reports long tasks but not which script ran — hangs show no cause.",
  none: "This engine doesn’t report which script blocked (WebKit) — hangs show the activity and the steps before.",
} as const;

/** Hänger: Kennzahlen, Liste dieser Sitzung, Ende der vorigen Sitzung, frühere Sitzungen. */
export function HangsSection(_: SettingsSectionProps) {
  const hangs = useSyncExternalStore(hangMonitor.subscribe, hangMonitor.getSnapshot);
  const { previous, endedInHang } = useSyncExternalStore(hangHistory.subscribe, hangHistory.get);
  const s = hangMonitor.stats();
  const earlier = [...previous].reverse().filter((p) => p.stats.count > 0);
  return (
    <Group>
      <Row label="This session" hint="Moments when Based didn’t respond for 250 ms or more">
        <Value testID="hangs-summary">{summary(s.count, s.blockedMs)}</Value>
      </Row>
      {s.count ? (
        <Row label="Duration" hint={`${plural(s.main, "main thread")} · ${plural(s.input, "slow input")} · ${plural(s.worker, "slow store request")}`}>
          <Value mono testID="hangs-percentiles">{`p50 ${formatHangMs(s.p50)} · p95 ${formatHangMs(s.p95)} · max ${formatHangMs(s.max)}`}</Value>
        </Row>
      ) : null}
      {endedInHang ? (
        <Row label="Last session" hint={`${ongoingHangNotice(endedInHang.marker)}${endedInHang.marker.breadcrumbs.length ? ` Steps before: ${endedInHang.marker.breadcrumbs.join(" › ")}` : ""}`}>
          <Value testID="hangs-ended-in-hang">Ended in a hang</Value>
        </Row>
      ) : null}
      {hangs.length ? <HangList hangs={hangs} testID="hangs-list" /> : null}
      <Note>{`${ATTRIBUTION[hangAttribution]} Measured only while the window is visible.`}</Note>
      {earlier.length ? <Lines gap={3} testID="hangs-previous">{earlier.map((p) => <PreviousSession key={p.id} session={p} />)}</Lines> : null}
    </Group>
  );
}
