# In-Car UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-text mood input with curated mood presets and surface live drive context + personalization in the cockpit, keeping the UI clean and in-car operable.

**Architecture:** Pure, unit-tested helper modules on the web side (`moods.ts`, `context.ts`) feed React rendering in `App.tsx`. Two read-only fields (`context`, `taste`) are added to `GET /journeys/:id` from existing DB state — no new external calls, no engine/playback changes.

**Tech Stack:** React + Vite + Vitest (web), Fastify + zod + node:sqlite (api), lucide-react icons, existing CSS design tokens.

---

## File Structure

- **Create** `apps/web/src/lib/moods.ts` — mood preset catalog + `moodPromptFor(key)`.
- **Create** `apps/web/src/lib/moods.test.ts` — unit tests.
- **Create** `apps/web/src/lib/driveContext.ts` — `buildContextPills(context)` formatting.
- **Create** `apps/web/src/lib/driveContext.test.ts` — unit tests.
- **Modify** `apps/api/src/journeys/routes.ts` — add `context` + `taste` to `GET /journeys/:id`.
- **Modify** `apps/api/test/spotify.test.ts` — assert the new fields.
- **Modify** `apps/web/src/lib/api.ts` — extend `JourneyDetail` type.
- **Modify** `apps/web/src/App.tsx` — mood grid, destination quick-picks, context strip, personalization panel, English vibe-mix labels.
- **Modify** `apps/web/src/styles/app.css` — styles for the new elements.

All commands run from repo root `/Users/benedikthiepler/projects/priv/tidal`.

---

## Task 1: Mood preset module

**Files:**
- Create: `apps/web/src/lib/moods.ts`
- Test: `apps/web/src/lib/moods.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/moods.test.ts
import { describe, expect, it } from "vitest";

import { MOOD_PRESETS, moodPromptFor } from "./moods.js";

describe("mood presets", () => {
  it("exposes 6 presets, each with key/label/prompt, default cinematic first", () => {
    expect(MOOD_PRESETS).toHaveLength(6);
    expect(MOOD_PRESETS[0].key).toBe("cinematic");
    for (const preset of MOOD_PRESETS) {
      expect(preset.key).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.prompt.length).toBeGreaterThan(8);
      expect(typeof preset.Icon).toBe("object");
    }
    // keys are unique
    expect(new Set(MOOD_PRESETS.map((preset) => preset.key)).size).toBe(MOOD_PRESETS.length);
  });

  it("maps a key to its prompt and falls back to cinematic for unknown keys", () => {
    expect(moodPromptFor("euphoric")).toMatch(/uplifting/i);
    expect(moodPromptFor("does-not-exist")).toBe(moodPromptFor("cinematic"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/moods.test.ts`
Expected: FAIL — cannot resolve `./moods.js` / `MOOD_PRESETS is undefined`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/moods.ts
import { Coffee, Crosshair, Disc3, Mountain, Sparkles, Sunset, type LucideIcon } from "lucide-react";

export interface MoodPreset {
  key: string;
  label: string;
  Icon: LucideIcon;
  /** Prompt text handed to the recommendation engine as `userPrompt`. */
  prompt: string;
}

// Order matters: index 0 is the default selection.
export const MOOD_PRESETS: MoodPreset[] = [
  { key: "cinematic", label: "Cinematic", Icon: Sunset, prompt: "cinematic, widescreen, emotional but focused drive" },
  { key: "focused", label: "Focused", Icon: Crosshair, prompt: "calm focused flow, low-distraction, steady" },
  { key: "euphoric", label: "Euphoric", Icon: Sparkles, prompt: "uplifting, high-energy, feel-good momentum" },
  { key: "mellow", label: "Mellow", Icon: Coffee, prompt: "relaxed, warm, easygoing cruise" },
  { key: "nostalgic", label: "Nostalgic", Icon: Disc3, prompt: "nostalgic throwback warmth, timeless feel" },
  { key: "adventure", label: "Adventure", Icon: Mountain, prompt: "bold, driving, sense of adventure and discovery" }
];

export function moodPromptFor(key: string): string {
  return (MOOD_PRESETS.find((preset) => preset.key === key) ?? MOOD_PRESETS[0]).prompt;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/moods.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/moods.ts apps/web/src/lib/moods.test.ts
git commit -m "feat(web): add curated mood preset catalog"
```

---

## Task 2: Drive-context pill formatting

**Files:**
- Create: `apps/web/src/lib/driveContext.ts`
- Test: `apps/web/src/lib/driveContext.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/driveContext.test.ts
import { describe, expect, it } from "vitest";

import { buildContextPills } from "./driveContext.js";

describe("buildContextPills", () => {
  it("returns no pills when context is missing", () => {
    expect(buildContextPills(undefined)).toEqual([]);
  });

  it("emits only pills with values; hides unknown pace and missing eta/weather", () => {
    const pills = buildContextPills({ phase: "golden_hour", coarseRegion: "Burgundy", speedBucket: "unknown" });
    const keys = pills.map((pill) => pill.key);
    expect(keys).toEqual(["phase", "region"]);
    expect(pills.find((pill) => pill.key === "phase")?.value).toBe("Golden Hour");
    expect(pills.find((pill) => pill.key === "region")?.value).toBe("Burgundy");
  });

  it("includes pace, eta and weather when present, in canonical order", () => {
    const pills = buildContextPills({
      phase: "cruise",
      speedBucket: "highway",
      etaMinutes: 75,
      temperatureBucket: "warm",
      coarseRegion: "Northern Italy"
    });
    expect(pills.map((pill) => pill.key)).toEqual(["phase", "tempo", "eta", "weather", "region"]);
    expect(pills.find((pill) => pill.key === "tempo")?.value).toBe("Highway");
    expect(pills.find((pill) => pill.key === "eta")?.value).toMatch(/75/);
    expect(pills.find((pill) => pill.key === "weather")?.value).toBe("Warm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/driveContext.test.ts`
Expected: FAIL — cannot resolve `./driveContext.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/driveContext.ts
export interface DriveContext {
  phase?: string;
  speedBucket?: string;
  etaMinutes?: number;
  temperatureBucket?: string;
  coarseRegion?: string;
  localTimeIso?: string;
}

export interface ContextPill {
  key: string;
  label: string;
  value: string;
}

const PACE_LABEL: Record<string, string> = {
  parked: "Parked",
  city: "City",
  country: "Country road",
  highway: "Highway"
};

const WEATHER_LABEL: Record<string, string> = {
  cold: "Cold",
  cool: "Cool",
  mild: "Mild",
  warm: "Warm",
  hot: "Hot"
};

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function formatEta(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Builds the ordered, glanceable context pills, omitting any field without a usable value. */
export function buildContextPills(context?: DriveContext): ContextPill[] {
  if (!context) return [];
  const pills: ContextPill[] = [];

  if (context.phase) {
    pills.push({ key: "phase", label: "Phase", value: titleCase(context.phase) });
  }
  const pace = context.speedBucket ? PACE_LABEL[context.speedBucket] : undefined;
  if (pace) {
    pills.push({ key: "tempo", label: "Pace", value: pace });
  }
  if (typeof context.etaMinutes === "number" && context.etaMinutes > 0) {
    pills.push({ key: "eta", label: "ETA", value: formatEta(context.etaMinutes) });
  }
  const weather = context.temperatureBucket ? WEATHER_LABEL[context.temperatureBucket] : undefined;
  if (weather) {
    pills.push({ key: "weather", label: "Weather", value: weather });
  }
  if (context.coarseRegion) {
    pills.push({ key: "region", label: "Region", value: context.coarseRegion });
  }
  return pills;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/driveContext.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/driveContext.ts apps/web/src/lib/driveContext.test.ts
git commit -m "feat(web): add drive-context pill formatting"
```

---

## Task 3: Expose `context` + `taste` on the journey detail endpoint

**Files:**
- Modify: `apps/api/src/journeys/routes.ts` (imports + `GET /journeys/:id` handler)
- Test: `apps/api/test/spotify.test.ts` (add one test inside the existing `describe("spotify api")`)

- [ ] **Step 1: Write the failing test**

Add this test after the existing `"creates a Spotify journey by default..."` test in `apps/api/test/spotify.test.ts`:

```ts
  it("exposes privacy-safe drive context and cached taste genres on the journey detail", async () => {
    const { app } = await buildApp(testConfig());

    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination: "Lago di Garda",
        userPrompt: "golden hour drive",
        passengerMode: "couple",
        deviceId: "tesla-webplayer"
      }
    });
    const journey = start.json<{ id: string }>();

    const detail = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    const body = detail.json<{
      context?: { phase?: string; coarseRegion?: string };
      taste?: { topGenres: string[] };
    }>();

    expect(body.context?.phase).toBe("departure");
    // Mock Spotify adapter supplies top artists, so analysis caches a taste profile.
    expect(body.taste?.topGenres?.length ?? 0).toBeGreaterThan(0);

    await app.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/spotify.test.ts`
Expected: FAIL — `body.context` is `undefined`.

- [ ] **Step 3: Add the `contextFromJourney` import**

In `apps/api/src/journeys/routes.ts`, change the store import line:

```ts
import { contextFromJourney, type Store } from "../db/store.js";
```

(The file currently has `import type { Store } from "../db/store.js";` — replace it with the line above.)

- [ ] **Step 4: Enrich the `GET /journeys/:id` response**

In `apps/api/src/journeys/routes.ts`, replace the `return { ... }` block of the `app.get("/journeys/:id", ...)` handler with:

```ts
    const ctx = contextFromJourney(journey, store.latestTelemetry(id));
    const taste = store.getCachedTasteProfile("local");

    return {
      journey,
      latestUpdate,
      tracks,
      playbackSession: store.getPlaybackSession(id),
      needsAnalysis:
        journey.status === "active" &&
        !hasTracks &&
        (!latestUpdate || lastUpdateFailed),
      analysisError: !hasTracks && failureIsFresh ? analysisFailed!.message : undefined,
      // Privacy-safe glanceable drive context (no raw GPS/VIN).
      context: {
        phase: ctx.phase,
        speedBucket: ctx.speedBucket,
        etaMinutes: ctx.etaMinutes,
        temperatureBucket: ctx.temperatureBucket,
        coarseRegion: ctx.coarseRegion,
        localTimeIso: ctx.localTimeIso
      },
      // Personalization readout from the 24h taste cache (only top genres exposed).
      taste: taste ? { topGenres: taste.topGenres } : undefined
    };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/api/test/spotify.test.ts`
Expected: PASS (all tests in file, including the new one).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/journeys/routes.ts apps/api/test/spotify.test.ts
git commit -m "feat(api): expose drive context and taste genres on journey detail"
```

---

## Task 4: Extend the web API client type

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`JourneyDetail` interface)

- [ ] **Step 1: Add the optional fields to `JourneyDetail`**

In `apps/web/src/lib/api.ts`, inside the `JourneyDetail` interface, add these two members after the `playbackSession?: { ... }` block (before the closing `}` of the interface):

```ts
  context?: {
    phase?: string;
    speedBucket?: string;
    etaMinutes?: number;
    temperatureBucket?: string;
    coarseRegion?: string;
    localTimeIso?: string;
  };
  taste?: {
    topGenres: string[];
  };
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck -w @ai-journey-dj/web`
Expected: no output / exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): type drive context and taste on JourneyDetail"
```

---

## Task 5: Setup screen — mood presets + destination quick-picks

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Update imports and remove the now-unused icon**

At the top of `apps/web/src/App.tsx`, add the lib imports after the existing `./spotifyPlayer.js` import block:

```ts
import { MOOD_PRESETS, moodPromptFor } from "./lib/moods.js";
import { buildContextPills } from "./lib/driveContext.js";
```

- [ ] **Step 2: Replace the free-text mood state with a mood-key state**

Find:

```ts
  const [userPrompt, setUserPrompt] = useState("cinematic golden-hour drive, focused but emotional");
```

Replace with:

```ts
  const [selectedMood, setSelectedMood] = useState(MOOD_PRESETS[0].key);
```

- [ ] **Step 3: Send the mapped prompt when starting a journey**

In both `startJourney()` and `startTidalJourney()`, find each occurrence of:

```ts
        userPrompt,
```

and replace it with:

```ts
        userPrompt: moodPromptFor(selectedMood),
```

(There are two occurrences — one per function. `loadTracks`/others do not send `userPrompt`.)

- [ ] **Step 4: Replace the mood textarea with a mood grid + add destination quick-picks**

In the setup `<section className="setup glass">`, find the destination + mood block:

```tsx
            <label className="field">
              <span>Destination</span>
              <input
                onChange={(event) => setDestination(event.target.value)}
                placeholder="e.g. Lago di Garda"
                value={destination}
              />
            </label>
            <label className="field">
              <span>Mood &amp; direction</span>
              <textarea onChange={(event) => setUserPrompt(event.target.value)} rows={2} value={userPrompt} />
            </label>
```

Replace it with:

```tsx
            <label className="field">
              <span>Destination</span>
              <input
                onChange={(event) => setDestination(event.target.value)}
                placeholder="e.g. Lago di Garda"
                value={destination}
              />
            </label>
            {recentDestinations.length > 0 ? (
              <div className="quick-picks" aria-label="Recent destinations">
                {recentDestinations.map((place) => (
                  <button
                    className={`quick-pick${place === destination ? " on" : ""}`}
                    key={place}
                    onClick={() => setDestination(place)}
                    type="button"
                  >
                    <MapPin size={13} /> {place}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="field">
              <span>Mood</span>
              <div className="mood-grid" role="group" aria-label="Pick a mood">
                {MOOD_PRESETS.map((preset) => {
                  const Icon = preset.Icon;
                  const isActive = preset.key === selectedMood;
                  return (
                    <button
                      aria-pressed={isActive}
                      className={`mood${isActive ? " on" : ""}`}
                      key={preset.key}
                      onClick={() => setSelectedMood(preset.key)}
                      type="button"
                    >
                      <Icon size={20} />
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
```

- [ ] **Step 5: Derive `recentDestinations` from history**

Add this derived value right after the `bufferTracks` `useMemo` (near the other derived values, before `return (`):

```ts
  const recentDestinations = useMemo(() => {
    const seen = new Set<string>();
    const places: string[] = [];
    for (const journey of history) {
      if (journey.destination && !seen.has(journey.destination)) {
        seen.add(journey.destination);
        places.push(journey.destination);
      }
      if (places.length === 4) break;
    }
    return places;
  }, [history]);
```

- [ ] **Step 6: Verify it typechecks (no leftover `userPrompt`/`setUserPrompt`)**

Run: `npm run typecheck -w @ai-journey-dj/web`
Expected: exit 0. If it reports `setUserPrompt` unused or `userPrompt` undefined, ensure Steps 2-3 removed all references.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): replace free-text mood with presets and destination quick-picks"
```

---

## Task 6: Cockpit — context strip, personalization, English vibe-mix labels

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Translate the vibe-mix labels to English**

Find the `VIBE_MIX` constant and replace its labels:

```ts
const VIBE_MIX: { key: string; label: string; weight: number; Icon: typeof Navigation }[] = [
  { key: "familiar", label: "Familiar", weight: 0.25, Icon: Heart },
  { key: "balanced", label: "Balanced", weight: 0.5, Icon: Scale },
  { key: "discovery", label: "Discover", weight: 0.75, Icon: Compass }
];
```

- [ ] **Step 2: Update the vibe-mix panel header copy and overlay copy**

Find the `vibe-head` block and replace the sub label:

```tsx
                <div className="vibe-head">
                  <span className="vibe-title">
                    <Sparkles size={13} /> Vibe-Mix
                  </span>
                  <span className="vibe-sub">Familiar ↔ Discover</span>
                </div>
```

Find the re-tuning overlay block and replace the label text:

```tsx
            {retuningPhase || vibeTuning ? (
              <div className="retuning" role="status">
                <div className="retuning-card">
                  <span className="retuning-orb" aria-hidden="true" />
                  <span className="retuning-label">{vibeTuning ? "Adjusting mix" : "Re-tuning the vibe"}</span>
                  <strong className="retuning-phase">{vibeTuning ?? phaseMeta(retuningPhase).label}</strong>
                </div>
              </div>
            ) : null}
```

- [ ] **Step 3: Add the personalization genres line inside the vibe-mix panel**

Immediately after the `vibe-segments` `</div>` (still inside `<div className="vibe-mix">`), add:

```tsx
                {detail?.taste?.topGenres?.length ? (
                  <p className="vibe-genres">
                    <span>Your genres</span> {detail.taste.topGenres.slice(0, 4).join(" · ")}
                  </p>
                ) : null}
```

- [ ] **Step 4: Add the live-context strip under the stage head**

Find the `stage-head` block in the cockpit:

```tsx
              <div className="stage-head">
                <span className="now-label">{nowLabel}</span>
                <span className="dest">
                  <MapPin size={14} /> {detail?.journey.destination}
                </span>
              </div>
```

Add this directly after it (before the `{heroTrack ? (` block):

```tsx
              {contextPills.length > 0 ? (
                <div className="context-strip" aria-label="Live drive context">
                  {contextPills.map((pill) => (
                    <span className="ctx-pill" key={pill.key}>
                      <span className="ctx-label">{pill.label}</span>
                      <span className="ctx-value">{pill.value}</span>
                    </span>
                  ))}
                </div>
              ) : null}
```

- [ ] **Step 5: Derive `contextPills`**

Add after the `activeVibe` derived value:

```ts
  const contextPills = buildContextPills(detail?.context);
```

- [ ] **Step 6: Verify it typechecks**

Run: `npm run typecheck -w @ai-journey-dj/web`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): add live-context strip, personalization readout, english vibe labels"
```

---

## Task 7: Styles for the new elements

**Files:**
- Modify: `apps/web/src/styles/app.css`

- [ ] **Step 1: Add mood grid + quick-pick styles**

Append to the end of `apps/web/src/styles/app.css`:

```css
/* ---------- Mood presets (setup) ---------- */

.mood-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.mood {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: var(--tap);
  padding: 12px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  color: var(--text-dim);
  font-size: 0.86rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.28s var(--ease), color 0.28s var(--ease), transform 0.18s var(--ease),
    border-color 0.28s var(--ease), box-shadow 0.28s var(--ease);
}

.mood:hover:not(.on) {
  color: var(--text);
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.mood:active {
  transform: scale(0.96);
}

.mood.on {
  background: linear-gradient(135deg, var(--accent), #19b294);
  border-color: transparent;
  color: var(--accent-ink);
  box-shadow: 0 12px 30px -14px rgba(47, 227, 192, 0.85);
}

.quick-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: -4px 0 4px;
}

.quick-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 13px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-dim);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.24s var(--ease), color 0.24s var(--ease), border-color 0.24s var(--ease);
}

.quick-pick:hover:not(.on) {
  color: var(--text);
  border-color: var(--border-strong);
}

.quick-pick.on {
  border-color: var(--accent);
  color: var(--accent);
}

/* ---------- Live-context strip (cockpit) ---------- */

.context-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 2px;
}

.ctx-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  padding: 7px 13px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--border);
}

.ctx-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.ctx-value {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
}

/* ---------- Personalization readout (vibe-mix panel) ---------- */

.vibe-genres {
  margin-top: 9px;
  font-size: 0.84rem;
  color: var(--text-dim);
}

.vibe-genres span {
  display: block;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: 2px;
}
```

- [ ] **Step 2: Verify the dev build compiles styles (typecheck proxy)**

Run: `npm run typecheck -w @ai-journey-dj/web`
Expected: exit 0 (CSS is not typechecked, but this confirms the JSX class usage still compiles).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/app.css
git commit -m "style(web): mood grid, quick-picks, context strip, personalization readout"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all workspaces**

Run: `npm run typecheck --workspaces`
Expected: exit 0, no `error TS...` lines.

- [ ] **Step 2: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all test files pass (existing 69 + 5 new = 74 tests), 0 failures.

- [ ] **Step 3: Lint the changed files**

Run:
```bash
npx eslint apps/web/src/App.tsx apps/web/src/lib/moods.ts apps/web/src/lib/driveContext.ts apps/web/src/lib/api.ts apps/api/src/journeys/routes.ts
```
Expected: `No issues found` (no errors/warnings).

- [ ] **Step 4: Commit any lint fixes (only if Step 3 required changes)**

```bash
git add -A
git commit -m "chore(web): lint cleanup for in-car UI redesign"
```

---

## Self-Review Notes

- **Spec coverage:** §1 setup (Task 5: mood grid + quick-picks), §2 cockpit (Task 6: context strip + personalization + English labels), §3 data flow (Task 3 backend, Task 4 client type, Task 1 moods module), §4 testing (Tasks 1-3 unit/integration, Task 8 full suite). All covered.
- **Weather pill** intentionally derives from `temperatureBucket` (telemetry has no `weatherFeel`), matching the final-check note.
- **Graceful degradation:** `buildContextPills` returns `[]` when context absent and skips unknown pace/missing eta; personalization line hidden when `taste.topGenres` empty.
- **Type consistency:** `context` field shape in Task 3 (api) matches `JourneyDetail.context` (Task 4) and `DriveContext` (Task 2). `moodPromptFor`/`MOOD_PRESETS` names consistent across Tasks 1 and 5.
- **No engine/playback changes** — backend additions are read-only DB reads.
