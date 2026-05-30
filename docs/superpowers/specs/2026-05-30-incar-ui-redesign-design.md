# In-Car UI Redesign — Next Level

**Date:** 2026-05-30
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `apps/web` (UI) + two read-only fields on `GET /journeys/:id`

## Goal

Bring the AI Journey DJ interface to the next level: keep it intuitive and clean, but
surface more useful information and make it safely operable in the car (Tesla landscape
touchscreen). Concretely: **eliminate free-text typing for mood**, and make the live drive
context + personalization visible at a glance.

## Constraints & Decisions

- **Planning happens while parked.** Destination free-text is acceptable; mid-drive
  re-steering must stay tap-only (phase rail + vibe-mix already cover this).
- **No free-text mood.** Replaced by curated mood preset tiles.
- **Surface:** Live drive context + Personalization (chosen by user). NOT per-track "why"
  reasons or per-track lens-source labels (keeps it clean).
- **Aesthetic:** Evolve the existing glass/ambient cockpit (Approach A) — no rewrite.
- **Language:** Unify UI copy to English; the German vibe-mix labels become
  Familiar / Balanced / Discover, overlay "Adjusting mix".
- **No new external API calls.** New info comes from existing DB state.

## Section 1 — Setup screen (parked planning)

Replace the `Mood & direction` `<textarea>` with a 6-tile **mood preset grid**
(single-select, default `cinematic`). Each preset maps to a ready-made prompt string fed to
the recommendation engine as `userPrompt`:

| key | label | icon | prompt |
|---|---|---|---|
| cinematic | Cinematic | Sunset | cinematic, widescreen, emotional but focused drive |
| focused | Focused | Crosshair | calm focused flow, low-distraction, steady |
| euphoric | Euphoric | Sparkles | uplifting, high-energy, feel-good momentum |
| mellow | Mellow | Coffee | relaxed, warm, easygoing cruise |
| nostalgic | Nostalgic | Disc3 | nostalgic throwback warmth, timeless feel |
| adventure | Adventure | Mountain | bold, driving, sense of adventure and discovery |

- **Destination:** keeps the text input (parked), with **quick-pick chips of recent
  destinations** (from `history`) above it so re-selecting is tap-only.
- Passenger-mode segments and CTA unchanged; larger tap targets, clearer hierarchy.

## Section 2 — Cockpit

- **Live-context strip:** one glanceable row under the stage head with compact pills for
  **Phase · Tempo · ETA · Weather-feel · Region**. Each pill renders only when its value
  exists (Phase + Region always present; Tempo/ETA/Weather hidden when telemetry is absent).
- **Personalization panel:** in the rail, near the vibe-mix — shows the active vibe label and
  the influencing **top genres** ("Genres: electronica · indie · …") so the personal feel is
  explained.
- Enlarge transport / control tap targets toward the `--tap: 64px` token; tighten hierarchy.

## Section 3 — Data flow & components

- **Mood presets:** pure module `apps/web/src/lib/moods.ts` exports `MOOD_PRESETS`
  (`key`, `label`, `Icon`, `prompt`). `App` holds `selectedMood` (default `cinematic`) and
  sends `userPrompt = preset.prompt` on start. **Backend contract unchanged** (still a
  `userPrompt` string). Existing journeys keep their stored prompt.
- **Live context + taste:** `GET /journeys/:id` gains two read-only fields:
  - `context`: privacy-safe subset via existing `contextFromJourney(journey, store.latestTelemetry(id))`
    → `{ phase, speedBucket, etaMinutes, temperatureBucket, coarseRegion, localTimeIso }`.
  - `taste`: `store.getCachedTasteProfile("local")` → only `{ topGenres }` exposed to the client.
- `apps/web/src/lib/api.ts` `JourneyDetail` type gains optional `context` and `taste`.
  Rendering reads these; missing values hide the pill/panel.

## Section 4 — Error handling & edge cases

- Pills with no value are not rendered; the personalization panel is hidden when
  `taste.topGenres` is empty. In demo/mock mode the mock adapter supplies genres, so the
  panel is visible there too.
- `context` and `taste` are pure DB reads — no new external calls, no added latency.
- Speed/ETA/weather are commonly absent (telemetry disabled) → strip degrades to
  Phase + Region without looking broken.

## Testing (TDD)

- `moods.ts`: unit test — every preset has `key`/`label`/`prompt`; `key → prompt` mapping is stable.
- Backend: `GET /journeys/:id` returns `context.phase` and (in mock, after analysis) `taste.topGenres`.
- Existing suite stays green; the vibe-mix label change touches only UI strings (no test impact).

## Out of scope

- Voice input; 2-axis mood pad; mid-drive mood re-selection; per-track reason/lens labels;
  any change to the recommendation engine or playback pipeline.
