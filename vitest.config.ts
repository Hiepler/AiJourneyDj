import { defineConfig } from "vitest/config";

// Vitest 4 workspace config. Each project supplies its own include/exclude
// (e.g. apps/web restricts to src/ so Playwright e2e specs are never collected).
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"]
  }
});
