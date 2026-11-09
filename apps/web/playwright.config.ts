import { defineConfig, devices } from "@playwright/test";

// Port über BASED_E2E_PORT einstellbar (parallele Arbeitsordner auf derselben Maschine).
const port = Number(process.env.BASED_E2E_PORT ?? 4173);

// ADR 0011: Der Editor muss auf WebKit (iOS, Mac, Linux) und Chromium (Android, Windows) laufen.
export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? "list" : [["list"]],
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
