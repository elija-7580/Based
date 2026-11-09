import { defineConfig, devices } from "@playwright/test";

// BSD-154 / ADR 0011: Der Editor muss auf WebKit (iOS, Mac, Linux) und Chromium (Android, Windows) laufen.
export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? "list" : [["list"]],
  use: { baseURL: "http://localhost:4183" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], permissions: ["clipboard-read", "clipboard-write"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "pnpm exec vite build && pnpm exec vite preview",
    url: "http://localhost:4183",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
