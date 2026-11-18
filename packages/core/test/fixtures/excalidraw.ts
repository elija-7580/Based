// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-566: Zeichnung wie vom Obsidian-Excalidraw-Plugin (Szene mit LZ-String gepackt, Zeilen umbrochen).
// Inhalt: Rechteck „Start“ → Pfeil → rote Ellipse, Freihandstrich, loser Text, Bild, gelöschtes Element, Einbettung.
export const EXCALIDRAW_PACKED = `N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcmTGAWxkbBoQBtUHgQh8ARjLhocRPhiow6RgHNO05AgAM5CDvJE8YABattukCZjZVJsAgkXyK9XMs0w+egGsYAYXpMenwxAGIJGEjI6QAjdFQfVW8AV0ZcQODQxDD0AFZcAA4AM2LpbBoAEQ4YMBhcBGKsGhhyWPo03ABRTh4+AXhhEFFEMClySFgxOuQHAF8AXTnSEQbR

8Zkp0ZQHci14Jz0EABZLI1xTR0LLa1t7cwmdsQBlZXxdkBDbbEYsABUnohXuh3tJUExlD9qABJNbiDaebx+TIhcLRKJwZarMRRaSTORITA4KAtTQnZwgfTwM7GMwHFg3Gx2Bz0yyuDTU8iI3wBIKonIwbQAZgkIriCSSqXSKOy4EIjBoUBBvHmK2GcPQG3xYhB3hIe3MlipeRpFzpDMZdxZhxAUHoP34QkEum0C1IggtpCcCzdIG5yL5soiGJiXL

eYAAQj9cD9VAhQDU+mBYWJJCBlkh0lH0rH44TuCqU4hcRneLgAIL4PXWdAaqv0EhY9ViYpa2QthT1Qj6kD7I2Gwy0hAm8i3ZkPW32/pOl1uwSHPJzhle13ukcMn3kKAKGg0FI7oS+/28rLhFjFACcMGOx2kx4A6kP4CwmyNe22tuAngbOZSEEKKXOS4DgpMd7mfSwZhZEAABl6HoFoAAJGHoOppC+VQfn+QFYPgpCULQsMkRPfkQAiC8AHYJFQFh

0zVN9sA/AlsC4dBVDgH8AP7eAuMHM0EAANmOUcmXAoTyGKbBOCLEBtAkFghWOPIBIowoL3QWJUFwGBijkhSlJUtSNK0nS9MU5SKLo7FEFUJgOM2AkFCUdl7L7I5fyAukJBEq1HHICpqk4Oo1i8FIYFfOFuFiPF22LLhYnqXANI0H9uNNYCbTA61tEWOYgA==`;

export const excalidrawNote = (packed = EXCALIDRAW_PACKED) =>
  `---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n# Excalidraw Data\n\n## Text Elements\nStart ^t1\n\n## Embedded Files\n0123456789abcdef0123456789abcdef01234567: [[pic.png]]\n\n%%\n## Drawing\n\`\`\`compressed-json\n${packed}\n\`\`\`\n%%`;
