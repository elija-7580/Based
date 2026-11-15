// Unit-Tests des Editors (die Vite-Testseite mit BlockNote ist mit BSD-407 Teil 4 entfernt).
// testTimeout 20 s (BSD-404 Nachtrag): unter voller Last (load > 20) riss jsdom-Start + erster Test das 5-s-Timeout.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { root: ".", include: ["test/**/*.test.{ts,tsx}"], testTimeout: 20_000 },
});
