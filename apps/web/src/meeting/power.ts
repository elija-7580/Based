// Feedback 14. 11.: Läuft das Gerät auf Akku? Für „Meeting-Transkript erst am Strom“. Mac-App: Rust-Befehl
// `power_on_battery` (pmset); Browser: Battery Status API (Chromium); sonst unbekannt (`undefined`).
import { isTauri } from "../desktop.js";

type BatteryManager = { charging: boolean; addEventListener(type: "chargingchange", fn: () => void): void };

export async function onBattery(): Promise<boolean | undefined> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = await invoke<boolean | null>("power_on_battery");
      return r ?? undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const nav = globalThis.navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    if (!nav.getBattery) return undefined;
    return !(await nav.getBattery()).charging;
  } catch {
    return undefined;
  }
}

/** Ruft `fn`, wenn das Gerät (vermutlich) an den Strom kommt: Browser-Ereignis, sonst Nachschauen jede Minute. */
export function watchPower(fn: () => void, everyMs = 60_000): () => void {
  let stop = false;
  const nav = globalThis.navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  if (!isTauri() && nav.getBattery) void nav.getBattery().then((b) => b.addEventListener("chargingchange", () => { if (!stop && b.charging) fn(); })).catch(() => undefined);
  const timer = setInterval(() => { if (!stop) fn(); }, everyMs);
  return () => { stop = true; clearInterval(timer); };
}
