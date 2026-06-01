# Adaptive Drive Mode (Calm / Focus)

**Date:** 2026-06-01
**Status:** Approved (design) — pending implementation plan

## Summary

A telemetry-driven **selection** controller that biases the soundtrack toward calmer, familiar,
instrumental-leaning music in higher-stress driving situations (heavy traffic, range anxiety, harsh
cold) and toward more engaging music during monotonous night highway stretches. It extends the
existing trend-aware Musical Brief — it does **not** control volume, DSP, or the audio signal.

**Framing:** comfort/ambience, **not** a safety or driver-assistance system. No claims about reducing
cognitive load or improving attention. A disclaimer states this in UI and docs.

## Why (origin)

User idea ("Cognitive Safety Controller"): adapt the acoustic environment to driving conditions. The
original concept assumed control we do not have. Reality check against the stack:

- Tesla integration is **read-only** — we cannot set volume, apply DSP, or limit BPM. Spotify also
  deprecated the audio-features (tempo/BPM) endpoint for new apps.
- We poll `vehicle_data` every 45–120s — not real-time; sudden events are unreliable.
- The Fleet **Telemetry streaming** spec exposes richer/real-time fields (acceleration, brake pedal),
  but requires heavy Kafka/broker/TLS infra — out of scope for a single-user self-hosted app.
- There is **no autopilot-engaged field** and **no rain/wiper-activity field**, even in streaming.

What we *can* do: shift track **selection** via the existing deterministic Musical Brief + adaptive
lens selection, using REST `vehicle_data` signals.

## Decisions (locked in brainstorming)

- **Framing:** comfort/ambience, with a "not a safety system" disclaimer.
- **Triggers (v1):** stop-and-go/heavy traffic, night long-haul monotony, range anxiety (low battery),
  cold-weather proxy (honestly labeled as weak).
- **Intervention:** noticeable but no hard-cut — re-curate on the next poll cycle, let the current
  track finish, hysteresis against flapping.
- **Control:** automatic, with a per-journey master toggle and a transparency chip showing *why*.
- **Data path:** REST `vehicle_data` only (no streaming). Add the new high-value polled fields.
- **Gemini:** detection stays deterministic; Gemini "optimizes" only the song *selection* via a
  plain-text drive-state line injected into the existing lens prompts (no extra LLM calls).

## New telemetry fields (REST `vehicle_data`)

Extend `NormalizedTelemetryEvent` and `normalizeFleetVehicleData`:

| Field | Source | Use |
|---|---|---|
| `trafficDelayMinutes` | `drive_state.active_route_traffic_minutes_delay` | real congestion signal (stop-and-go) |
| `energyPercentAtArrival` | `drive_state.active_route_energy_at_arrival` | true range-anxiety ("arrive at 6%") |
| `audioVolume` | `media_info.audio_volume` (0–11, read-only) | calm reinforcement when user turns it down |

Missing fields (no route set, no media) → `undefined`; the corresponding rule simply does not fire.

## Architecture & data flow

New pure module `packages/recommendation/src/driveState.ts`:

```
assessDriveState(recentTelemetry[], localTimeIso) → DriveStateAssessment
  { mode: "calm" | "focus" | "neutral", reason: string, intensity: number /*0..1*/, signals: string[] }
```

Zero-token, deterministic, unit-testable — same philosophy as the Musical Brief.

```
spotifyPlaybackPoller / 60s worker (every 45–120s)
   │  recentTelemetry + local time
   ▼
assessDriveState() ── hysteresis (state must hold 2 polls) ──┐ no change → do nothing
   │ mode changed?                                           ▼ (current track finishes; no hard-cut)
   ▼
buildMusicalBrief(context, assessment)   ← override layer (energy/intensity/familiarity shift)
   ▼
selectJourneyLenses() + lens prompts     ← drive-state plain-text line → Gemini refines picks
   ▼
analyzeJourney(reason="drive-state:calm")  → new curated tracks appended to the queue
   ▼
assessment in journey detail context → cockpit chip "Calm · heavy traffic"
```

Orthogonal to journey phase (you can be in `golden_hour` *and* calm-due-to-traffic). Reuses the
existing poller, brief, lens selection, and `analyzeJourney` — no new subsystem, no new timer.

## Drive-state classifier rules

Evaluated in order; first match wins. **Calm takes priority over focus.** Each rule supplies a
`reason` and `signals` for the chip/tooltip.

```
1. CALM · "heavy traffic"
   trafficDelayMinutes >= 8
   intensity = clamp01(trafficDelayMinutes / 30)            // 8 → light, 30+ → strong

2. CALM · "low range"
   energyPercentAtArrival <= 10            (route set)
   OR batteryPercent < 15                  (no route)
   intensity = higher the tighter

3. CALM · "wintry conditions"   (weak proxy, labeled honestly)
   outsideTempC <= 0
   intensity = 0.4 (fixed, gentle)

4. FOCUS · "long night drive"
   local time 22:00–05:00  AND  speedKph >= 90  AND  paceTrend == "steady"  AND  etaMinutes >= 45
   intensity = 0.5

5. else NEUTRAL
```

**Amplifier (not a standalone trigger):** if `audioVolume` drops noticeably between polls while a
calm state is active, raise its `intensity` by +0.15 ("you want it quieter, I'll go with it").

**Hysteresis:** a non-neutral mode engages only after holding **2 consecutive polls**; it disengages
only after its trigger is absent for **2 consecutive polls**. Prevents flapping on a single traffic
light or brief speed dip.

**Deliberately excluded (honesty):** rain/wipers (no field), autopilot deactivation (no field),
second-accurate stop-and-go (needs streaming).

## Brief / lens modification

`buildMusicalBrief(context, assessment?)` applies an override before Gemini runs:

```
CALM (scaled by intensity):
  targetEnergy -= 0.20 * intensity
  intensity field → "warm" / "resolving"
  tasteWeight    → +0.15 toward Familiar
  moodWords      += ["calm", "warm", "instrumental-leaning"]
  lens bias      → cinematic_warmth + timeless_anchor (drop leftfield_bridge)

FOCUS:
  targetEnergy += 0.12
  moodWords    += ["alert", "engaging", "forward"]
  lens bias    → prioritize steady_momentum
```

**Gemini refinement:** the assessment is injected as a plain-text line into the existing lens
prompts, e.g. *"Driving context: heavy traffic, ~14 min delay. Favor calmer, familiar,
instrumental-leaning tracks; avoid frantic or dense arrangements."* No extra LLM calls (the line
rides on prompts that already run); detection stays deterministic.

**Cost protection:** a state change is a vibe-changing reason, so `analyzeJourney` may generate once,
then reuses the pool; the existing refill throttle still applies.

## Control, transparency, disclaimer

- Per-journey `adaptiveModeEnabled` (default `true`) + global `ADAPTIVE_DRIVE_MODE_ENABLED=true`.
  When off, `assessDriveState` is skipped and the engine behaves as today.
- Journey detail context exposes `driveMode: { mode, reason }`. Cockpit shows a chip
  (`🫧 Calm · heavy traffic` / `🌙 Focus · night drive`); none when neutral. Tooltip lists `signals`.
- Disclaimer at the toggle and in README/spec: *"Comfort feature — adapts music to the driving
  situation. Not a safety or driver-assistance system."*

## Error handling

Best-effort, never throws. Missing route/media fields → rule doesn't fire. Assessment failures are
logged and treated as `neutral`.

## Testing (Vitest, pure where possible)

1. `assessDriveState`: traffic ≥ 8 min → calm + reason; higher delay → higher intensity.
2. energyPercentAtArrival ≤ 10 → calm "low range"; battery < 15 without route → calm.
3. Night + highway + steady + ETA ≥ 45 → focus; same values in daytime → neutral.
4. Calm beats focus when both would match.
5. Hysteresis: 1 poll → still neutral; 2 polls → engaged; trigger gone 1 poll → still active; 2 → off.
6. Volume drop amplifies an active calm state (intensity +0.15).
7. `buildMusicalBrief` with calm assessment → lower targetEnergy + calm moodWords; focus → higher.
8. Lens prompt contains the drive-state plain-text line.
9. `normalizeFleetVehicleData` maps `trafficDelayMinutes` / `energyPercentAtArrival` / `audioVolume`;
   missing → undefined.
10. Toggle off → assessment skipped, brief unchanged.

## Affected files

- New: `packages/recommendation/src/driveState.ts` + test
- Extended: `packages/core` (`NormalizedTelemetryEvent` + `DriveStateAssessment` type),
  `packages/telemetry` (`normalizeFleetVehicleData`),
  `packages/recommendation` (`buildMusicalBrief`, `selectJourneyLenses`, lens prompts),
  `apps/api/src/db/store.ts` (persist new telemetry fields; expose `driveMode` in detail),
  `apps/api/src/db/database.ts` (columns), `apps/api/src/journeys/routes.ts` (context + toggle),
  `apps/api/src/journeys/journeyService.ts` (assess + trigger re-curation), `apps/api/src/config/env.ts`
  (`ADAPTIVE_DRIVE_MODE_ENABLED`), web `App.tsx` + `lib/api.ts` + `lib/driveContext.ts` (chip + toggle),
  `README.md` (positioning + disclaimer).

## Out of scope (future)

- Fleet Telemetry **streaming** for real-time acceleration/brake signals (v2, behind a flag).
- Using `MediaNowPlaying*` / `MediaPlaybackSource` to strengthen external-skip reconciliation (adjacent win).
- A real weather API instead of the outside-temperature proxy.
