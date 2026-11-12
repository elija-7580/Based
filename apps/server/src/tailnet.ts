// BSD-315: Erreichbarkeit im eigenen Tailnet (Tailscale). Der lokale Server lauscht dann zusätzlich nur auf den
// Tailscale-Adressen dieses Rechners – nie auf 0.0.0.0. Tailscale vergibt IPv4 aus 100.64.0.0/10 (CGNAT) und IPv6
// aus fd7a:115c:a1e0::/48; andere Schnittstellen (WLAN, LAN) bleiben zu.
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export function isTailnetAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/** Tailscale-Adressen dieses Rechners (IPv4 zuerst). */
export function tailnetAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) for (const i of list ?? []) if (!i.internal && isTailnetAddress(i.address) && !out.includes(i.address)) out.push(i.address);
  return out.sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
}

/** URL für eine Adresse (IPv6 in Klammern). */
export const urlFor = (ip: string, port: number) => `http://${ip.includes(":") ? `[${ip}]` : ip}:${port}`;
