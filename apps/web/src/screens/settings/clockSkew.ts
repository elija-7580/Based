// BSD-399: eigene Datei, damit diagnostics.tsx und sections.tsx sich nicht gegenseitig importieren.
/** BSD-286: „This device's clock is 1 h 5 min behind the server“. */
export function clockSkewText(seconds: number): string {
  const a = Math.abs(seconds);
  const parts = a >= 86_400 ? [`${Math.floor(a / 86_400)} d`, `${Math.floor((a % 86_400) / 3600)} h`]
    : a >= 3600 ? [`${Math.floor(a / 3600)} h`, `${Math.floor((a % 3600) / 60)} min`]
      : [`${Math.max(1, Math.round(a / 60))} min`];
  const span = parts.filter((p) => !/^0 /.test(p)).join(" ");
  return `This device's clock is ${span} ${seconds > 0 ? "behind" : "ahead of"} the server`;
}
