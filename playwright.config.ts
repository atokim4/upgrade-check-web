import { defineConfig } from "@playwright/test";

// BASE_URL runs the suite against a deployed copy instead of a local preview.
const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:4173";

// Uses an installed Chrome (CHROME_PATH, default /usr/bin/google-chrome) instead of a downloaded browser.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    launchOptions: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] },
  },
  webServer: process.env.BASE_URL ? undefined : { command: "npx vite preview --port 4173 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:4173", reuseExistingServer: true },
});
