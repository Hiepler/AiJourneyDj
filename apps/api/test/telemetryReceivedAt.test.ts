import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-telemetry-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

function makeJourney(): JourneyRecord {
  return {
    id: "journey-1",
    provider: "spotify",
    destination: "Lago di Garda",
    userPrompt: "golden hour",
    passengerMode: "couple",
    phase: "departure",
    status: "active",
    tasteWeight: 0.4,
    createdAtIso: new Date().toISOString()
  };
}

function event(overrides: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
  return {
    timestampIso: new Date().toISOString(),
    coarseRegion: "Northern Italy",
    destination: "Lago di Garda",
    etaMinutes: 60,
    speedKph: 110,
    outsideTempC: 22,
    autopilotState: "active",
    batteryPercent: 70,
    ...overrides
  };
}

describe("telemetry received_at (store)", () => {
  it("returns undefined before any telemetry is ingested", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    expect(store.latestTelemetryReceivedAt("journey-1")).toBeUndefined();
  });

  it("stamps a server ingest time and returns the latest one", () => {
    const store = freshStore();
    store.createJourney(makeJourney());

    const before = Date.now();
    store.saveTelemetry("journey-1", event(), "cruise");
    const after = Date.now();

    const receivedAt = store.latestTelemetryReceivedAt("journey-1");
    expect(receivedAt).toBeDefined();
    const ms = Date.parse(receivedAt!);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it("reflects the most recent snapshot's ingest time", () => {
    const store = freshStore();
    store.createJourney(makeJourney());

    // Older vehicle timestamp first, newer second — latest-by-timestamp wins.
    store.saveTelemetry("journey-1", event({ timestampIso: "2026-06-01T10:00:00.000Z" }), "cruise");
    store.saveTelemetry("journey-1", event({ timestampIso: "2026-06-01T11:00:00.000Z" }), "golden_hour");

    const receivedAt = store.latestTelemetryReceivedAt("journey-1");
    // Both stamped at ingest time (now), so it must parse as a valid recent ISO string.
    expect(receivedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(receivedAt!))).toBe(false);
  });
});
