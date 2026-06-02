# Fleet Telemetry Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tesla Fleet Telemetry streaming the primary, near-real-time telemetry source (self-hosted `fleet-telemetry` Go server → MQTT → our API), with REST polling as an automatic fallback, unlocking real-time driving signals (acceleration / brake / hazards).

**Architecture:** The car pushes per-field, on-change data over mTLS to a self-hosted `fleet-telemetry` Go server, which publishes to a small Mosquitto MQTT broker. Our API's MQTT consumer normalizes each message and feeds the **existing** `ingestTelemetry` pipeline (ADM, reconciliation, badge unchanged). A pure `shouldPollRest` gate makes the existing REST poller stand down while streaming is fresh and resume otherwise.

**Tech Stack:** TypeScript, Node 24, Vitest, `mqtt` (mqtt.js, pure-JS — replaces `kafkajs`), Tesla `fleet-telemetry` (Go, via Coolify), Mosquitto.

**Two parts:** Tasks 1–10 are **CODE** (TDD, unit-testable). Task 11 is **OPS** (manual setup + verification checklist — infra cannot be unit-tested).

---

## File structure

- `packages/core/src/index.ts` — add streaming fields to `NormalizedTelemetryEvent`; add `telemetrySource` to `JourneyContext`.
- `packages/telemetry/src/index.ts` — new `normalizeFleetStream()`; extend with new fields.
- `packages/recommendation/src/driveState.ts` — real-time ADM rules (brake cycles, hazard / hard-brake).
- `apps/api/src/telemetry/streamSource.ts` *(new)* — `shouldPollRest()` + in-memory liveness tracker.
- `apps/api/src/telemetry/mqttTelemetryConsumer.ts` *(new)* — MQTT subscribe → normalize → ingest.
- `apps/api/src/telemetry/kafkaConsumer.ts` *(removed)*.
- `apps/api/src/telemetry/teslaFleetPoller.ts` — stand down when streaming fresh.
- `apps/api/src/auth/teslaAuth.ts` + `apps/api/src/journeys/routes.ts` — telemetry-config register/delete admin endpoint.
- `apps/api/src/config/env.ts` — `MQTT_URL`, `MQTT_TOPIC`, `STREAM_FRESH_WINDOW_SECONDS`; drop Kafka knobs.
- `apps/api/src/index.ts` — bootstrap MQTT consumer instead of Kafka; SIGTERM cleanup.
- `apps/api/src/journeys/routes.ts` + web (`lib/api.ts`, `App.tsx`, `lib/driveContext.ts`) — expose + show `telemetrySource`.
- `docs/deployment.md` — OPS checklist.

---

## Task 1: New streaming fields in core

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add fields to `NormalizedTelemetryEvent`** (after `audioVolume?`):

```ts
  /** Longitudinal acceleration in m/s² (streaming only — LongitudinalAcceleration). Negative = braking. */
  longitudinalAccelMps2?: number;
  /** Brake pedal pressed (streaming only — BrakePedal). */
  brakePedal?: boolean;
  /** Hazard lights active (streaming only — LightsHazardsActive). */
  hazardsActive?: boolean;
```

- [ ] **Step 2: Add `telemetrySource` to `JourneyContext`** (after `driveState?`):

```ts
  /** Which source produced the latest context: live streaming vs REST polling. */
  telemetrySource?: "streaming" | "polling";
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: `TypeScript compilation completed`

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add streaming telemetry fields + telemetrySource"
```

---

## Task 2: `normalizeFleetStream` (streaming payload → NormalizedTelemetryEvent)

**Files:**
- Modify: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/src/index.test.ts`

- [ ] **Step 1: Write the failing test** (append inside the existing `describe("tesla telemetry mapping", …)`):

```ts
  it("normalizeFleetStream maps streaming fields incl. real-time driving signals", () => {
    const { coordinates, ...event } = normalizeFleetStream(
      {
        vin: "VIN1",
        VehicleSpeed: 60, // mph
        Location: { latitude: 48.1, longitude: 11.5 },
        Soc: 64,
        OutsideTemp: 21,
        MinutesToArrival: 73.4,
        RouteTrafficMinutesDelay: 12,
        LongitudinalAcceleration: -2.5,
        BrakePedal: true,
        LightsHazardsActive: false
      },
      "secret"
    );
    expect(event.speedKph).toBe(97); // 60 mph
    expect(event.batteryPercent).toBe(64);
    expect(event.etaMinutes).toBe(73);
    expect(event.trafficDelayMinutes).toBe(12);
    expect(event.longitudinalAccelMps2).toBe(-2.5);
    expect(event.brakePedal).toBe(true);
    expect(event.hazardsActive).toBe(false);
    expect(coordinates).toEqual({ lat: 48.1, lon: 11.5 });
    // Raw GPS must never appear on the normalized event.
    expect((event as Record<string, unknown>).Location).toBeUndefined();
  });

  it("normalizeFleetStream leaves unknown/missing fields undefined", () => {
    const { coordinates, ...event } = normalizeFleetStream({ vin: "VIN1", VehicleSpeed: 30 }, "secret");
    expect(event.speedKph).toBe(48);
    expect(event.brakePedal).toBeUndefined();
    expect(event.hazardsActive).toBeUndefined();
    expect(event.longitudinalAccelMps2).toBeUndefined();
    expect(coordinates).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/telemetry/src/index.test.ts`
Expected: FAIL — `normalizeFleetStream is not a function` (also add it to the test's import).

- [ ] **Step 3: Implement `normalizeFleetStream`** (add to `packages/telemetry/src/index.ts`, reuse `FleetTelemetryResult`):

```ts
/**
 * Maps a Fleet *Telemetry* (streaming) payload into a normalized event. Field names differ from the
 * REST vehicle_data schema (e.g. VehicleSpeed in mph, Location object). Raw GPS is returned only as
 * transient `coordinates` for server-side geocoding — never stored or sent to the AI.
 */
export function normalizeFleetStream(payload: Record<string, any>, appSecret: string): FleetTelemetryResult {
  const vin = typeof payload?.vin === "string" ? payload.vin : undefined;
  const speedMph = typeof payload?.VehicleSpeed === "number" ? payload.VehicleSpeed : undefined;
  const speedKph = typeof speedMph === "number" ? Math.round(speedMph * 1.609) : undefined;
  const loc = (payload?.Location ?? {}) as Record<string, any>;
  const lat = typeof loc.latitude === "number" ? loc.latitude : undefined;
  const lon = typeof loc.longitude === "number" ? loc.longitude : undefined;
  const ts = typeof payload?.createdAt === "string" ? payload.createdAt : new Date().toISOString();

  return {
    vehicleIdHash: vin ? hashVehicleId(vin, appSecret) : undefined,
    timestampIso: ts,
    coarseRegion: undefined, // filled in by the consumer via reverse-geocoding
    destination: typeof payload?.DestinationName === "string" ? payload.DestinationName : undefined,
    etaMinutes: typeof payload?.MinutesToArrival === "number" ? Math.round(payload.MinutesToArrival) : undefined,
    speedKph,
    outsideTempC: typeof payload?.OutsideTemp === "number" ? payload.OutsideTemp : undefined,
    autopilotState: "unknown",
    batteryPercent: typeof payload?.Soc === "number" ? payload.Soc : undefined,
    trafficDelayMinutes:
      typeof payload?.RouteTrafficMinutesDelay === "number" ? Math.round(payload.RouteTrafficMinutesDelay) : undefined,
    energyPercentAtArrival:
      typeof payload?.ExpectedEnergyPercentAtTripArrival === "number"
        ? payload.ExpectedEnergyPercentAtTripArrival
        : undefined,
    longitudinalAccelMps2:
      typeof payload?.LongitudinalAcceleration === "number" ? payload.LongitudinalAcceleration : undefined,
    brakePedal: typeof payload?.BrakePedal === "boolean" ? payload.BrakePedal : undefined,
    hazardsActive: typeof payload?.LightsHazardsActive === "boolean" ? payload.LightsHazardsActive : undefined,
    coordinates: typeof lat === "number" && typeof lon === "number" ? { lat, lon } : undefined
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/telemetry/src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/index.ts packages/telemetry/src/index.test.ts
git commit -m "feat(telemetry): normalizeFleetStream for Fleet Telemetry streaming payloads"
```

---

## Task 3: `shouldPollRest` + streaming liveness

**Files:**
- Create: `apps/api/src/telemetry/streamSource.ts`
- Test: `apps/api/test/streamSource.test.ts`

- [ ] **Step 1: Write the failing test** (`apps/api/test/streamSource.test.ts`):

```ts
import { describe, expect, it } from "vitest";

import { shouldPollRest, StreamLiveness } from "../src/telemetry/streamSource.js";

describe("shouldPollRest", () => {
  const now = Date.parse("2026-06-02T12:00:00.000Z");
  const windowMs = 90_000;

  it("polls when streaming has never produced data", () => {
    expect(shouldPollRest(undefined, now, windowMs)).toBe(true);
  });
  it("stands down while streaming is fresh", () => {
    expect(shouldPollRest("2026-06-02T11:59:30.000Z", now, windowMs)).toBe(false); // 30s ago
  });
  it("resumes polling once streaming is stale", () => {
    expect(shouldPollRest("2026-06-02T11:58:00.000Z", now, windowMs)).toBe(true); // 2 min ago
  });
  it("polls on an unparseable timestamp", () => {
    expect(shouldPollRest("nonsense", now, windowMs)).toBe(true);
  });
});

describe("StreamLiveness", () => {
  it("records the last stream time and reports source", () => {
    const live = new StreamLiveness();
    expect(live.lastIso()).toBeUndefined();
    live.mark("2026-06-02T12:00:00.000Z");
    expect(live.lastIso()).toBe("2026-06-02T12:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/api/test/streamSource.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`apps/api/src/telemetry/streamSource.ts`):

```ts
/**
 * Pure gate: should the REST poller run, or stand down because streaming is live?
 * Returns true (poll) when there is no fresh streaming data within the window.
 */
export function shouldPollRest(lastStreamingAtIso: string | undefined, nowMs: number, freshWindowMs: number): boolean {
  if (!lastStreamingAtIso) return true;
  const last = Date.parse(lastStreamingAtIso);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= freshWindowMs;
}

/** Tiny in-memory tracker for the last time a streaming message arrived. */
export class StreamLiveness {
  private last?: string;
  mark(iso: string): void {
    this.last = iso;
  }
  lastIso(): string | undefined {
    return this.last;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/api/test/streamSource.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/telemetry/streamSource.ts apps/api/test/streamSource.test.ts
git commit -m "feat(telemetry): shouldPollRest gate + streaming liveness tracker"
```

---

## Task 4: ADM real-time rules (brake cycles + hazard / hard-brake)

**Files:**
- Modify: `packages/recommendation/src/driveState.ts`
- Test: `packages/recommendation/src/driveState.test.ts`

- [ ] **Step 1: Write the failing test** (append to `driveState.test.ts`):

```ts
describe("assessDriveState — real-time streaming signals", () => {
  const DAY = "2026-06-01T14:00:00.000Z";

  it("flags a hard brake / hazards as a strong calm cue", () => {
    const hazard = assessDriveState([ev({ speedKph: 50, hazardsActive: true })], DAY);
    expect(hazard.mode).toBe("calm");
    expect(hazard.reason).toBe("sudden braking");

    const hardBrake = assessDriveState([ev({ speedKph: 50, longitudinalAccelMps2: -4 })], DAY);
    expect(hardBrake.mode).toBe("calm");
  });

  it("flags repeated brake cycles at low speed as stop-and-go calm", () => {
    const recent = [
      ev({ speedKph: 20, brakePedal: true }),
      ev({ speedKph: 8, brakePedal: false }),
      ev({ speedKph: 18, brakePedal: true })
    ];
    expect(assessDriveState(recent, DAY).mode).toBe("calm");
  });

  it("does not trigger on a single brake tap at speed", () => {
    expect(assessDriveState([ev({ speedKph: 100, brakePedal: true })], DAY).mode).toBe("neutral");
  });
});
```

(`ev` helper already exists in this file and spreads overrides onto a `NormalizedTelemetryEvent`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/recommendation/src/driveState.test.ts`
Expected: FAIL — these return `neutral`.

- [ ] **Step 3: Implement** — add constants near the other thresholds in `driveState.ts`:

```ts
const HARD_BRAKE_MPS2 = -3.5; // strong deceleration → sudden braking
const STOPGO_SPEED_KPH = 35; // brake cycles below this = stop-and-go
const STOPGO_MIN_BRAKE_EVENTS = 2; // brake presses within the recent window
```

Then add these checks at the **top** of `assessDriveState`, immediately after `const latest = recent[recent.length - 1]; if (!latest) return NEUTRAL;` and **before** rule 1 (so real-time cues take priority):

```ts
  // R0a. Sudden braking / hazards (strong, real-time — streaming only).
  if (latest.hazardsActive === true || (typeof latest.longitudinalAccelMps2 === "number" && latest.longitudinalAccelMps2 <= HARD_BRAKE_MPS2)) {
    const signals = latest.hazardsActive ? ["hazard lights"] : ["hard braking"];
    return { mode: "calm", reason: "sudden braking", intensity: 0.8, signals };
  }

  // R0b. Stop-and-go: repeated brake presses at low speed (streaming only).
  const brakeEvents = recent.filter((e) => e.brakePedal === true).length;
  if (brakeEvents >= STOPGO_MIN_BRAKE_EVENTS && typeof latest.speedKph === "number" && latest.speedKph <= STOPGO_SPEED_KPH) {
    const signals = [`${brakeEvents} brake events in stop-and-go`];
    const intensity = applyVolumeAmplifier(0.55, recent, signals);
    return { mode: "calm", reason: "stop-and-go traffic", intensity, signals };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/recommendation/src/driveState.test.ts`
Expected: PASS (all, incl. existing rules)

- [ ] **Step 5: Commit**

```bash
git add packages/recommendation/src/driveState.ts packages/recommendation/src/driveState.test.ts
git commit -m "feat(recommendation): real-time ADM rules (hard brake/hazards, stop-and-go)"
```

---

## Task 5: MQTT telemetry consumer

**Files:**
- Create: `apps/api/src/telemetry/mqttTelemetryConsumer.ts`
- Test: `apps/api/test/mqttTelemetryConsumer.test.ts`
- Modify: `apps/api/package.json` (add `mqtt`)

- [ ] **Step 1: Add the dependency**

Run: `npm install mqtt -w @ai-journey-dj/api`
Expected: `mqtt` appears in `apps/api/package.json` dependencies.

- [ ] **Step 2: Write the failing test** — the consumer's message handler is extracted as a pure `handleStreamMessage` so it is testable without a broker:

```ts
import { describe, expect, it } from "vitest";

import { handleStreamMessage } from "../src/telemetry/mqttTelemetryConsumer.js";
import { StreamLiveness } from "../src/telemetry/streamSource.js";

describe("handleStreamMessage", () => {
  it("normalizes, geocodes, marks liveness, and ingests", async () => {
    const ingested: any[] = [];
    const live = new StreamLiveness();
    await handleStreamMessage({
      raw: Buffer.from(JSON.stringify({ vin: "VIN1", VehicleSpeed: 60, Location: { latitude: 48.1, longitude: 11.5 } })),
      appSecret: "s",
      geocode: async () => "Bavaria, Germany",
      ingest: async (e) => void ingested.push(e),
      live
    });
    expect(ingested).toHaveLength(1);
    expect(ingested[0].speedKph).toBe(97);
    expect(ingested[0].coarseRegion).toBe("Bavaria, Germany");
    expect(ingested[0].coordinates).toBeUndefined(); // raw GPS stripped
    expect(live.lastIso()).toBeDefined();
  });

  it("ignores an unparseable message without throwing", async () => {
    const ingested: any[] = [];
    await handleStreamMessage({
      raw: Buffer.from("not json"),
      appSecret: "s",
      geocode: async () => undefined,
      ingest: async (e) => void ingested.push(e),
      live: new StreamLiveness()
    });
    expect(ingested).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run apps/api/test/mqttTelemetryConsumer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** (`apps/api/src/telemetry/mqttTelemetryConsumer.ts`):

```ts
import mqtt from "mqtt";

import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeFleetStream } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { JourneyService } from "../journeys/journeyService.js";
import { makeGeocoder } from "./geocoder.js";
import { StreamLiveness } from "./streamSource.js";

export interface StreamMessageDeps {
  raw: Buffer | Uint8Array;
  appSecret: string;
  geocode: (lat: number, lon: number) => Promise<string | undefined>;
  ingest: (event: NormalizedTelemetryEvent) => Promise<void>;
  live: StreamLiveness;
}

/** Pure-ish handler for one streaming message. Best-effort: never throws on bad input. */
export async function handleStreamMessage(deps: StreamMessageDeps): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(deps.raw).toString("utf8"));
  } catch {
    return; // ignore malformed messages
  }
  const { coordinates, ...event } = normalizeFleetStream(payload, deps.appSecret);
  if (coordinates) {
    event.coarseRegion = await deps.geocode(coordinates.lat, coordinates.lon);
  }
  deps.live.mark(event.timestampIso);
  await deps.ingest(event);
}

export interface MqttConsumerHandle {
  stop: () => Promise<void>;
}

/** Subscribes to the fleet-telemetry MQTT topic and feeds the shared ingest pipeline. */
export function startMqttTelemetryConsumer(
  config: AppConfig,
  journeyService: JourneyService,
  live: StreamLiveness,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void }
): MqttConsumerHandle | undefined {
  if (!config.TESLA_TELEMETRY_ENABLED) return undefined;
  const geocode = makeGeocoder({ baseUrl: config.GEOCODER_URL });
  const client = mqtt.connect(config.MQTT_URL, { reconnectPeriod: 5000 });

  client.on("connect", () => client.subscribe(config.MQTT_TOPIC));
  client.on("error", (err) => logger.warn({ err: err.message }, "mqtt.error"));
  client.on("message", (_topic, raw) => {
    void handleStreamMessage({
      raw,
      appSecret: config.APP_SECRET,
      geocode,
      ingest: (event) => journeyService.ingestTelemetry(event),
      live
    }).catch((error) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, "mqtt.ingest_error"));
  });

  return { stop: async () => void (await client.endAsync()) };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run apps/api/test/mqttTelemetryConsumer.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/telemetry/mqttTelemetryConsumer.ts apps/api/test/mqttTelemetryConsumer.test.ts apps/api/package.json package-lock.json
git commit -m "feat(telemetry): MQTT streaming consumer feeding ingestTelemetry"
```

---

## Task 6: REST poller stands down while streaming is fresh

**Files:**
- Modify: `apps/api/src/telemetry/teslaFleetPoller.ts`
- Test: `apps/api/test/tesla.test.ts`

- [ ] **Step 1: Write the failing test** (append to the poller `describe` in `tesla.test.ts`):

```ts
  it("skips the poll tick when streaming is fresh", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      resolveVehicleId: async () => "1",
      hasActiveJourney: () => true,
      streamingIsFresh: () => true, // streaming live → must not call the API
      ingest: async () => {},
      geocode: async () => undefined,
      appSecret: "s",
      fetchImpl
    });
    expect(calls).toHaveLength(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/api/test/tesla.test.ts`
Expected: FAIL — `streamingIsFresh` not in `PollDeps`; tick still calls the API.

- [ ] **Step 3: Implement** — add `streamingIsFresh?: () => boolean;` to `PollDeps`, and at the very top of `pollTeslaOnce` after the active-journey guard:

```ts
  if (deps.streamingIsFresh?.()) return; // streaming is live → no REST call needed
```

Then wire it in `startTeslaFleetPoller` (it receives the shared `StreamLiveness` + config):

```ts
        streamingIsFresh: () =>
          !shouldPollRest(liveness.lastIso(), Date.now(), config.STREAM_FRESH_WINDOW_SECONDS * 1000),
```

Add imports to the poller: `import { shouldPollRest, StreamLiveness } from "./streamSource.js";` and accept `liveness: StreamLiveness` as a new parameter of `startTeslaFleetPoller`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/api/test/tesla.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/telemetry/teslaFleetPoller.ts apps/api/test/tesla.test.ts
git commit -m "feat(telemetry): REST poller stands down while streaming is fresh"
```

---

## Task 7: Telemetry-config registration admin endpoint

**Files:**
- Modify: `apps/api/src/auth/teslaAuth.ts`, `apps/api/src/journeys/routes.ts` (or `apps/api/src/app.ts` where partner registration lives)
- Test: `apps/api/test/tesla.test.ts`

- [ ] **Step 1: Write the failing test** (model after the partner-registration test; uses a fetch fake on the auth service):

```ts
  it("registerTelemetryConfig POSTs ca + fields to the fleet_telemetry_config endpoint", async () => {
    const captured: { url: string; body: any }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ response: { updated_vehicles: 1 } }), { status: 200 });
    };
    const { service } = makeTeslaAuthForTest(fetchImpl); // existing helper pattern in this file
    const res = await service.registerTelemetryConfig({ caPem: "CA", hostname: "telemetry.test", port: 4443 });
    expect(res.ok).toBe(true);
    expect(captured[0].url).toContain("/api/1/vehicles/fleet_telemetry_config");
    expect(captured[0].body.ca).toBe("CA");
    expect(captured[0].body.fields.VehicleSpeed.interval_seconds).toBe(5);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/api/test/tesla.test.ts`
Expected: FAIL — `registerTelemetryConfig` not defined.

- [ ] **Step 3: Implement `registerTelemetryConfig` in `TeslaAuthService`** (uses the existing partner token + the v1 field/interval/delta table from the spec):

```ts
  async registerTelemetryConfig(opts: { caPem: string; hostname: string; port: number }): Promise<{ ok: boolean; status: number; body: string }> {
    const token = await this.getPartnerToken();
    const fields = {
      VehicleSpeed: { interval_seconds: 5, minimum_delta: 3 },
      LongitudinalAcceleration: { interval_seconds: 2, minimum_delta: 0.8 },
      BrakePedal: { interval_seconds: 1 },
      LightsHazardsActive: { interval_seconds: 1 },
      Location: { interval_seconds: 30, minimum_delta: 250 },
      MinutesToArrival: { interval_seconds: 60 },
      RouteTrafficMinutesDelay: { interval_seconds: 60 },
      Soc: { interval_seconds: 60 },
      OutsideTemp: { interval_seconds: 300, minimum_delta: 1 }
    };
    const body = JSON.stringify({ hostname: opts.hostname, port: opts.port, ca: opts.caPem, fields });
    const url = `${this.config.TESLA_API_BASE_URL.replace(/\/$/, "")}/api/1/vehicles/fleet_telemetry_config`;
    const response = await this.fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }

  async deleteTelemetryConfig(): Promise<{ ok: boolean; status: number }> {
    const token = await this.getPartnerToken();
    const url = `${this.config.TESLA_API_BASE_URL.replace(/\/$/, "")}/api/1/vehicles/fleet_telemetry_config`;
    const response = await this.fetchImpl(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    return { ok: response.ok, status: response.status };
  }
```

(Use the same `this.fetchImpl` the service already uses for testability; if the service currently uses global `fetch`, add a `setFetchForTest` like the existing pattern.)

- [ ] **Step 4: Add the admin route** (next to `/auth/tesla/register-partner`):

```ts
  app.post("/auth/tesla/register-telemetry", async (_request, reply) => {
    if (!config.TESLA_PUBLIC_KEY_PEM || !config.TESLA_TELEMETRY_CA_PEM) {
      return reply.code(400).send({ ok: false, error: "TESLA_TELEMETRY_CA_PEM not configured." });
    }
    const result = await teslaAuth.registerTelemetryConfig({
      caPem: config.TESLA_TELEMETRY_CA_PEM,
      hostname: config.TESLA_TELEMETRY_HOST,
      port: config.TESLA_TELEMETRY_PORT
    });
    return reply.code(result.ok ? 200 : 502).send(result);
  });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run apps/api/test/tesla.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/teslaAuth.ts apps/api/src/journeys/routes.ts apps/api/src/app.ts apps/api/test/tesla.test.ts
git commit -m "feat(tesla): telemetry-config register/delete admin endpoint"
```

---

## Task 8: Config + bootstrap swap (MQTT in, Kafka out)

**Files:**
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/index.ts`, `apps/api/package.json`, `.env.example`
- Delete: `apps/api/src/telemetry/kafkaConsumer.ts`
- Test: `apps/api/test/env.test.ts`

- [ ] **Step 1: Write the failing env test** (append to `env.test.ts`):

```ts
  it("provides MQTT + stream-window config with defaults", () => {
    const config = loadConfig({});
    expect(config.MQTT_URL).toBe("mqtt://localhost:1883");
    expect(config.MQTT_TOPIC).toBe("tesla/telemetry");
    expect(config.STREAM_FRESH_WINDOW_SECONDS).toBe(90);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/api/test/env.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `env.ts`** — replace the Kafka knobs (`KAFKA_BROKERS`, `TESLA_TELEMETRY_TOPIC`, and the derived `kafkaBrokers`) with:

```ts
  MQTT_URL: z.string().default("mqtt://localhost:1883"),
  MQTT_TOPIC: z.string().default("tesla/telemetry"),
  STREAM_FRESH_WINDOW_SECONDS: z.coerce.number().int().min(10).default(90),
  TESLA_TELEMETRY_CA_PEM: z.string().default(""),
  TESLA_TELEMETRY_HOST: z.string().default(""),
  TESLA_TELEMETRY_PORT: z.coerce.number().int().default(4443),
```

(Remove the `kafkaBrokers` field from the returned object in `loadConfig`.)

- [ ] **Step 4: Update `index.ts`** — replace the Kafka consumer bootstrap:

```ts
import { startMqttTelemetryConsumer } from "./telemetry/mqttTelemetryConsumer.js";
import { StreamLiveness } from "./telemetry/streamSource.js";
// ...
const streamLiveness = new StreamLiveness();
const mqttConsumer = startMqttTelemetryConsumer(config, journeyService, streamLiveness, app.log);
const teslaPoller = startTeslaFleetPoller(config, store, teslaAuth, journeyService, streamLiveness, app.log);
// in SIGTERM:
if (mqttConsumer) await mqttConsumer.stop();
```

Delete the `startTelemetryConsumer` import + call and the file `apps/api/src/telemetry/kafkaConsumer.ts`. Remove `kafkajs` from `apps/api/package.json`.

- [ ] **Step 5: Run env test + typecheck**

Run: `npx vitest run apps/api/test/env.test.ts && npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: PASS + `TypeScript compilation completed`

- [ ] **Step 6: Update `.env.example`** — drop `KAFKA_BROKERS`/`TESLA_TELEMETRY_TOPIC`; add:

```
# Fleet Telemetry streaming (set TESLA_TELEMETRY_ENABLED=true; see docs/deployment.md)
MQTT_URL=mqtt://mosquitto:1883
MQTT_TOPIC=tesla/telemetry
STREAM_FRESH_WINDOW_SECONDS=90
TESLA_TELEMETRY_HOST=telemetry.aijourneydj.ruhrco.de
TESLA_TELEMETRY_PORT=4443
TESLA_TELEMETRY_CA_PEM=
```

- [ ] **Step 7: Commit**

```bash
git rm apps/api/src/telemetry/kafkaConsumer.ts
git add -A
git commit -m "feat(api): bootstrap MQTT streaming consumer; remove Kafka path"
```

---

## Task 9: Expose + show `telemetrySource`

**Files:**
- Modify: `apps/api/src/db/store.ts` (`contextFromJourney` accepts source), `apps/api/src/journeys/routes.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/App.tsx`
- Test: `apps/api/test/telemetryReceivedAt.test.ts` (context already tested there)

- [ ] **Step 1: Write the failing test** (append to the existing context test file):

```ts
  it("contextFromJourney carries the telemetry source", () => {
    const journey = makeJourney();
    const ctx = contextFromJourney(journey, undefined, [], "streaming");
    expect(ctx.telemetrySource).toBe("streaming");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/api/test/telemetryReceivedAt.test.ts`
Expected: FAIL — `contextFromJourney` takes 3 args.

- [ ] **Step 3: Implement** — add a 4th optional param to `contextFromJourney(journey, telemetry?, recentTelemetry?, telemetrySource?)` and set `telemetrySource` on the returned context. In the journey-detail route, pass the source derived from liveness:

```ts
const source = !shouldPollRest(streamLiveness.lastIso(), Date.now(), config.STREAM_FRESH_WINDOW_SECONDS * 1000) ? "streaming" : "polling";
const ctx = contextFromJourney(journey, store.latestTelemetry(id), store.recentTelemetry(id), source);
// expose in context block:
telemetrySource: ctx.telemetrySource,
```

(The route needs access to the shared `streamLiveness`; pass it into `registerJourneyRoutes`.)

- [ ] **Step 4: Web** — add `telemetrySource?: "streaming" | "polling"` to `JourneyDetail.context` in `apps/web/src/lib/api.ts`; in `App.tsx` upgrade the live badge label:

```tsx
{liveness.state === "live" ? (detail?.context?.telemetrySource === "streaming" ? "Live (Streaming)" : liveness.label) : ...}
```

- [ ] **Step 5: Verify**

Run: `npx vitest run apps/api/test/telemetryReceivedAt.test.ts && npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS + `TypeScript compilation completed`

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/store.ts apps/api/src/journeys/routes.ts apps/web/src/lib/api.ts apps/web/src/App.tsx apps/api/test/telemetryReceivedAt.test.ts
git commit -m "feat: surface telemetrySource (streaming vs polling) in context + badge"
```

---

## Task 10: Full verification

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 2: Typechecks + web build**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json && npm run build:bundle -w @ai-journey-dj/web`
Expected: compilation completed + bundle built.

- [ ] **Step 3: Commit any fixups** (if needed)

```bash
git add -A && git commit -m "test: full verification for fleet telemetry streaming"
```

---

## Task 11: OPS — Coolify stack, mTLS, registration (manual, documented — NOT unit-tested)

**Files:**
- Modify: `docs/deployment.md` (new "Fleet Telemetry streaming" section)

This task produces documentation + a verification checklist; it is executed by hand against the live Coolify deployment, not by tests.

- [ ] **Step 1: Document CA + server cert generation**

```bash
# CA (validates the car's client cert)
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -days 3650 -subj "/CN=Ai Journey DJ Telemetry CA" -out ca.crt
# Server cert for telemetry.<domain> — use a publicly trusted cert (Let's Encrypt) so the car trusts it.
```

- [ ] **Step 2: Document the two new Coolify services** (compose snippets in the doc):
  - `fleet-telemetry` (image `tesla/fleet-telemetry`), config.json with `tls{server_cert,server_key}` + `mqtt` dispatcher (`broker: tcp://mosquitto:1883`, `topic: tesla/telemetry`), exposed on a dedicated port (e.g. 4443).
  - `mosquitto` (image `eclipse-mosquitto`), internal only, anonymous listener on 1883 within the Coolify network.

- [ ] **Step 3: Document Traefik TCP passthrough / SNI** for `telemetry.<domain>:4443` → fleet-telemetry container (TLS must NOT be terminated by Traefik). Include the exact Coolify label / port-mapping.

- [ ] **Step 4: Document registration** — set `TESLA_TELEMETRY_CA_PEM` (contents of `ca.crt`), `TESLA_TELEMETRY_HOST`, `TESLA_TELEMETRY_PORT`, `TESLA_TELEMETRY_ENABLED=true`; redeploy; then:

```bash
curl -XPOST -u USER:PASS https://aijourneydj.ruhrco.de/auth/tesla/register-telemetry
# expect {"ok":true,"status":200,...}
```

- [ ] **Step 5: Verification checklist** (in the doc):
  - fleet-telemetry logs show the vehicle's mTLS connection.
  - Mosquitto receives messages on `tesla/telemetry` while driving.
  - App logs: no `mqtt.error`; journey context shows `telemetrySource: "streaming"`; badge reads "Live (Streaming)".
  - Park the car → stream stops → within `STREAM_FRESH_WINDOW_SECONDS` the REST poller resumes (fallback).
  - Tesla usage dashboard: streaming signals accrue at fractions of a cent on a calm cruise.

- [ ] **Step 6: Commit**

```bash
git add docs/deployment.md
git commit -m "docs: Fleet Telemetry streaming setup (Coolify, mTLS, registration, verification)"
```

---

## Notes for the implementer

- **Reuse, don't rebuild:** `ingestTelemetry`, ADM, reconciliation, the live badge, and the geocoder are unchanged — streaming is just a new front-end source plus the `shouldPollRest` gate.
- **Privacy invariant:** `normalizeFleetStream` must return raw GPS only as transient `coordinates`; it is geocoded then dropped, never persisted or sent to the AI (mirrors `normalizeFleetVehicleData`).
- **Read-only invariant:** the telemetry-config endpoints are config writes, not vehicle commands; nothing here wakes the car.
- **Cost invariant:** the `minimum_delta` values in `registerTelemetryConfig` are the cost lever — keep them when tuning intervals.
