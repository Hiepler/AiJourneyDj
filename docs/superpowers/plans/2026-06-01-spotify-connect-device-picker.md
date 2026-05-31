# Spotify Connect Device Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Spotify Connect device picker so the user can play the journey's curated songs on any Connect device (browser, phone, Tesla native), with full play/pause/skip control of the selected device.

**Architecture:** Add `listDevices` + `pausePlayback`/`resumePlayback` to the Spotify adapter; expose `GET /spotify/devices` + `POST /journeys/:id/playback/transport`; reuse the existing device-select endpoint for switching. The frontend gets a Connect button + device list and routes transport to the SDK (browser) or the Web API (external device).

**Tech Stack:** TypeScript monorepo, Fastify + zod, Vitest, React + Vite, Spotify Web API.

---

## File Structure

- **Modify** `packages/spotify/src/index.ts` — `SpotifyDevice` + `listDevices`/`pausePlayback`/`resumePlayback` (Official + Mock).
- **Modify** `packages/spotify/src/index.test.ts` — adapter tests.
- **Modify** `apps/api/src/journeys/journeyService.ts` — `listSpotifyDevices` + `setSpotifyTransport`.
- **Modify** `apps/api/src/journeys/routes.ts` — `GET /spotify/devices` + `POST /journeys/:id/playback/transport`.
- **Modify** `apps/api/test/spotify.test.ts` — route tests.
- **Create** `apps/web/src/lib/devices.ts` + `apps/web/src/lib/devices.test.ts` — `activeDeviceLabel`.
- **Modify** `apps/web/src/lib/api.ts` — `SpotifyDevice` type + `spotifyDevices`/`setTransport`.
- **Modify** `apps/web/vite.config.ts` — proxy `/spotify`.
- **Modify** `apps/web/src/App.tsx` — Connect picker + transport routing + skip device fix.

All commands run from repo root `/Users/benedikthiepler/projects/priv/tidal`.

---

## Task 1: Adapter — list devices + pause/resume

**Files:**
- Modify: `packages/spotify/src/index.ts`
- Test: `packages/spotify/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("spotify playback helpers", ...)` in `packages/spotify/src/index.test.ts` (before its closing `});`):

```ts
  it("lists devices and drops entries without an id", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          devices: [
            { id: "d1", name: "Phone", type: "Smartphone", is_active: true, is_restricted: false, volume_percent: 70 },
            { id: "d2", name: "Tesla Model Y", type: "Automobile", is_active: false, is_restricted: false },
            { name: "Ghost", type: "Unknown" }
          ]
        }),
        { status: 200 }
      );
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl });
    const devices = await adapter.listDevices!({ accessToken: "t" });
    expect(devices).toEqual([
      { id: "d1", name: "Phone", type: "Smartphone", isActive: true, isRestricted: false, volumePercent: 70 },
      { id: "d2", name: "Tesla Model Y", type: "Automobile", isActive: false, isRestricted: false, volumePercent: undefined }
    ]);
  });

  it("pauses and resumes a specific device via the Web API", async () => {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response("", { status: 204 });
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl, wait: async () => undefined });

    await adapter.pausePlayback!({ accessToken: "t", deviceId: "d2" });
    await adapter.resumePlayback!({ accessToken: "t", deviceId: "d2" });

    expect(calls[0]).toEqual({ method: "PUT", url: "https://api.spotify.test/v1/me/player/pause?device_id=d2" });
    expect(calls[1]).toEqual({ method: "PUT", url: "https://api.spotify.test/v1/me/player/play?device_id=d2" });
  });

  it("MockSpotifyAdapter lists deterministic devices", async () => {
    const devices = await new MockSpotifyAdapter().listDevices!({ accessToken: "t" });
    expect(devices.length).toBeGreaterThanOrEqual(2);
    expect(devices.every((device) => typeof device.id === "string" && typeof device.name === "string")).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run packages/spotify/src/index.test.ts -t "device"`
Expected: FAIL — `listDevices`/`pausePlayback`/`resumePlayback` undefined.

- [ ] **Step 3: Add the `SpotifyDevice` type + interface members**

In `packages/spotify/src/index.ts`, add the type after the `SpotifyPlaylist` interface:

```ts
export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent?: number;
}
```

In `interface SpotifyAdapter { ... }`, add after the `addTracksToPlaylist?(...)` member:

```ts
  listDevices?(args: { accessToken: string }): Promise<SpotifyDevice[]>;
  pausePlayback?(args: { accessToken: string; deviceId: string }): Promise<void>;
  resumePlayback?(args: { accessToken: string; deviceId: string }): Promise<void>;
```

- [ ] **Step 4: Implement on `OfficialSpotifyAdapter`**

In `packages/spotify/src/index.ts`, add these methods to `OfficialSpotifyAdapter` right after its `addTracksToPlaylist` method:

```ts
  async listDevices(args: { accessToken: string }): Promise<SpotifyDevice[]> {
    const url = new URL(`${this.baseUrl}/me/player/devices`);
    const payload = await this.request<{ devices?: any[] }>(url, args.accessToken);
    const devices = Array.isArray(payload?.devices) ? payload.devices : [];
    return devices
      .filter((device) => typeof device?.id === "string")
      .map((device) => ({
        id: device.id,
        name: typeof device.name === "string" ? device.name : "Unknown device",
        type: typeof device.type === "string" ? device.type : "Unknown",
        isActive: device.is_active === true,
        isRestricted: device.is_restricted === true,
        volumePercent: typeof device.volume_percent === "number" ? device.volume_percent : undefined
      }));
  }

  async pausePlayback(args: { accessToken: string; deviceId: string }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/pause`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(url, args.accessToken, { method: "PUT" }, { parseJson: false });
  }

  async resumePlayback(args: { accessToken: string; deviceId: string }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/play`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(url, args.accessToken, { method: "PUT" }, { parseJson: false });
  }
```

- [ ] **Step 5: Implement on `MockSpotifyAdapter`**

In `packages/spotify/src/index.ts`, add to `MockSpotifyAdapter` right after its `addTracksToPlaylist` method:

```ts
  async listDevices(): Promise<SpotifyDevice[]> {
    return [
      { id: "mock-webplayer", name: "AI Journey DJ (Browser)", type: "Computer", isActive: true, isRestricted: false, volumePercent: 85 },
      { id: "mock-tesla", name: "Tesla Model Y", type: "Automobile", isActive: false, isRestricted: false }
    ];
  }

  async pausePlayback(): Promise<void> {}

  async resumePlayback(): Promise<void> {}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run packages/spotify/src/index.test.ts`
Expected: PASS (all, including the 3 new tests).

- [ ] **Step 7: Commit**

```bash
git add packages/spotify/src/index.ts packages/spotify/src/index.test.ts
git commit -m "feat(spotify): listDevices + pause/resume playback adapter methods"
```

---

## Task 2: Service + routes

**Files:**
- Modify: `apps/api/src/journeys/journeyService.ts`
- Modify: `apps/api/src/journeys/routes.ts`
- Test: `apps/api/test/spotify.test.ts`

- [ ] **Step 1: Write the failing route tests**

Append inside `describe("spotify api", ...)` in `apps/api/test/spotify.test.ts` (before its closing `});`):

```ts
  it("lists Spotify Connect devices", async () => {
    const { app } = await buildApp(testConfig());
    const res = await app.inject({ method: "GET", url: "/spotify/devices" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ devices: Array<{ id: string; name: string }> }>();
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.devices.length).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it("accepts a transport pause/resume command for a journey", async () => {
    const { app } = await buildApp(testConfig());
    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", deviceId: "tesla-webplayer" }
    });
    const journey = start.json<{ id: string }>();

    const paused = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/playback/transport`,
      payload: { action: "pause" }
    });
    expect(paused.statusCode).toBe(200);

    const resumed = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/playback/transport`,
      payload: { action: "resume" }
    });
    expect(resumed.statusCode).toBe(200);
    await app.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/spotify.test.ts -t "devices"`
Expected: FAIL — `/spotify/devices` 404.

- [ ] **Step 3: Add service methods**

In `apps/api/src/journeys/journeyService.ts`, add the type import to the existing `@ai-journey-dj/spotify` import block (which already imports `SpotifyResolver`, etc.):

```ts
  type SpotifyAdapter,
  type SpotifyDevice
```

(add `type SpotifyDevice` alongside `type SpotifyAdapter` in that import list).

Then add these two public methods to `JourneyService` (e.g. right after `skipSpotifyTrack`):

```ts
  async listSpotifyDevices(): Promise<SpotifyDevice[]> {
    if (!this.spotifyAdapter.listDevices) return [];
    try {
      const accessToken = await this.spotifyAuth.getAccessToken();
      return await this.spotifyAdapter.listDevices({ accessToken });
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "spotify.devices.failed");
      return [];
    }
  }

  async setSpotifyTransport(
    journeyId: string,
    action: "pause" | "resume",
    deviceId?: string
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error("Transport control is only supported for Spotify journeys.");
    }
    const session = this.store.getPlaybackSession(journeyId);
    const effectiveDeviceId = deviceId ?? journey.spotifyDeviceId ?? session?.deviceId;
    if (effectiveDeviceId) {
      try {
        const accessToken = await this.spotifyAuth.getAccessToken();
        const resolved = await this.spotifyAdapter.resolvePlaybackDeviceId({
          accessToken,
          preferredDeviceId: effectiveDeviceId
        });
        if (action === "pause") {
          await this.spotifyAdapter.pausePlayback?.({ accessToken, deviceId: resolved });
        } else {
          await this.spotifyAdapter.resumePlayback?.({ accessToken, deviceId: resolved });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ journeyId, action, err: message }, "spotify.transport.degraded");
        this.store.audit(journeyId, "spotify.playback_error", `Spotify ${action} command failed.`, { error: message });
      }
    }
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }
```

- [ ] **Step 4: Add routes**

In `apps/api/src/journeys/routes.ts`, add inside `registerJourneyRoutes` (e.g. right after the existing `app.post("/journeys/:id/playback/device", ...)` handler):

```ts
  app.get("/spotify/devices", async () => {
    const devices = await service.listSpotifyDevices();
    return { devices };
  });

  app.post("/journeys/:id/playback/transport", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payload = z
      .object({ action: z.enum(["pause", "resume"]), deviceId: z.string().min(1).optional() })
      .parse(request.body);
    return service.setSpotifyTransport(id, payload.action, payload.deviceId);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run apps/api/test/spotify.test.ts`
Expected: PASS (all, including the 2 new tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/journeys/journeyService.ts apps/api/src/journeys/routes.ts apps/api/test/spotify.test.ts
git commit -m "feat(api): list Spotify devices + pause/resume transport routes"
```

---

## Task 3: Frontend — picker, helper, transport routing

**Files:**
- Create: `apps/web/src/lib/devices.ts`
- Test: `apps/web/src/lib/devices.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write the failing helper test**

Create `apps/web/src/lib/devices.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { activeDeviceLabel } from "./devices.js";

const devices = [
  { id: "d1", name: "Phone", type: "Smartphone", isActive: false, isRestricted: false },
  { id: "d2", name: "Tesla Model Y", type: "Automobile", isActive: true, isRestricted: false }
];

describe("activeDeviceLabel", () => {
  it("returns the chosen device name", () => {
    expect(activeDeviceLabel(devices, "d2")).toBe("Tesla Model Y");
  });

  it("falls back to 'This browser' when the id is unknown/empty", () => {
    expect(activeDeviceLabel(devices, undefined)).toBe("This browser");
    expect(activeDeviceLabel(devices, "missing")).toBe("This browser");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/devices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/devices.ts`:

```ts
import type { SpotifyDevice } from "./api.js";

/** Display name for the currently-selected device id (defaults to the browser player). */
export function activeDeviceLabel(devices: SpotifyDevice[], id: string | undefined): string {
  if (!id) return "This browser";
  return devices.find((device) => device.id === id)?.name ?? "This browser";
}
```

- [ ] **Step 4: Add the API client type + calls**

In `apps/web/src/lib/api.ts`, add the type (near the other interfaces):

```ts
export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent?: number;
}
```

Add to the `api` object (after `skipTrack`):

```ts
  spotifyDevices: () => request<{ devices: SpotifyDevice[] }>("/spotify/devices"),
  setTransport: (id: string, action: "pause" | "resume") =>
    request<NonNullable<JourneyDetail["playbackSession"]>>(`/journeys/${id}/playback/transport`, {
      method: "POST",
      body: JSON.stringify({ action })
    }),
```

- [ ] **Step 5: Proxy `/spotify` in the dev server**

In `apps/web/vite.config.ts`, add to the `proxy` object:

```ts
      "/spotify": "http://localhost:3000",
```

- [ ] **Step 6: Run the helper test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/devices.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Add device state + the Connect picker to `App.tsx`**

In `apps/web/src/App.tsx`:

(a) Add imports: extend the api import to include `type SpotifyDevice`, add the helper + a `MonitorSpeaker` icon:

```ts
import { api, type Health, type Journey, type JourneyDetail, type SpotifyDevice } from "./lib/api.js";
```

Add to the `lucide-react` import block: `MonitorSpeaker,` (alphabetical, e.g. after `MapPin,`).

Add after the `buildContextPills` import line:

```ts
import { activeDeviceLabel } from "./lib/devices.js";
```

(b) Add state near the other `useState`s (e.g. after `const [vibeTuning, setVibeTuning] = useState<string>();`):

```ts
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [showDevices, setShowDevices] = useState(false);
```

(c) Add a device-list fetch/poll effect near the other effects (after the journey-poll effect):

```ts
  useEffect(() => {
    if (!showDevices || health?.spotifyMock === undefined) return;
    let cancelled = false;
    const load = () => api.spotifyDevices().then((res) => !cancelled && setDevices(res.devices)).catch(() => undefined);
    load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [showDevices, health?.spotifyMock]);
```

(d) Add a select-device handler (near `selectPhase`):

```ts
  async function selectDevice(device: SpotifyDevice) {
    if (!activeJourneyId) return;
    setShowDevices(false);
    setError(undefined);
    try {
      await api.registerSpotifyDevice(activeJourneyId, { deviceId: device.id, status: "ready", syncOnly: true });
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

(e) Route transport. Replace the body of `togglePlayPause` with:

```ts
  async function togglePlayPause() {
    const activeId = detail?.journey.spotifyDeviceId;
    const onBrowser = !activeId || activeId === spotifyDeviceId;
    if (!onBrowser && activeJourneyId) {
      // External device: control it through the Web API instead of the in-browser SDK.
      const willPause = playing;
      setIsPaused(willPause);
      try {
        await api.setTransport(activeJourneyId, willPause ? "pause" : "resume");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const player = playerRef.current;
    if (!player?.togglePlay) {
      await playAudio();
      return;
    }
    setIsPaused((previous) => (previous === undefined ? false : !previous));
    armKeepAlive();
    try {
      await player.togglePlay();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

(f) Fix `skipTrack` to target the selected device (not always the browser). Find:

```ts
      const deviceId = spotifyDeviceId ?? (await ensureSpotifyDevice().catch(() => undefined));
```

Replace with:

```ts
      const deviceId =
        detail?.journey.spotifyDeviceId ?? spotifyDeviceId ?? (await ensureSpotifyDevice().catch(() => undefined));
```

(g) Add the Connect button + picker in the transport row. Find the Refresh button block (the `<button className="ctrl" disabled={loading} onClick={refreshQueue} ...>` Refresh) and add directly after it:

```tsx
                <div className="connect-wrap">
                  <button
                    className="ctrl"
                    onClick={() => setShowDevices((open) => !open)}
                    title="Choose playback device"
                    type="button"
                  >
                    <MonitorSpeaker size={20} />
                    <span>{activeDeviceLabel(devices, detail?.journey.spotifyDeviceId)}</span>
                  </button>
                  {showDevices ? (
                    <div className="device-menu" role="menu">
                      {devices.length === 0 ? (
                        <p className="device-empty">No Spotify devices found. Open Spotify on a device, then retry.</p>
                      ) : (
                        devices.map((device) => (
                          <button
                            className={`device-row${device.id === detail?.journey.spotifyDeviceId ? " on" : ""}`}
                            key={device.id}
                            onClick={() => selectDevice(device)}
                            type="button"
                          >
                            <MonitorSpeaker size={16} />
                            <span className="device-name">{device.name}</span>
                            <span className="device-type">{device.type}</span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
```

- [ ] **Step 8: Add minimal styles**

Append to `apps/web/src/styles/app.css`:

```css
/* ---------- Connect device picker ---------- */

.connect-wrap {
  position: relative;
}

.device-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  padding: 8px;
  display: grid;
  gap: 4px;
  border-radius: var(--r-md);
  background: rgba(12, 16, 18, 0.96);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
  z-index: 6;
}

.device-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.device-row:hover {
  background: var(--surface-2);
}

.device-row.on {
  color: var(--accent);
}

.device-name {
  flex: 1;
  font-weight: 700;
}

.device-type {
  font-size: 0.75rem;
  color: var(--text-faint);
}

.device-empty {
  padding: 10px 12px;
  font-size: 0.85rem;
  color: var(--text-dim);
}
```

- [ ] **Step 9: Verify it typechecks**

Run: `npm run typecheck -w @ai-journey-dj/web`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/devices.ts apps/web/src/lib/devices.test.ts apps/web/src/lib/api.ts apps/web/vite.config.ts apps/web/src/App.tsx apps/web/src/styles/app.css
git commit -m "feat(web): Spotify Connect device picker + external-device transport"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all workspaces**

Run: `npm run typecheck --workspaces`
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all files pass (previous total + 3 adapter + 2 api + 2 helper = +7), 0 failures.

- [ ] **Step 3: Lint changed files**

Run: `npx eslint packages/spotify/src/index.ts apps/api/src/journeys/journeyService.ts apps/api/src/journeys/routes.ts apps/web/src/App.tsx apps/web/src/lib/api.ts apps/web/src/lib/devices.ts`
Expected: `No issues found`.

- [ ] **Step 4: Commit any lint fixes (only if Step 3 required changes)**

```bash
git add -A
git commit -m "chore: lint cleanup for device picker"
```

---

## Self-Review Notes

- **Spec coverage:** §1 adapter (Task 1), §2 service+routes (Task 2), §3 frontend picker + transport routing (Task 3), §4 errors/tests (Tasks 1-3 + Task 4). Covered.
- **Type consistency:** `SpotifyDevice` shape identical in adapter (Task 1), service import (Task 2), api client + helper (Task 3). `listDevices`/`pausePlayback`/`resumePlayback`/`listSpotifyDevices`/`setSpotifyTransport`/`activeDeviceLabel`/`spotifyDevices`/`setTransport` names consistent across tasks.
- **Reuse:** device selection reuses the existing `registerSpotifyDevice` endpoint (no new select route); skip already routes through the backend — Task 3(f) just retargets it to the selected device.
- **Dev proxy:** Task 3(e) adds `/spotify` to the Vite proxy so the new route works behind the single tunnel.
- **Best-effort:** `listSpotifyDevices`/`setSpotifyTransport` swallow errors (return `[]` / audit) so the journey never breaks.
- **Honest limit:** whether the Tesla native device appears is firmware-dependent; the picker shows whatever the Web API returns.
- **No placeholders.**
```
