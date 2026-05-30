import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests live in src/ (*.test.ts). Playwright e2e specs (e2e/*.spec.ts) are run
    // separately via `npm run test:e2e` and must never be collected by vitest.
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/e2e/**"]
  }
});
