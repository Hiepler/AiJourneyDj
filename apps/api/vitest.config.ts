import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // These are full service-integration tests (real analyze cycles over mocked LLM/Spotify).
    // They run ~1-2s locally but 4-5s on slower CI runners, so the 5s default times out
    // intermittently. Give them generous headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
