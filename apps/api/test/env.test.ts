import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env.js";

describe("env", () => {
  it("converts journey refresh minutes to milliseconds", () => {
    const config = loadConfig({
      JOURNEY_REFRESH_MINUTES: "3"
    });

    expect(config.JOURNEY_REFRESH_MINUTES).toBe(3);
    expect(config.journeyRefreshMs).toBe(180_000);
  });

  it("defaults journey refresh to twelve minutes", () => {
    const config = loadConfig({});

    expect(config.JOURNEY_REFRESH_MINUTES).toBe(12);
    expect(config.journeyRefreshMs).toBe(720_000);
  });

  it("provides defaults for the Spotify playback-reconciliation poller", () => {
    const config = loadConfig({});

    expect(config.SPOTIFY_PLAYBACK_POLL_ENABLED).toBe(true);
    expect(config.SPOTIFY_PLAYBACK_POLL_ACTIVE_SECONDS).toBe(5);
    expect(config.SPOTIFY_PLAYBACK_POLL_IDLE_SECONDS).toBe(30);
    expect(config.SPOTIFY_REFILL_THRESHOLD).toBe(3);
    expect(config.SPOTIFY_REFILL_MIN_INTERVAL_SECONDS).toBe(60);
  });

  it("coerces and disables the poller from env strings", () => {
    const config = loadConfig({
      SPOTIFY_PLAYBACK_POLL_ENABLED: "false",
      SPOTIFY_PLAYBACK_POLL_ACTIVE_SECONDS: "10"
    });

    expect(config.SPOTIFY_PLAYBACK_POLL_ENABLED).toBe(false);
    expect(config.SPOTIFY_PLAYBACK_POLL_ACTIVE_SECONDS).toBe(10);
  });
});
