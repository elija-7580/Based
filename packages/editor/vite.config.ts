// BSD-154: Testseite des Editors (nur für Playwright und zum Ausprobieren), Port 4183.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "testpage",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 4183, strictPort: true },
  preview: { port: 4183, strictPort: true },
  // testTimeout 20 s (BSD-404 Nachtrag): unter voller Last (load > 20) riss jsdom-Start + erster Test das 5-s-Timeout.
  test: { root: ".", include: ["test/**/*.test.{ts,tsx}"], testTimeout: 20_000 },
} as Parameters<typeof defineConfig>[0]);
