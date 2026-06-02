# Fleet Telemetry Streaming (real-time, self-hosted, no Kafka)

**Date:** 2026-06-02
**Status:** Approved (design) — pending implementation plan

## Summary

Replace REST polling (45–120 s) as the *primary* telemetry source with Tesla **Fleet Telemetry**
streaming: the vehicle pushes per-field, on-change data over mTLS to a self-hosted
`fleet-telemetry` (Go) server, which publishes to a tiny **MQTT** broker; our API consumes it and
feeds the existing `ingestTelemetry` pipeline. REST polling stays as an automatic **fallback**.

Goal: near-real-time adaptation (phase/ADM/reconciliation react in seconds, not minutes) and new
real-time signals (`LongitudinalAcceleration`, `BrakePedal`, `LightsHazardsActive`) that unlock true
stop-and-go / hard-brake detection. Cost is negligible (~€0.06–0.38 / 10 h, cheaper than polling).

Read-only and privacy-preserving as before: raw GPS is reverse-geocoded to a coarse region
server-side and discarded; never sent to the LLM.

## Decisions (locked in brainstorming)

- **Ingestion topology:** self-host Tesla's official `fleet-telemetry` Go server. **No Kafka.**
- **Sink:** **MQTT** (Mosquitto broker + `mqtt.js` consumer — pure-JS, no native build).
- **Coexistence:** streaming is primary; REST polling is an automatic fallback (asleep / old
  firmware / connection gaps / before first connect).
- **Fields (v1):** core + real-time driving signals.
- **Framing:** the new ADM real-time triggers stay a comfort feature, not a safety system.

## Topology

Three Coolify services on the same internal network:

```
        mTLS/gRPC (TLS terminates AT the Go server — NOT Traefik)
 Tesla ───────────────────────────────►  [fleet-telemetry]  (Tesla's Go image)
 (car)                                          │ MQTT publish
                                                ▼
                                         [mosquitto]  (MQTT broker, internal only, ~10 MB)
                                                │ subscribe (mqtt.js)
                                                ▼
                                         [api]  (our container)
                                           └─ mqttConsumer → normalizeFleetStream → ingestTelemetry
                                              (same pipeline as REST → ADM / reconciliation / badge)
```

- `fleet-telemetry`: publicly reachable (e.g. `telemetry.aijourneydj.ruhrco.de`), holds the server
  cert + CA, sink = MQTT.
- `mosquitto`: not public (Coolify network only).
- `api`: gains an MQTT consumer (replaces the Kafka stub); everything else unchanged.

**Critical infra subtlety:** mTLS must terminate **at the Go server** — Traefik must not break TLS in
between (it would strip the client cert). Use **TCP passthrough / SNI** to the fleet-telemetry
container, or a dedicated port. Our existing app + its Traefik Basic Auth are on a separate host/port
and are unaffected.

## mTLS + telemetry-config registration (one-time per vehicle)

```
1. Generate a CA keypair (openssl) → ca.crt / ca.key
2. Server cert valid for telemetry.<domain> (+ server_key) held by fleet-telemetry
3. fleet-telemetry config.json: { host, port, tls{server_cert,server_key}, mqtt{broker,topic},
   records:{fields + intervals} }
4. POST /api/1/vehicles/fleet_telemetry_config (Fleet API, signed) with { ca, hostname, port, fields }
5. Tesla provisions the car → it connects via mTLS and streams.
```

- The **car** trusts our **server cert** (domain must match); our server validates the car's
  **client cert** against the **CA** we registered.
- New API surface in `TeslaAuthService` + routes: `registerTelemetryConfig()` and
  `deleteTelemetryConfig()` (max 3 configs/vehicle — needed when iterating). Exposed as an
  admin endpoint `POST /auth/tesla/register-telemetry` (behind Basic Auth), invoked once like the
  existing partner registration. Config write — no command, no wake-up.
- Documented step-by-step in `docs/deployment.md` (CA → services → register → verify).

**Honest risks:** (a) Coolify/Traefik TCP passthrough is the most likely snag; (b) firmware 2024.26+
required (some Intel-MCU need 2025.20+); (c) misconfig burns one of the 3 config slots — delete old
ones.

## Source switching (streaming primary + REST fallback)

Single source of truth: `ingestTelemetry`. Both sources feed it; ADM / reconciliation / badge
untouched.

```
MQTT consumer (mqtt.js):
  on message → normalizeFleetStream(payload) → markStreamingAlive(now) → ingestTelemetry(event)

REST poller (existing, cost-optimized):
  tick → if (now - lastStreamingAt) < STREAM_FRESH_WINDOW (default 90 s) → SKIP  (streaming is live)
         else → poll as before (fallback)
```

Pure, testable decision function:
```
shouldPollRest(lastStreamingAtIso, nowMs, freshWindowMs) → boolean
```
`lastStreamingAt` is small in-memory service state (no DB field).

`telemetrySource: "streaming" | "polling"` is exposed in the journey detail context → the live badge
shows `🛰 Live (Streaming)` vs `Polling` — an honest "real-time is active" indicator.

## Normalization

`normalizeFleetStream(payload)` maps the streaming schema (different field names than REST
`vehicle_data` — e.g. `VehicleSpeed` in mph, `Location` instead of `drive_state.latitude/longitude`)
onto the same `NormalizedTelemetryEvent`. Reuses/extends the existing `normalizeTeslaPayload`.
Geocoding (Location → coarse region) stays server-side; raw GPS is discarded.

### New fields (v1)

Add to `NormalizedTelemetryEvent`:
- `longitudinalAccelMps2` ← `LongitudinalAcceleration`
- `brakePedal` (boolean) ← `BrakePedal`
- `hazardsActive` (boolean) ← `LightsHazardsActive`

Core context fields (speed, ETA, traffic delay, battery, temp, location→region) continue as today.

### Field intervals + cost control (registered in the telemetry config)

Cost scales with how much the drive *changes*, not with its duration — Fleet Telemetry is on-change,
not fixed-poll. Two config levers keep a 10 h drive in the cents:

- **`minimum_delta` per field (the primary cost lever):** emit only when the value actually changes
  by at least the delta. A steady 2 h highway cruise (speed stable, ETA ticking slowly) emits a
  trickle; a parked/asleep car emits nothing (€0). This is strictly cheaper than fixed REST polling.
- **`interval_seconds`:** caps the *maximum* emit frequency (a rate limit); it does NOT force
  emission.

v1 settings:

| Field | interval_seconds (max) | minimum_delta |
|---|---|---|
| `VehicleSpeed` | 5 | ±3 km/h |
| `LongitudinalAcceleration` | 2 | ±0.8 m/s² |
| `BrakePedal` / `LightsHazardsActive` | on-change | (boolean) |
| `Location` | 30 | ~250 m |
| ETA / traffic / battery | 30–60 | 1 unit |
| `OutsideTemp` | 300 | ±1 °C |

Result: ~hundreds of signals on a calm 2 h cruise (fractions of a cent); low cents on a dynamic
10 h drive; €0 when parked. Far below the per-account monthly credit.

## Adaptive Drive Mode — real-time triggers (extension)

Only active when the source is streaming (REST lacks these fields). Pure extension of
`assessDriveState` — new rules, same structure, same comfort framing (no safety claim), same
hysteresis + no-hard-cut:

- **Stop-and-go (calm):** frequent brake/accel cycles in a short window (from `brakePedal` toggles +
  low, oscillating speed) → seconds-accurate complement to the existing traffic-delay trigger.
- **Hard-brake / hazard moment (calm, strong):** `hazardsActive` or strongly negative
  `longitudinalAccelMps2` → briefly calm.

## Lifecycle / config

- `startMqttTelemetryConsumer(config, journeyService, logger)` starts alongside the REST poller
  (only when `TESLA_TELEMETRY_ENABLED`); clean disconnect on SIGTERM.
- New config: `MQTT_URL`, `MQTT_TOPIC`, `STREAM_FRESH_WINDOW_SECONDS=90` (`TESLA_TELEMETRY_ENABLED`
  already exists). The Kafka consumer + `KAFKA_BROKERS`/`TESLA_TELEMETRY_TOPIC` are replaced/removed.
- mqtt.js auto-reconnects; if the broker/stream drops, `lastStreamingAt` goes stale and REST takes
  over. Never crashes, always has data.

## Testing (Vitest, pure where possible)

1. `normalizeFleetStream`: streaming payload (mph→kph, Location→coordinates, accel/brake/hazards) →
   `NormalizedTelemetryEvent`; missing fields → undefined.
2. `shouldPollRest`: fresh stream → false; stale → true; never negative on clock skew.
3. ADM real-time rules: brake cycles → calm; hazard → calm (strong); no streaming fields → no new trigger.
4. MQTT consumer: a fake message calls `ingestTelemetry` and sets `lastStreamingAt` (broker injected).
5. `telemetrySource` is correct in the context.

**Not unit-tested (infra — documented + manually verified):** the Go server, mTLS handshake,
Mosquitto, Coolify TCP passthrough. A verification checklist lives in the docs (CA → config → first
stream in the log).

## Affected files

- New: `apps/api/src/telemetry/mqttTelemetryConsumer.ts` (+ test), `apps/api/src/telemetry/streamSource.ts`
  (`shouldPollRest`, in-memory liveness) (+ test).
- Extended: `packages/telemetry` (`normalizeFleetStream` + new fields) (+ test),
  `packages/core` (`NormalizedTelemetryEvent` new fields, `telemetrySource`),
  `packages/recommendation/src/driveState.ts` (real-time rules) (+ test),
  `apps/api/src/telemetry/teslaFleetPoller.ts` (skip when streaming fresh),
  `apps/api/src/auth/teslaAuth.ts` + `apps/api/src/journeys/routes.ts` (telemetry-config register/delete),
  `apps/api/src/config/env.ts` (MQTT_* + STREAM_FRESH_WINDOW_SECONDS), `apps/api/src/index.ts` (bootstrap),
  `apps/api/src/db/store.ts` + `routes.ts` (expose `telemetrySource`), web badge (`App.tsx`, `lib/api.ts`).
- Removed/deprecated: `apps/api/src/telemetry/kafkaConsumer.ts` + Kafka env knobs.
- Ops: `docs/deployment.md` (3-service Coolify stack, CA, mTLS, config registration, verification),
  Compose/Coolify service definitions for `fleet-telemetry` + `mosquitto`.

## Out of scope (future)

Multi-vehicle, additional streaming fields, a streaming-health dashboard.
