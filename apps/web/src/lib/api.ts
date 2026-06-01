// Empty default uses the Vite dev proxy (same origin). Set VITE_API_BASE_URL for direct API access.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export interface Journey {
  id: string;
  provider: "spotify" | "tidal";
  destination: string;
  userPrompt: string;
  passengerMode: string;
  phase: string;
  status: "active" | "stopped";
  tasteWeight?: number;
  spotifyDeviceId?: string;
  spotifyPlaylistId?: string;
  spotifyPlaylistUrl?: string;
  tidalPlaylistId?: string;
  tidalPlaylistUrl?: string;
  createdAtIso: string;
  stoppedAtIso?: string;
}

export interface Track {
  id: string;
  provider: "spotify" | "tidal";
  providerTrackId: string;
  providerUri?: string;
  externalUrl?: string;
  isPlayable?: boolean;
  market?: string;
  albumArtUrl?: string;
  artist: string;
  title: string;
  matchConfidence: number;
  matchReason: string;
  addedToPlaylist: boolean;
}

export interface JourneyDetail {
  journey: Journey;
  latestUpdate?: {
    id: string;
    batchSize: number;
    status: string;
    createdAtIso: string;
  };
  needsAnalysis?: boolean;
  analysisError?: string;
  tracks: Track[];
  playbackSession?: {
    journeyId: string;
    provider: "spotify" | "tidal";
    deviceId?: string;
    status: string;
    activeTrack?: Track;
    queuedTrackIds: string[];
    playedTrackIds?: string[];
    targetBufferSize: 5;
    lastHeartbeatAt: string;
  };
  context?: {
    phase?: string;
    speedBucket?: string;
    paceTrend?: string;
    etaMinutes?: number;
    etaTrend?: string;
    temperatureBucket?: string;
    autopilotState?: string;
    batteryPercent?: number;
    coarseRegion?: string;
    localTimeIso?: string;
    lastTelemetryAt?: string;
  };
  taste?: {
    topGenres: string[];
  };
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent?: number;
}

export interface SongScoutHealth {
  provider: "multilens" | "gemini" | "xai";
  model: string;
  webSearch: boolean;
  mock: boolean;
  lenses?: number;
}

export interface Health {
  ok: boolean;
  tidalConnected: boolean;
  tidalMock: boolean;
  spotifyConnected: boolean;
  spotifyMock: boolean;
  spotifyPremium: boolean;
  teslaConnected?: boolean;
  teslaFleetEnabled?: boolean;
  xaiMock: boolean;
  songScout: SongScoutHealth;
  telemetryEnabled: boolean;
  journeyRefreshMinutes: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  // Bypass the ngrok free-tier browser-warning interstitial so API responses stay JSON
  // (harmless on a real domain).
  headers.set("ngrok-skip-browser-warning", "true");
  let body = init?.body;
  const hasBody = body !== undefined && body !== null && body !== "";

  if (!hasBody && (method === "POST" || method === "PUT" || method === "PATCH")) {
    body = "{}";
  }
  if (body !== undefined && body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    method,
    body,
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    let payload: { message?: string; error?: string; hint?: string } | undefined;
    try {
      payload = JSON.parse(text) as { message?: string; error?: string; hint?: string };
    } catch {
      payload = undefined;
    }
    const message = payload?.message ?? payload?.error;
    if (message) {
      throw new Error(payload?.hint ? `${message} ${payload.hint}` : message);
    }
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>("/health"),
  history: () => request<{ journeys: Journey[] }>("/history"),
  startJourney: (payload: {
    destination: string;
    userPrompt: string;
    passengerMode: string;
    provider?: "spotify" | "tidal";
    deviceId?: string;
  }) =>
    request<Journey>("/journeys", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  journey: (id: string) => request<JourneyDetail>(`/journeys/${id}`),
  analyze: (id: string) =>
    request<{ id: string; batchSize: number; status: string }>(`/journeys/${id}/analyze`, {
      method: "POST"
    }),
  stop: (id: string) =>
    request<Journey>(`/journeys/${id}/stop`, {
      method: "POST"
    }),
  setPhase: (id: string, phase: string) =>
    request<Journey>(`/journeys/${id}/phase`, {
      method: "POST",
      body: JSON.stringify({ phase })
    }),
  setTasteWeight: (id: string, weight: number) =>
    request<Journey>(`/journeys/${id}/taste`, {
      method: "POST",
      body: JSON.stringify({ weight })
    }),
  registerSpotifyDevice: (id: string, payload: { deviceId: string; status?: string; syncOnly?: boolean }) =>
    request<JourneyDetail["playbackSession"]>(`/journeys/${id}/playback/device`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  skipTrack: (id: string, payload: { direction: "next" | "previous"; deviceId?: string }) =>
    request<NonNullable<JourneyDetail["playbackSession"]>>(`/journeys/${id}/playback/skip`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  spotifyDevices: () => request<{ devices: SpotifyDevice[] }>("/spotify/devices"),
  setTransport: (id: string, action: "pause" | "resume") =>
    request<NonNullable<JourneyDetail["playbackSession"]>>(`/journeys/${id}/playback/transport`, {
      method: "POST",
      body: JSON.stringify({ action })
    }),
  fallbackToTidal: (id: string) =>
    request<Journey>(`/journeys/${id}/fallback/tidal`, {
      method: "POST"
    }),
  spotifyToken: () => request<{ accessToken: string; premium: boolean; expiresAtIso?: string }>("/auth/spotify/token"),
  tidalLoginUrl: `${API_BASE_URL}/auth/tidal/login`,
  spotifyLoginUrl: `${API_BASE_URL}/auth/spotify/login`
};
