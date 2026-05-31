# Spotify Connect Device Picker — Design

**Date:** 2026-06-01
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `packages/spotify`, `apps/api` (adapter, service, routes), `apps/web`.

## Goal

Add the familiar Spotify "Connect" device picker so the user can choose which device plays the
journey's curated songs (in-browser player, phone, or Tesla's native Spotify). The backend already
plays everything on `journey.spotifyDeviceId`; we add device listing + transport (play/pause) so any
selected device is fully controllable. The in-browser player stays the default; the picker switches.

## Decisions

- **Default stays the browser Web Playback SDK player**; the Connect picker switches to another device.
- **Full transport** on the selected device: skip already works via the Web API; add Web-API
  play/pause so the transport bar controls external devices consistently.
- **Approach A:** reuse the existing per-journey device-select endpoint; add only device listing +
  pause/resume. No generic decoupled controller.

## Section 1 — Adapter (`packages/spotify`)

Add to `SpotifyAdapter`:
- `listDevices(args: { accessToken: string }): Promise<SpotifyDevice[]>` where
  `SpotifyDevice = { id: string; name: string; type: string; isActive: boolean; isRestricted: boolean; volumePercent?: number }`.
  Official: `GET /me/player/devices`, mapping `id/name/type/is_active/is_restricted/volume_percent`,
  dropping devices without an `id`. Mock: returns a deterministic list including the mock web player
  and a fake `"Tesla Model Y"` device (for UI/tests).
- `pausePlayback(args: { accessToken: string; deviceId: string }): Promise<void>` → `PUT /me/player/pause?device_id=…` (`parseJson: false`).
- `resumePlayback(args: { accessToken: string; deviceId: string }): Promise<void>` → `PUT /me/player/play?device_id=…` with no body (resume; `parseJson: false`).

Both are added as optional interface members (`?`) so non-implementing stubs stay valid.

## Section 2 — Service + routes (`apps/api`)

- `JourneyService.listSpotifyDevices(): Promise<SpotifyDevice[]>` — `spotifyAuth.getAccessToken()` +
  `spotifyAdapter.listDevices`; returns `[]` if the adapter lacks the method or on error.
- `JourneyService.setSpotifyTransport(journeyId, action: "pause" | "resume", deviceId?): Promise<PlaybackSession>`
  — resolves the effective device (`deviceId ?? journey.spotifyDeviceId ?? session.deviceId`), calls
  `pausePlayback`/`resumePlayback`, updates the session status (`"degraded"`/`"playing"` semantics
  preserved), best-effort (never throws the journey).
- Routes:
  - `GET /spotify/devices` → `{ devices: SpotifyDevice[], activeId?: string }` (active = `getPlaybackState` or the first `isActive`).
  - Device **selection** reuses the existing `POST /journeys/:id/playback/device`
    (`{ deviceId, status, syncOnly: true }`) → transfers + plays the curated queue on the device.
  - `POST /journeys/:id/playback/transport` with `{ action: "pause" | "resume" }`.

## Section 3 — Frontend (`apps/web`)

- `api.spotifyDevices()` → `GET /spotify/devices`; `api.setTransport(id, action)` →
  `POST /journeys/:id/playback/transport`. `registerSpotifyDevice` (exists) is used for selection.
- A **Connect button** (lucide `MonitorSpeaker`) in the cockpit transport row opens a device list
  (fetched on open + light polling while open). Each row shows name + a type icon + active checkmark.
  Selecting a device calls `registerSpotifyDevice(journeyId, { deviceId, status: "ready", syncOnly: true })`,
  then refreshes detail.
- **Transport routing:** `togglePlayPause` checks whether the active device is the in-browser SDK
  player (`activeDeviceId === spotifyDeviceId`): if so, keep using `player.togglePlay()` (+ keepalive);
  otherwise call `api.setTransport(action)`. Skip already routes through the backend for any device.
- A pure helper `activeDeviceLabel(devices, id)` returns the display name for the chosen device.

## Section 4 — Error handling, limits & testing

- Best-effort throughout: empty device list / failed transfer / `404 device not found` → a friendly
  message + a re-fetch of the list; never crashes the journey or playback.
- **Honest limit:** whether the **Tesla native** device appears in `/me/player/devices` is
  firmware/region dependent; the picker shows whatever the Web API returns (phone + browser are
  reliable).
- **Tests (TDD):** adapter `listDevices` parse (incl. dropping id-less entries) + Mock list;
  `pausePlayback`/`resumePlayback` (URL + method, no body on resume); service `listSpotifyDevices`
  (mock) + `setSpotifyTransport`; route `GET /spotify/devices` returns an array and `POST …/transport`
  returns 200; pure `activeDeviceLabel`.

## Out of scope

- Volume control; per-device EQ; multi-room/group playback; changing the no-repeat engine or playlist
  features; reliably making the Tesla native device appear (outside our control).
