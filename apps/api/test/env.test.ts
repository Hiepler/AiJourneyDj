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

  it("defaults the takeover guard on and inactivity auto-stop to 45 minutes", () => {
    const config = loadConfig({});

    expect(config.PLAYBACK_RESPECT_USER_TAKEOVER).toBe(true);
    expect(config.JOURNEY_INACTIVITY_STOP_MINUTES).toBe(45);
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

  it("enables Adaptive Drive Mode by default and can disable it", () => {
    expect(loadConfig({}).ADAPTIVE_DRIVE_MODE_ENABLED).toBe(true);
    expect(loadConfig({ ADAPTIVE_DRIVE_MODE_ENABLED: "false" }).ADAPTIVE_DRIVE_MODE_ENABLED).toBe(false);
  });

  it("defaults the telemetry poll cadence to a cost-friendly 120s, overridable", () => {
    expect(loadConfig({}).TESLA_POLL_SECONDS).toBe(120);
    expect(loadConfig({ TESLA_POLL_SECONDS: "60" }).TESLA_POLL_SECONDS).toBe(60);
  });

  it("provides MQTT + stream-window config with defaults", () => {
    const config = loadConfig({
      MQTT_URL: "mqtt://localhost:1883",
      MQTT_TOPIC: "tesla/telemetry",
      STREAM_FRESH_WINDOW_SECONDS: "90"
    });
    expect(config.MQTT_URL).toBe("mqtt://localhost:1883");
    expect(config.MQTT_TOPIC).toBe("tesla/telemetry");
    expect(config.STREAM_FRESH_WINDOW_SECONDS).toBe(90);
  });

  it("provides admin + vehicle-command proxy config", () => {
    const config = loadConfig({
      ADMIN_API_TOKEN: "secret",
      TESLA_COMMAND_PROXY_URL: "https://vehicle-command:4444",
      TESLA_TELEMETRY_VINS: "VIN1, VIN2"
    });

    expect(config.ADMIN_API_TOKEN).toBe("secret");
    expect(config.TESLA_COMMAND_PROXY_URL).toBe("https://vehicle-command:4444");
    expect(config.teslaTelemetryVins).toEqual(["VIN1", "VIN2"]);
  });
});
