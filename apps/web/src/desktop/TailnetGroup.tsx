// BSD-315: „Reachable from my other devices (Tailscale)“ – der lokale Server lauscht zusätzlich nur auf den
// Tailscale-Adressen dieses Rechners. Geräte koppeln per QR-Code mit eigenem, widerrufbarem Token (nie das
// Haupt-Token), Liste der Geräte mit „Revoke“.
import { Code } from "@astryxdesign/core/Code";
import { List, ListItem } from "@astryxdesign/core/List";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Layout";
import { BasedButton } from "@based/ui/astryx";
import qrcode from "qrcode-generator";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { relative } from "../shell/format.js";
import { localServer } from "./localServer.js";

function qrDataURL(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
}

export function TailnetGroup() {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [devices, setDevices] = useState<{ id: string; name: string; createdAt: number; lastSeenAt?: number }[]>([]);
  const [name, setName] = useState("iPhone");
  const [pairing, setPairing] = useState<{ token: string; link: string | undefined }>();
  const [error, setError] = useState<string>();
  const running = s.status === "running";
  const load = useCallback(() => { if (running) ls.devices().then(setDevices, () => setDevices([])); }, [ls, running]);
  useEffect(load, [load]);
  const pair = async () => {
    setError(undefined);
    try {
      const r = await ls.addDevice(name.trim() || "Device");
      setPairing({ token: r.token, link: r.link });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const urls = s.tailnetUrls;
  return (
    <Group>
      <Switch
        label="Reachable from my other devices (Tailscale)"
        description="Also listens on this computer's Tailscale address – never on Wi-Fi or the open network. Your phone pairs with its own token, which you can revoke here."
        value={s.tailnet} onChange={(on) => { setPairing(undefined); void ls.setTailnet(on); }} labelPosition="start" labelSpacing="spread" width="100%" data-testid="tailnet-switch"
      />
      {s.tailnet && running ? (
        urls && urls.length > 0 ? (
          <Row label="Address in your tailnet"><Value testID="tailnet-address">{urls.join(" · ")}</Value></Row>
        ) : (
          <Text type="supporting" color="secondary" role="status" data-testid="tailnet-missing">Tailscale isn't running on this computer. Install Tailscale, sign in, then turn this off and on again.</Text>
        )
      ) : null}
      {s.tailnet && running && urls && urls.length > 0 ? (
        <VStack gap={2}>
          <TextInput label="Device name" value={name} onChange={setName} />
          <Row label="Pair a device" hint="Scan the code with the Based app on your phone, or enter the address and token there under Settings → Sync & server.">
            <BasedButton label="Pair…" onClick={() => void pair()} />
          </Row>
          {pairing ? (
            <VStack gap={2} data-testid="tailnet-pairing">
              {pairing.link ? <img className="tailnet-qr" src={qrDataURL(pairing.link)} alt="Pairing code for your phone" width={180} height={180} /> : null}
              <Text type="supporting">Address: <Code>{urls[0]}</Code></Text>
              <Text type="supporting">Device token (shown once): <Code>{pairing.token}</Code></Text>
            </VStack>
          ) : null}
        </VStack>
      ) : null}
      {error ? <Text type="supporting" color="secondary" role="alert">{error}</Text> : null}
      {running && devices.length > 0 ? (
        <List aria-label="Paired devices" data-testid="tailnet-devices">
          {devices.map((d) => (
            <ListItem key={d.id} label={d.name} description={d.lastSeenAt ? `Last seen ${relative(new Date(d.lastSeenAt))}` : `Paired ${relative(new Date(d.createdAt))}`}
              endContent={<BasedButton label="Revoke" variant="ghost" onClick={() => void ls.removeDevice(d.id).then(load)} />} />
          ))}
        </List>
      ) : null}
    </Group>
  );
}
