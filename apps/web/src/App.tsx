import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Coffee,
  Compass,
  Crosshair,
  Heart,
  ListMusic,
  Loader2,
  Mic,
  MonitorSpeaker,
  MapPin,
  Music2,
  Navigation,
  Pause,
  Pin,
  PinOff,
  Play,
  Power,
  RefreshCw,
  Radio,
  RotateCcw,
  Route,
  Satellite,
  Scale,
  Moon,
  Send,
  SkipBack,
  SkipForward,
  Sparkles,
  Sunset,
  Wifi,
  Wind,
  X
} from "lucide-react";

import { api, type Health, type Journey, type JourneyDetail, type LiveTelemetry, type MusicWish, type SpotifyDevice } from "./lib/api.js";
import { queueTracksInPlaybackOrder } from "./lib/queue.js";
import { getSpeechRecognitionCtor, isSpeechRecognitionSupported } from "./lib/speech.js";
import {
  connectSpotifyWebPlayer,
  spotifySdkStatusLabel,
  startSpotifyBrowserPlayback,
  type SpotifyPlayerInstance,
  type SpotifySdkStatus
} from "./spotifyPlayer.js";
import { MOOD_PRESETS, moodPromptFor } from "./lib/moods.js";
import { buildContextPills, telemetryLiveness } from "./lib/driveContext.js";
import { applyMediaSession, buildMediaMetadata, createSilentKeepAlive, type SilentKeepAlive } from "./backgroundAudio.js";
import { activeDeviceLabel } from "./lib/devices.js";

const passengerModes = ["solo", "couple", "family", "friends"];

// German labels for the Adaptive Drive Mode reasons surfaced by the backend.
const DRIVE_MODE_REASON_LABELS: Record<string, string> = {
  "heavy traffic": "zäher Verkehr",
  "low range": "wenig Reichweite",
  "wintry conditions": "winterlich",
  "long night drive": "Nachtfahrt"
};

// Celebratory family-event copy for a freshly-fired journey moment (shown briefly in the cockpit).
function momentEventLabel(moment: {
  type: string;
  country?: string;
}): { emoji: string; text: string } {
  switch (moment.type) {
    case "border_crossing":
      return { emoji: "🎉", text: moment.country ? `Willkommen in ${moment.country}!` : "Neues Land!" };
    case "traffic_release":
      return { emoji: "🚀", text: "Freie Fahrt — der Stau ist durch!" };
    case "traffic_jam":
      return { emoji: "🧘", text: "Stau — wir bleiben entspannt" };
    case "golden_hour":
      return { emoji: "🌇", text: "Golden Hour" };
    case "temp_swing":
      return { emoji: "🌡️", text: "Das Wetter dreht" };
    case "arrival":
      return { emoji: "🏁", text: "Gleich da!" };
    default:
      return { emoji: "✨", text: "Neuer Moment" };
  }
}

const PHASES: { key: string; label: string; Icon: typeof Navigation }[] = [
  { key: "departure", label: "Departure", Icon: Navigation },
  { key: "cruise", label: "Cruise", Icon: Route },
  { key: "golden_hour", label: "Golden hour", Icon: Sunset },
  { key: "focus", label: "Focus", Icon: Crosshair },
  { key: "arrival", label: "Arrival", Icon: MapPin },
  { key: "rest", label: "Rest", Icon: Coffee }
];

function phaseMeta(phase?: string) {
  return PHASES.find((entry) => entry.key === phase) ?? PHASES[0];
}

// Familiarity↔discovery mix: discrete, deliberate taps (re-curation costs AI tokens, so no
// continuous slider). Each step maps to the per-journey tasteWeight (0..1).
const VIBE_MIX: { key: string; label: string; weight: number; Icon: typeof Navigation }[] = [
  { key: "familiar", label: "Familiar", weight: 0.25, Icon: Heart },
  { key: "balanced", label: "Balanced", weight: 0.5, Icon: Scale },
  { key: "discovery", label: "Discover", weight: 0.75, Icon: Compass }
];

const DEFAULT_TASTE_WEIGHT = 0.4;

function nearestVibe(weight?: number) {
  const target = weight ?? DEFAULT_TASTE_WEIGHT;
  return VIBE_MIX.reduce((best, entry) =>
    Math.abs(entry.weight - target) < Math.abs(best.weight - target) ? entry : best
  );
}

function humanizeAnalysisError(message: string): string {
  if (/json|syntaxerror|unexpected token/i.test(message)) {
    return "Song suggestions could not be loaded. Tap Retry below — the server will try again.";
  }
  return message;
}

export function App() {
  const [health, setHealth] = useState<Health>();
  const [history, setHistory] = useState<Journey[]>([]);
  const [activeJourneyId, setActiveJourneyId] = useState<string>();
  const [detail, setDetail] = useState<JourneyDetail>();
  const [destination, setDestination] = useState("Lago di Garda");
  const [liveTelemetry, setLiveTelemetry] = useState<LiveTelemetry>();
  const [liveLoading, setLiveLoading] = useState(false);
  const [momentBanner, setMomentBanner] = useState<{ type: string; country?: string; atIso: string }>();
  const [karaokeOn, setKaraokeOn] = useState(false);
  const [lyrics, setLyrics] = useState<{
    trackId: string;
    synced: { timeMs: number; text: string }[] | null;
    plain: string | null;
  }>();
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsPositionMs, setLyricsPositionMs] = useState(0);
  const [selectedMood, setSelectedMood] = useState(MOOD_PRESETS[0].key);
  const [passengerMode, setPassengerMode] = useState("couple");
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifySdkStatus>("idle");
  const [spotifyDeviceId, setSpotifyDeviceId] = useState<string>();
  const [isPaused, setIsPaused] = useState<boolean | undefined>();
  const [retuningPhase, setRetuningPhase] = useState<string>();
  const [vibeTuning, setVibeTuning] = useState<string>();
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [showDevices, setShowDevices] = useState(false);
  const [wishText, setWishText] = useState("");
  const [wishDrawerOpen, setWishDrawerOpen] = useState(false);
  const [wishLoading, setWishLoading] = useState(false);
  const [kidsBusy, setKidsBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const speechSupported = typeof window !== "undefined" && isSpeechRecognitionSupported();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const playerRef = useRef<SpotifyPlayerInstance | null>(null);
  const recoveryAttemptedFor = useRef<string | undefined>(undefined);
  const keepAliveRef = useRef<SilentKeepAlive | null>(null);
  // Did the driver type/pick a destination themselves? A ref (not state) so the in-flight live
  // pre-fill reads the *latest* value at apply-time and never clobbers a destination typed mid-fetch.
  const destinationTouchedRef = useRef(false);
  // Guards the start-screen auto-pull to one Tesla read per session (reset when a journey starts), so
  // a health re-fetch toggling teslaConnected can't re-trigger billed reads.
  const liveAutoFetchedRef = useRef(false);
  // Last journey moment shown as a banner — so the same fired moment isn't celebrated twice.
  const shownMomentAtRef = useRef<string | undefined>(undefined);
  // The currently-sung karaoke line, kept scrolled into view.
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  // Holds the latest playback actions so MediaSession / visibility handlers never call stale closures.
  const playbackActionsRef = useRef({
    next: () => {},
    prev: () => {},
    toggle: () => {},
    resume: () => {}
  });

  function armKeepAlive() {
    // Must be created inside a user gesture (button click) so autoplay permits the silent element.
    if (!keepAliveRef.current) {
      keepAliveRef.current = createSilentKeepAlive();
    }
    keepAliveRef.current.play();
  }

  useEffect(() => {
    refreshShell().catch((err) =>
      setError(err instanceof Error ? err.message : "API unreachable. Run npm run dev and ensure port 3000 is free.")
    );

    const params = new URLSearchParams(window.location.search);
    const spotify = params.get("spotify");
    const tidal = params.get("tidal");
    if (spotify === "connected" || spotify === "mock" || tidal === "connected" || tidal === "mock") {
      refreshShell().catch((err) =>
        setError(err instanceof Error ? err.message : "API unreachable. Run npm run dev and ensure port 3000 is free.")
      );
    }
    if (spotify === "error" || tidal === "error") {
      setError(decodeURIComponent(params.get("message") ?? "Provider login failed."));
    }
    if (spotify || tidal) {
      params.delete("spotify");
      params.delete("tidal");
      params.delete("message");
      const nextUrl = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
      window.history.replaceState({}, "", nextUrl);
    }
  }, []);

  useEffect(() => {
    if (!activeJourneyId) return;
    const timer = setInterval(() => {
      api.journey(activeJourneyId).then(setDetail).catch((err) => setError(String(err)));
    }, 6000);
    return () => clearInterval(timer);
  }, [activeJourneyId]);

  useEffect(() => {
    if (!showDevices) return;
    let cancelled = false;
    const load = () =>
      api
        .spotifyDevices()
        .then((res) => {
          if (!cancelled) setDevices(res.devices);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [showDevices]);

  // On the start screen, pull one live reading as soon as the car is connected so the destination/ETA
  // can pre-fill — instead of waiting for the journey's first background poll. Strictly one-shot per
  // start-screen session (Tesla reads are billed and touch the car); a journey starting re-arms it,
  // and the driver can re-pull explicitly with the refresh button.
  useEffect(() => {
    if (activeJourneyId) {
      liveAutoFetchedRef.current = false;
      return;
    }
    if (!health?.teslaConnected || liveAutoFetchedRef.current) return;
    liveAutoFetchedRef.current = true;
    refreshLiveTelemetry();
  }, [activeJourneyId, health?.teslaConnected]);

  // Celebrate a freshly-fired journey moment as a brief, auto-dismissing family-event banner.
  useEffect(() => {
    const moment = detail?.context?.moment;
    if (!moment || shownMomentAtRef.current === moment.atIso) return;
    shownMomentAtRef.current = moment.atIso;
    setMomentBanner(moment);
    const timer = setTimeout(() => setMomentBanner(undefined), 7000);
    return () => clearTimeout(timer);
  }, [detail?.context?.moment?.atIso]);

  const queuedIds = detail?.playbackSession?.queuedTrackIds ?? [];
  const bufferTracks = useMemo(() => {
    if (!detail) return [];
    return queueTracksInPlaybackOrder(detail.tracks, queuedIds);
  }, [detail, queuedIds]);
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
  const displayTracks = bufferTracks.length > 0 ? bufferTracks : (detail?.tracks ?? []).slice(0, 8);
  const bufferCount = queuedIds.length > 0 ? queuedIds.length : displayTracks.length;
  const activeTrack = detail?.playbackSession?.activeTrack;
  const playbackStatus = detail?.playbackSession?.status;
  const isPlayingInBrowser = playbackStatus === "playing";
  const isSpotifyJourney = detail?.journey.provider === "spotify";
  const needsPlayAudio =
    !health?.spotifyMock &&
    isSpotifyJourney &&
    Boolean(activeJourneyId && displayTracks.length > 0 && (!isPlayingInBrowser || spotifyStatus === "autoplay_failed"));
  const tracksPending = Boolean(activeJourneyId && detail && detail.tracks.length === 0 && !detail.analysisError);
  const tracksFailed = Boolean(detail?.analysisError || detail?.latestUpdate?.status === "failed");
  const spotifyConnected = Boolean(health?.spotifyConnected);
  const spotifyReady = health?.spotifyMock || spotifyStatus === "ready";

  const liveReading = liveTelemetry?.reading ?? undefined;
  // Freshness badge for the start screen: a real timestamp when we have a reading, "no live data"
  // when the car is reachable but asleep/offline. Hidden entirely when Tesla isn't connected.
  const liveBadge = useMemo(() => {
    if (!health?.teslaConnected || !liveTelemetry?.available) return undefined;
    return telemetryLiveness(liveReading?.timestampIso, nowMs);
  }, [health?.teslaConnected, liveTelemetry?.available, liveReading?.timestampIso, nowMs]);
  const navDestination = liveReading?.destination?.trim();
  const navDestinationAvailable = Boolean(navDestination && navDestination !== destination);
  const startContextPills = useMemo(
    () => (liveReading ? buildContextPills(liveReading) : []),
    [liveReading],
  );

  const statusLine = useMemo(() => {
    if (!health) return "Loading…";
    if (!spotifyConnected) return "Connect Spotify to start your journey.";
    if (!health.spotifyPremium) return "Spotify Premium is required for playback.";
    if (health.spotifyMock) return "Demo mode — playback is simulated.";
    if (activeJourneyId && detail) {
      if (needsPlayAudio) {
        return "Tracks ready — tap Play audio to hear them in this browser.";
      }
      const queueHint = detail.journey.provider === "spotify" ? `Queue ${bufferCount}/5` : "TIDAL playlist";
      return `${queueHint} · ${detail.journey.phase}`;
    }
    if (!spotifyReady) return spotifySdkStatusLabel(spotifyStatus);
    return "Ready — press Start Journey.";
  }, [activeJourneyId, bufferCount, detail, health, needsPlayAudio, spotifyConnected, spotifyReady, spotifyStatus]);

  async function refreshShell(options: { autoResume?: boolean } = {}) {
    const { autoResume = true } = options;
    const [nextHealth, nextHistory] = await Promise.all([api.health(), api.history()]);
    setHealth(nextHealth);
    setHistory(nextHistory.journeys);
    const active = nextHistory.journeys.find((journey) => journey.status === "active");
    if (autoResume && active) {
      setActiveJourneyId(active.id);
      setDetail(await api.journey(active.id));
    }
  }

  // Pulls a fresh live reading on demand (start-screen pre-fill). Auto-adopts the car's nav
  // destination unless the driver already typed one. Best-effort: silent on any failure.
  async function refreshLiveTelemetry() {
    setLiveLoading(true);
    try {
      const live = await api.liveTelemetry();
      setLiveTelemetry(live);
      const navDestination = live.reading?.destination?.trim();
      if (navDestination && !destinationTouchedRef.current) {
        setDestination(navDestination);
      }
    } catch {
      // Telemetry is a bonus on the start screen — never block journey creation on it.
    } finally {
      setLiveLoading(false);
    }
  }

  async function ensureSpotifyDevice(): Promise<string | undefined> {
    if (health?.spotifyMock) {
      return "mock-webplayer";
    }
    if (spotifyDeviceId && spotifyStatus === "ready") {
      return spotifyDeviceId;
    }

    const token = await api.spotifyToken();
    if (!token.premium) {
      setSpotifyStatus("account_error");
      throw new Error("Spotify Premium is required.");
    }

    const { deviceId, player } = await connectSpotifyWebPlayer({
      accessToken: token.accessToken,
      existingPlayer: playerRef.current,
      onStatus: setSpotifyStatus,
      onDeviceLost: () => {
        setSpotifyDeviceId(undefined);
        setSpotifyStatus("not_ready");
      },
      onPlaybackChange: (snapshot) => setIsPaused(snapshot.paused)
    });
    playerRef.current = player;
    setSpotifyDeviceId(deviceId);
    return deviceId;
  }

  function connectSpotify() {
    window.location.assign(api.spotifyLoginUrl);
  }

  async function startJourney() {
    if (!spotifyConnected) {
      connectSpotify();
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const deviceId = await ensureSpotifyDevice();
      const journey = await api.startJourney({
        destination,
        userPrompt: moodPromptFor(selectedMood),
        passengerMode,
        provider: "spotify",
        deviceId
      });
      setActiveJourneyId(journey.id);
      if (deviceId) {
        await api.registerSpotifyDevice(journey.id, { deviceId, status: "ready", syncOnly: true });
      }
      setDetail(await api.journey(journey.id));
      if (playerRef.current) {
        await startSpotifyBrowserPlayback(playerRef.current);
        armKeepAlive();
      }
      await refreshShell();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadTracks(syncPlayback: boolean) {
    if (!activeJourneyId) return;
    setLoading(true);
    setError(undefined);
    try {
      await api.analyze(activeJourneyId);
      // Never hijack a device that is actively playing (e.g. the Tesla via Connect):
      // a refresh then only re-analyzes and reloads the view.
      const playingElsewhere =
        detail?.playbackSession?.status === "playing" &&
        Boolean(detail.journey.spotifyDeviceId) &&
        detail.journey.spotifyDeviceId !== spotifyDeviceId;
      if (syncPlayback && !playingElsewhere && spotifyConnected && !health?.spotifyMock && isSpotifyJourney) {
        try {
          const deviceId = await ensureSpotifyDevice();
          if (deviceId) {
            await api.registerSpotifyDevice(activeJourneyId, { deviceId, status: "ready", syncOnly: true });
          }
          if (playerRef.current) {
            await startSpotifyBrowserPlayback(playerRef.current);
          }
        } catch (playbackError) {
          setError(
            playbackError instanceof Error
              ? `Tracks loaded, but playback is not ready: ${playbackError.message}`
              : "Tracks loaded, but playback is not ready."
          );
        }
      }
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail(await api.journey(activeJourneyId).catch(() => detail));
    } finally {
      setLoading(false);
    }
  }

  async function refreshQueue() {
    await loadTracks(true);
  }

  async function submitMusicWish(text: string, source: "text" | "voice" | "chip" = "text") {
    const trimmed = text.trim();
    if (!activeJourneyId || !trimmed) return;
    setWishLoading(true);
    setError(undefined);
    try {
      await api.createMusicWish(activeJourneyId, { text: trimmed, source });
      setWishText("");
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  async function toggleWishPin(wish: MusicWish) {
    if (!activeJourneyId) return;
    setWishLoading(true);
    try {
      await api.updateMusicWish(activeJourneyId, wish.id, { pinned: !wish.pinned });
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  async function undoWish(wish: MusicWish) {
    if (!activeJourneyId) return;
    setWishLoading(true);
    try {
      await api.undoMusicWish(activeJourneyId, wish.id);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  const VIBE_DIRECTIVES = [
    {
      label: "⚡ Schneller",
      text: "schneller",
      match: (i: { type?: string; direction?: string }) =>
        i?.type === "tempo" && i.direction === "faster",
    },
    {
      label: "🎤 Mitsingen",
      text: "was zum Mitsingen",
      match: (i: { type?: string; role?: string }) =>
        i?.type === "role" && i.role === "singalong",
    },
    {
      label: "☀️ Wach bleiben",
      text: "mach alle wieder wach",
      match: (i: { type?: string; role?: string }) =>
        i?.type === "role" && i.role === "wake_up",
    },
  ] as const;

  function activeVibeWish(
    match: (intent: Record<string, unknown>) => boolean,
  ): MusicWish | undefined {
    return detail?.activeMusicWishes?.find(
      (wish) =>
        wish.pinned &&
        (wish.intents as Record<string, unknown>[]).some(match),
    );
  }

  async function toggleVibeDirective(entry: (typeof VIBE_DIRECTIVES)[number]) {
    if (!activeJourneyId || wishLoading) return;
    const existing = activeVibeWish(entry.match);
    setWishLoading(true);
    setError(undefined);
    try {
      if (existing) {
        await api.undoMusicWish(activeJourneyId, existing.id);
      } else {
        await api.createMusicWish(activeJourneyId, {
          text: entry.text,
          source: "chip",
          pinned: true,
        });
      }
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  async function toggleKidsMode() {
    if (!activeJourneyId || kidsBusy) return;
    setKidsBusy(true);
    setError(undefined);
    try {
      await api.setKidsMode(activeJourneyId, !detail?.journey.kidsMode);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setKidsBusy(false);
    }
  }

  function startWishSpeech() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "de-DE";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      setWishText(transcript);
      void submitMusicWish(transcript, "voice");
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  async function retryAnalysis() {
    await loadTracks(false);
  }

  async function playAudio() {
    if (!activeJourneyId || health?.spotifyMock || !isSpotifyJourney) return;
    setLoading(true);
    setError(undefined);
    try {
      const deviceId = await ensureSpotifyDevice();
      if (deviceId) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        // Explicit user intent: "play here in the browser" may take over playback.
        await api.registerSpotifyDevice(activeJourneyId, { deviceId, status: "ready", syncOnly: true, transfer: true });
      }
      setDetail(await api.journey(activeJourneyId));
      if (playerRef.current) {
        await startSpotifyBrowserPlayback(playerRef.current);
        armKeepAlive();
        setSpotifyStatus("ready");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function skipTrack(direction: "next" | "previous") {
    if (!activeJourneyId || !isSpotifyJourney || health?.spotifyMock) return;
    setLoading(true);
    setError(undefined);
    try {
      // The backend is the single playback authority: it issues an absolute startPlayback of the
      // exact selected track (+ our queue) on the device. We must NOT skip via the Web Playback SDK
      // here — the SDK only skips *relatively*, walking Spotify's own (drifting) queue, which is
      // what made the played track differ from the one shown.
      const deviceId =
        detail?.journey.spotifyDeviceId ?? spotifyDeviceId ?? (await ensureSpotifyDevice().catch(() => undefined));
      await api.skipTrack(activeJourneyId, { direction, deviceId });
      setDetail(await api.journey(activeJourneyId));
      setIsPaused(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

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

  async function selectDevice(device: SpotifyDevice) {
    if (!activeJourneyId) return;
    setShowDevices(false);
    setError(undefined);
    try {
      // Explicit device choice from the menu may take over playback.
      await api.registerSpotifyDevice(activeJourneyId, { deviceId: device.id, status: "ready", syncOnly: true, transfer: true });
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectPhase(key: string) {
    if (!activeJourneyId || retuningPhase || vibeTuning) return;
    if (key === detail?.journey.phase) return;
    setRetuningPhase(key);
    setError(undefined);
    try {
      await api.setPhase(activeJourneyId, key);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetuningPhase(undefined);
    }
  }

  async function toggleAdaptiveMode() {
    if (!activeJourneyId) return;
    const next = !(detail?.context?.adaptiveModeEnabled ?? true);
    setError(undefined);
    try {
      await api.setAdaptiveMode(activeJourneyId, next);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectVibeMix(entry: { key: string; label: string; weight: number }) {
    if (!activeJourneyId || retuningPhase || vibeTuning) return;
    if (entry.key === nearestVibe(detail?.journey.tasteWeight).key) return;
    setVibeTuning(entry.label);
    setError(undefined);
    try {
      await api.setTasteWeight(activeJourneyId, entry.weight);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVibeTuning(undefined);
    }
  }

  useEffect(() => {
    if (!detail?.analysisError) {
      recoveryAttemptedFor.current = undefined;
    }
  }, [detail?.analysisError]);

  useEffect(() => {
    if (!activeJourneyId || !detail || loading) return;
    const shouldRecover =
      detail.needsAnalysis || (Boolean(detail.analysisError) && detail.tracks.length === 0);
    if (!shouldRecover) return;
    if (recoveryAttemptedFor.current === activeJourneyId) return;
    recoveryAttemptedFor.current = activeJourneyId;
    void loadTracks(false);
  }, [activeJourneyId, detail?.needsAnalysis, detail?.analysisError, detail?.tracks.length, loading]);

  async function startTidalJourney() {
    if (!health?.tidalConnected && !health?.tidalMock) {
      window.location.assign(api.tidalLoginUrl);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const journey = await api.startJourney({
        destination,
        userPrompt: moodPromptFor(selectedMood),
        passengerMode,
        provider: "tidal"
      });
      setActiveJourneyId(journey.id);
      setDetail(await api.journey(journey.id));
      await refreshShell();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    if (!activeJourneyId) return;
    setLoading(true);
    try {
      playerRef.current?.disconnect();
      playerRef.current = null;
      keepAliveRef.current?.dispose();
      keepAliveRef.current = null;
      setSpotifyDeviceId(undefined);
      setSpotifyStatus("idle");
      setIsPaused(undefined);
      await api.stop(activeJourneyId);
      setActiveJourneyId(undefined);
      setDetail(undefined);
      await refreshShell({ autoResume: false });
    } finally {
      setLoading(false);
    }
  }

  const primaryLabel = !spotifyConnected
    ? "Connect Spotify"
    : activeJourneyId
      ? "Journey active"
      : "Start Journey";

  const heroTrack = activeTrack ?? displayTracks[0];
  const heroTrackId = heroTrack?.id;
  const upcoming = displayTracks.filter((track) => track.id !== heroTrack?.id).slice(0, 5);

  // Fetch lyrics for the current track when karaoke is open (cached server-side; once per track).
  useEffect(() => {
    if (!karaokeOn || !activeJourneyId || !heroTrackId) return;
    if (lyrics?.trackId === heroTrackId) return;
    let cancelled = false;
    setLyricsLoading(true);
    api
      .lyrics(activeJourneyId, heroTrackId)
      .then((res) => {
        if (!cancelled) setLyrics({ trackId: heroTrackId, synced: res.synced, plain: res.plain });
      })
      .catch(() => {
        if (!cancelled) setLyrics({ trackId: heroTrackId, synced: null, plain: null });
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [karaokeOn, activeJourneyId, heroTrackId, lyrics?.trackId]);

  // Poll the browser player's position to drive synced highlighting. Non-browser playback (car/phone)
  // has no position → the panel just shows static lyrics instead.
  useEffect(() => {
    if (!karaokeOn || !lyrics?.synced || lyrics.synced.length === 0) return;
    const player = playerRef.current;
    if (!player?.getCurrentState) return;
    let active = true;
    const tick = () => {
      player
        .getCurrentState?.()
        .then((state) => {
          if (active && state && typeof state.position === "number") {
            setLyricsPositionMs(state.position);
          }
        })
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 400);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [karaokeOn, lyrics?.synced, lyrics?.trackId]);

  const activeLyricIndex = useMemo(() => {
    const synced = lyrics?.synced;
    if (!synced || synced.length === 0) return -1;
    let index = -1;
    // +250ms lookahead so a line lights up just before it's sung — feels natural to follow.
    for (let i = 0; i < synced.length; i += 1) {
      if (synced[i].timeMs <= lyricsPositionMs + 250) index = i;
      else break;
    }
    return index;
  }, [lyrics?.synced, lyricsPositionMs]);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeLyricIndex]);
  const currentPhase = phaseMeta(detail?.journey.phase);
  const PhaseIcon = currentPhase.Icon;
  const activeVibe = nearestVibe(detail?.journey.tasteWeight);
  const contextPills = buildContextPills(detail?.context);
  const liveness = telemetryLiveness(detail?.context?.lastTelemetryAt, nowMs);
  const driveMode = detail?.context?.driveMode;
  const driveModeLabel = DRIVE_MODE_REASON_LABELS[detail?.context?.driveModeReason ?? ""] ?? detail?.context?.driveModeReason;
  const demo = Boolean(health?.spotifyMock);
  // Connect mode: the truth about a remote device (Tesla native app) lives in the server
  // session (kept fresh by the backend poller) — the local SDK only knows the browser player.
  const remoteDeviceActive = Boolean(
    detail?.journey.spotifyDeviceId &&
      detail.journey.spotifyDeviceId !== spotifyDeviceId,
  );
  const sessionStatus = detail?.playbackSession?.status;
  const playing = remoteDeviceActive
    ? sessionStatus === "playing"
    : isPaused === undefined
      ? isPlayingInBrowser
      : !isPaused;
  const nowLabel = activeTrack ? (playing ? "Now playing" : "Paused") : "Up next";
  const canSkipBack = (detail?.playbackSession?.playedTrackIds?.length ?? 0) > 0;
  const canSkipForward = upcoming.length > 0 || displayTracks.length > 1;

  // Tick once a second so the "Live · vor Xs" badge counts up between the 4s detail polls.
  useEffect(() => {
    if (!activeJourneyId) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeJourneyId]);

  // Mirror the silent keepalive element to the player's play/pause state.
  useEffect(() => {
    const keepAlive = keepAliveRef.current;
    if (!keepAlive) return;
    if (playing) keepAlive.play();
    else keepAlive.pause();
  }, [playing]);

  // Keep the latest playback actions in a ref so background/OS handlers never call stale closures.
  useEffect(() => {
    playbackActionsRef.current = {
      next: () => void skipTrack("next"),
      prev: () => void skipTrack("previous"),
      toggle: () => void togglePlayPause(),
      resume: () => void playAudio()
    };
  });

  // Feed OS / Tesla Miniplayer media controls (also makes its skip buttons work via action handlers).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const metadata =
      typeof MediaMetadata !== "undefined"
        ? new MediaMetadata(buildMediaMetadata(heroTrack))
        : buildMediaMetadata(heroTrack);
    applyMediaSession(navigator as never, {
      metadata,
      playbackState: playing ? "playing" : "paused",
      handlers: {
        play: () => playbackActionsRef.current.toggle(),
        pause: () => playbackActionsRef.current.toggle(),
        nexttrack: () => playbackActionsRef.current.next(),
        previoustrack: () => playbackActionsRef.current.prev()
      }
    });
  }, [heroTrack?.id, heroTrack?.title, playing]);

  // After the embedded browser un-freezes a backgrounded page, re-assert playback.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!activeJourneyId || !isSpotifyJourney || health?.spotifyMock) return;
      playbackActionsRef.current.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [activeJourneyId, isSpotifyJourney, health?.spotifyMock]);

  return (
    <div className="app">
      <div
        aria-hidden="true"
        className="ambient"
        style={heroTrack?.albumArtUrl ? { backgroundImage: `url(${heroTrack.albumArtUrl})` } : undefined}
      />
      <div aria-hidden="true" className="ambient-veil" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Music2 size={20} />
          </span>
          <span className="brand-name">
            Journey<b>DJ</b>
          </span>
        </div>
        <div className="chips">
          {activeJourneyId && detail ? (
            <span className="chip accent">
              <PhaseIcon size={15} /> {currentPhase.label}
            </span>
          ) : null}
          {activeJourneyId && detail?.playbackSession?.status === "external" ? (
            <span
              className="chip warn"
              title="In Spotify läuft ein Track außerhalb der Journey — der DJ pausiert die Kuratierung, bis wieder ein Journey-Song spielt."
            >
              <Radio size={15} /> Externe Wiedergabe
            </span>
          ) : null}
          {activeJourneyId && detail && (health?.teslaConnected || detail.context?.lastTelemetryAt) ? (
            <span
              className={`chip telemetry ${liveness.state}`}
              title={
                liveness.state === "live"
                  ? "Live-Fahrdaten von Tesla kommen gerade rein"
                  : liveness.state === "stale"
                    ? "Letzte Tesla-Fahrdaten – aktuell kein frischer Abruf (Auto schläft/parkt?)"
                    : "Noch keine Live-Fahrdaten abgerufen – Journey starten und losfahren"
              }
            >
              <Satellite size={15} />{" "}
              {liveness.state === "none"
                ? "Keine Live-Daten"
                : liveness.state === "live" && detail?.context?.telemetrySource === "streaming"
                  ? "Live (Streaming)"
                  : liveness.label}
            </span>
          ) : null}
          {activeJourneyId && detail && driveMode && driveMode !== "neutral" ? (
            <span
              className={`chip drive-mode ${driveMode}`}
              title={`${
                driveMode === "calm"
                  ? "Ruhigere, vertraute Musik für die aktuelle Fahrsituation"
                  : "Wachere Musik gegen Monotonie"
              }${
                detail.context?.driveModeSignals?.length ? ` · ${detail.context.driveModeSignals.join(", ")}` : ""
              } — Komfortfunktion, kein Sicherheitssystem.`}
            >
              {driveMode === "calm" ? <Wind size={15} /> : <Moon size={15} />}{" "}
              {driveMode === "calm" ? "Calm" : "Focus"}
              {driveModeLabel ? ` · ${driveModeLabel}` : ""}
            </span>
          ) : null}
          {activeJourneyId && isSpotifyJourney ? (
            <span className="chip">
              <Sparkles size={15} /> Queue {bufferCount}/5
            </span>
          ) : null}
          {health?.songScout && !health.songScout.mock ? (
            <span className="chip" title={health.songScout.webSearch ? "Web-grounded song picks" : "AI song picks"}>
              <Sparkles size={15} />{" "}
              {health.songScout.provider === "xai" ? "Grok" : "Gemini"}
              {health.songScout.webSearch ? " · Search" : ""}
            </span>
          ) : null}
          {demo ? (
            <span className="chip good">
              <BadgeCheck size={15} /> Demo
            </span>
          ) : spotifyConnected ? (
            <button className="chip good chip-btn" onClick={connectSpotify} title="Reconnect Spotify" type="button">
              <BadgeCheck size={15} /> {health?.spotifyPremium ? "Premium" : "Spotify"}
            </button>
          ) : (
            <button className="chip connect" onClick={connectSpotify} type="button">
              <Wifi size={15} /> Connect Spotify
            </button>
          )}
        </div>
      </header>

      <main className="stage-wrap">
        {!activeJourneyId ? (
          <section className="setup glass">
            <div className="setup-eyebrow-row">
              <p className="eyebrow">Telemetry-aware soundtrack</p>
              {liveBadge ? (
                <button
                  className={`live-badge live-${liveBadge.state}`}
                  onClick={refreshLiveTelemetry}
                  disabled={liveLoading}
                  title="Refresh live data from the car"
                  type="button"
                >
                  {liveLoading ? <Loader2 className="spin" size={13} /> : <Satellite size={13} />}
                  {liveBadge.label}
                </button>
              ) : null}
            </div>
            <h1 className="setup-title">Where are we headed?</h1>
            <p className="setup-sub">{statusLine}</p>

            {startContextPills.length > 0 ? (
              <div className="context-strip" aria-label="Live drive context">
                {startContextPills.map((pill) => (
                  <span className="ctx-pill" key={pill.key}>
                    <span className="ctx-label">{pill.label}</span>
                    <span className="ctx-value">{pill.value}</span>
                  </span>
                ))}
              </div>
            ) : null}

            <label className="field">
              <span>Destination</span>
              <input
                onChange={(event) => {
                  destinationTouchedRef.current = true;
                  setDestination(event.target.value);
                }}
                placeholder="e.g. Lago di Garda"
                value={destination}
              />
            </label>
            {navDestinationAvailable || recentDestinations.length > 0 ? (
              <div className="quick-picks" aria-label="Destinations">
                {navDestinationAvailable ? (
                  <button
                    className="quick-pick nav"
                    onClick={() => {
                      destinationTouchedRef.current = true;
                      setDestination(navDestination!);
                    }}
                    title="Use the destination from your car's navigation"
                    type="button"
                  >
                    <Navigation size={13} /> {navDestination}
                  </button>
                ) : null}
                {recentDestinations
                  .filter((place) => place !== navDestination)
                  .map((place) => (
                    <button
                      className={`quick-pick${place === destination ? " on" : ""}`}
                      key={place}
                      onClick={() => {
                        destinationTouchedRef.current = true;
                        setDestination(place);
                      }}
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

            <div className="segments">
              {passengerModes.map((mode) => (
                <button
                  className={passengerMode === mode ? "seg selected" : "seg"}
                  key={mode}
                  onClick={() => setPassengerMode(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>

            <button
              className="cta"
              disabled={loading || (spotifyConnected && !health?.spotifyPremium)}
              onClick={startJourney}
              type="button"
            >
              {loading ? <Loader2 className="spin" size={20} /> : !spotifyConnected ? <Wifi size={20} /> : <Play size={20} />}
              {primaryLabel}
            </button>

            {error ? <p className="error">{error}</p> : null}

            <details className="advanced" onToggle={(event) => setShowAdvanced(event.currentTarget.open)}>
              <summary>More options</summary>
              {showAdvanced ? (
                <div className="advanced-body">
                  <p className="muted">Use TIDAL if Spotify Web Playback is unavailable in your browser.</p>
                  <button className="ghost" disabled={loading} onClick={startTidalJourney} type="button">
                    Start with TIDAL
                  </button>
                  {history.length > 0 ? (
                    <div className="history-list">
                      {history.slice(0, 5).map((journey) => (
                        <button
                          className="history-row"
                          key={journey.id}
                          onClick={() => {
                            setActiveJourneyId(journey.id);
                            api.journey(journey.id).then(setDetail).catch((err) => setError(String(err)));
                          }}
                          type="button"
                        >
                          <span>{journey.destination}</span>
                          <small>
                            {journey.provider} · {new Date(journey.createdAtIso).toLocaleString()}
                          </small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </details>
          </section>
        ) : (
          <section className="cockpit">
            {momentBanner ? (
              <div className={`moment-banner moment-${momentBanner.type}`} role="status">
                <span className="moment-emoji" aria-hidden="true">
                  {momentEventLabel(momentBanner).emoji}
                </span>
                <span className="moment-text">{momentEventLabel(momentBanner).text}</span>
              </div>
            ) : null}
            <div className="stage glass">
              <div className="stage-head">
                <span className="now-label">{nowLabel}</span>
                <span className="dest">
                  <MapPin size={14} /> {detail?.journey.destination}
                </span>
              </div>

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

              {heroTrack ? (
                <div className="hero">
                  <div className="art-xl">
                    {heroTrack.albumArtUrl ? <img alt="" src={heroTrack.albumArtUrl} /> : <Music2 size={72} />}
                  </div>
                  <div className="hero-meta">
                    <h2 className="hero-title">{heroTrack.title}</h2>
                    <p className="hero-artist">{heroTrack.artist}</p>
                    {(() => {
                      const why = detail?.tracks.find(
                        (t) => t.id === heroTrack.id,
                      )?.whyLine;
                      return why ? <p className="why-line">{why}</p> : null;
                    })()}
                    <button
                      className={`lyrics-toggle${karaokeOn ? " on" : ""}`}
                      onClick={() => setKaraokeOn((on) => !on)}
                      type="button"
                    >
                      <Mic size={14} /> {karaokeOn ? "Lyrics aus" : "Mitsingen"}
                    </button>
                  </div>
                </div>
              ) : tracksFailed ? (
                <div className="analyze-failed">
                  <p className="muted big">
                    {detail?.analysisError
                      ? humanizeAnalysisError(detail.analysisError)
                      : "Could not load tracks. Check Gemini and Spotify settings, then retry."}
                  </p>
                  <button className="ctrl primary" disabled={loading} onClick={retryAnalysis} type="button">
                    {loading ? <Loader2 className="spin" size={20} /> : <RefreshCw size={20} />}
                    <span>Retry song picks</span>
                  </button>
                </div>
              ) : (
                <p className="muted big">{loading || tracksPending ? "Finding songs for your journey…" : "No tracks yet."}</p>
              )}

              {karaokeOn && heroTrack ? (
                <div className="karaoke" aria-label="Songtext zum Mitsingen">
                  {lyricsLoading && lyrics?.trackId !== heroTrack.id ? (
                    <p className="karaoke-empty">
                      <Loader2 className="spin" size={16} /> Songtext wird geladen…
                    </p>
                  ) : lyrics?.synced && lyrics.synced.length > 0 ? (
                    <div className="karaoke-lines">
                      {lyrics.synced.map((line, index) => (
                        <p
                          className={`karaoke-line${index === activeLyricIndex ? " active" : ""}`}
                          key={`${line.timeMs}-${index}`}
                          ref={index === activeLyricIndex ? activeLineRef : undefined}
                        >
                          {line.text || "♪"}
                        </p>
                      ))}
                    </div>
                  ) : lyrics?.plain ? (
                    <pre className="karaoke-plain">{lyrics.plain}</pre>
                  ) : (
                    <p className="karaoke-empty">Kein Songtext gefunden — einfach mitsummen 🎶</p>
                  )}
                </div>
              ) : null}

              <div className="transport">
                {demo ? (
                  <span className="transport-note">Demo mode — playback is simulated.</span>
                ) : !isSpotifyJourney ? (
                  detail?.journey.tidalPlaylistUrl ? (
                    <a className="ctrl primary big" href={detail.journey.tidalPlaylistUrl} rel="noreferrer" target="_blank">
                      <Play size={22} />
                      <span>Open TIDAL playlist</span>
                    </a>
                  ) : (
                    <span className="transport-note">Playing on TIDAL.</span>
                  )
                ) : needsPlayAudio ? (
                  <button className="ctrl primary big" disabled={loading} onClick={playAudio} type="button">
                    {loading ? <Loader2 className="spin" size={22} /> : <Play size={22} />}
                    <span>Play audio</span>
                  </button>
                ) : (
                  <>
                    <button
                      className="ctrl"
                      disabled={loading || !canSkipBack}
                      onClick={() => skipTrack("previous")}
                      title="Previous track"
                      type="button"
                    >
                      <SkipBack size={22} />
                      <span className="sr-only">Previous</span>
                    </button>
                    <button className="ctrl primary big" disabled={loading} onClick={togglePlayPause} type="button">
                      {playing ? <Pause size={22} /> : <Play size={22} />}
                      <span>{playing ? "Pause" : "Play"}</span>
                    </button>
                    <button
                      className="ctrl"
                      disabled={loading || !canSkipForward}
                      onClick={() => skipTrack("next")}
                      title="Next track"
                      type="button"
                    >
                      <SkipForward size={22} />
                      <span className="sr-only">Next</span>
                    </button>
                  </>
                )}
                {remoteDeviceActive && (sessionStatus === "playing" || sessionStatus === "paused") ? (
                  <span className="transport-note">
                    {sessionStatus === "playing" ? "Spielt" : "Pausiert"} auf{" "}
                    {activeDeviceLabel(devices, detail?.journey.spotifyDeviceId)}
                  </span>
                ) : null}
                <button className="ctrl" disabled={loading} onClick={refreshQueue} title="Refresh queue" type="button">
                  <RefreshCw className={loading ? "spin" : undefined} size={20} />
                  <span>Refresh</span>
                </button>
                {detail?.journey.spotifyPlaylistUrl ? (
                  <a
                    className="ctrl"
                    href={detail.journey.spotifyPlaylistUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="Open this journey's playlist on Spotify"
                  >
                    <ListMusic size={20} />
                    <span>Playlist</span>
                  </a>
                ) : null}
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
                <button className="ctrl danger" disabled={loading} onClick={stop} title="Stop journey" type="button">
                  <Power size={20} />
                  <span>Stop</span>
                </button>
              </div>

              <div className="vibe-row" role="group" aria-label="Vibe-Direktiven">
                {VIBE_DIRECTIVES.map((entry) => {
                  const active = Boolean(activeVibeWish(entry.match));
                  return (
                    <button
                      className={`vibe-toggle${active ? " on" : ""}`}
                      disabled={wishLoading || !activeJourneyId}
                      key={entry.label}
                      onClick={() => toggleVibeDirective(entry)}
                      type="button"
                    >
                      {entry.label}
                    </button>
                  );
                })}
                <button
                  className={`vibe-toggle${detail?.journey.kidsMode ? " on" : ""}`}
                  disabled={kidsBusy || !activeJourneyId}
                  onClick={toggleKidsMode}
                  title="Kids am Steuer — Disney- & Film-Singalongs für die Kleinen"
                  type="button"
                >
                  🧸 Kids
                </button>
              </div>

              <div className="wish-bar">
                <form
                  className="wish-input"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitMusicWish(wishText, "text");
                  }}
                >
                  <Sparkles size={16} />
                  <input
                    disabled={wishLoading || !activeJourneyId}
                    onChange={(event) => setWishText(event.target.value)}
                    placeholder="Musikwunsch..."
                    value={wishText}
                  />
                  <button className="icon-btn" disabled={wishLoading || !wishText.trim()} title="Wunsch senden" type="submit">
                    {wishLoading ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                  </button>
                  <button
                    className={`icon-btn${listening ? " on" : ""}`}
                    disabled={!speechSupported || wishLoading}
                    onClick={startWishSpeech}
                    title={speechSupported ? "Spracheingabe" : "Spracheingabe ist in diesem Browser nicht verfügbar"}
                    type="button"
                  >
                    <Mic size={16} />
                  </button>
                </form>
                <div className="wish-chips">
                  {["Mitsingen", "Mehr Pop", "Weniger ruhig"].map((chip) => (
                    <button disabled={wishLoading} key={chip} onClick={() => submitMusicWish(chip, "chip")} type="button">
                      {chip}
                    </button>
                  ))}
                  <button className="wish-drawer-toggle" onClick={() => setWishDrawerOpen(true)} type="button">
                    Wünsche
                  </button>
                </div>
                {detail?.activeMusicWishes?.length ? (
                  <div className="wish-active">
                    {detail.activeMusicWishes.slice(0, 2).map((wish) => (
                      <span className="wish-layer" key={wish.id}>
                        {wish.summary} · {wish.pinned ? "Pinned" : `${wish.remainingTracks} Songs`}
                        <button onClick={() => undoWish(wish)} title="Undo" type="button">
                          <RotateCcw size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              {error ? <p className="error">{error}</p> : null}
            </div>

            <aside className="rail glass">
              <div className="rail-head">
                <span>Up next</span>
                <span className="counter">{bufferCount}/5</span>
              </div>
              <ol className="queue">
                {upcoming.length > 0 ? (
                  upcoming.map((track, index) => (
                    <li
                      className="q-row"
                      key={`${detail?.journey.phase}-${track.id}`}
                      style={{ animationDelay: `${index * 60}ms` }}
                    >
                      <span className="q-num">{index + 1}</span>
                      <span className="q-art">
                        {track.albumArtUrl ? <img alt="" src={track.albumArtUrl} /> : <Music2 size={18} />}
                      </span>
                      <span className="q-meta">
                        <span className="q-title">{track.title}</span>
                        <span className="q-artist">{track.artist}</span>
                      </span>
                    </li>
                  ))
                ) : tracksFailed ? (
                  <li className="muted">No queue yet — retry song picks above.</li>
                ) : (
                  <li className="muted">Buffering upcoming tracks…</li>
                )}
              </ol>

              <div className="phase-rail" aria-label="Steer the drive vibe">
                {PHASES.map((entry) => {
                  const Icon = entry.Icon;
                  const isActive = entry.key === detail?.journey.phase;
                  const isPending = entry.key === retuningPhase;
                  return (
                    <button
                      aria-pressed={isActive}
                      className={`phase${isActive ? " on" : ""}${isPending ? " pending" : ""}`}
                      disabled={Boolean(retuningPhase) || Boolean(vibeTuning)}
                      key={entry.key}
                      onClick={() => selectPhase(entry.key)}
                      title={`Steer the soundtrack toward "${entry.label}"`}
                      type="button"
                    >
                      {isPending ? <Loader2 className="spin" size={15} /> : <Icon size={15} />}
                      {isActive || isPending ? <em>{entry.label}</em> : null}
                    </button>
                  );
                })}
              </div>

              <div className="adaptive-toggle">
                <button
                  aria-pressed={detail?.context?.adaptiveModeEnabled ?? true}
                  className={`ghost adaptive-btn${(detail?.context?.adaptiveModeEnabled ?? true) ? " on" : ""}`}
                  onClick={toggleAdaptiveMode}
                  title="Passt die Musik automatisch an die Fahrsituation an (Stau, Reichweite, Nachtfahrt). Komfortfunktion — kein Sicherheitssystem."
                  type="button"
                >
                  <Wind size={14} /> Adaptive Drive Mode: {(detail?.context?.adaptiveModeEnabled ?? true) ? "An" : "Aus"}
                </button>
                <small className="muted">Komfortfunktion, kein Sicherheitssystem.</small>
              </div>

              <div className="vibe-mix" aria-label="Familiarity versus discovery">
                <div className="vibe-head">
                  <span className="vibe-title">
                    <Sparkles size={13} /> Vibe-Mix
                  </span>
                  <span className="vibe-sub">Familiar ↔ Discover</span>
                </div>
                <div className="vibe-segments" role="group">
                  {VIBE_MIX.map((entry) => {
                    const Icon = entry.Icon;
                    const isActive = entry.key === activeVibe.key;
                    const isPending = entry.label === vibeTuning;
                    return (
                      <button
                        aria-pressed={isActive}
                        className={`vibe${isActive ? " on" : ""}${isPending ? " pending" : ""}`}
                        disabled={Boolean(vibeTuning) || Boolean(retuningPhase)}
                        key={entry.key}
                        onClick={() => selectVibeMix(entry)}
                        title={`${entry.label} — ${Math.round(entry.weight * 100)}% an deinem Geschmack`}
                        type="button"
                      >
                        {isPending ? <Loader2 className="spin" size={15} /> : <Icon size={15} />}
                        <span>{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
                {detail?.taste?.topGenres?.length ? (
                  <p className="vibe-genres">
                    <span>Your genres</span> {detail.taste.topGenres.slice(0, 4).join(" · ")}
                  </p>
                ) : null}
              </div>
            </aside>

            {retuningPhase || vibeTuning || detail?.analysisPending ? (
              <div className="retuning" role="status">
                <div className="retuning-card">
                  <span className="retuning-orb" aria-hidden="true" />
                  <span className="retuning-label">
                    {vibeTuning || !retuningPhase ? "Adjusting mix" : "Re-tuning the vibe"}
                  </span>
                  <strong className="retuning-phase">
                    {vibeTuning ?? (retuningPhase ? phaseMeta(retuningPhase).label : "Adjusting mix")}
                  </strong>
                </div>
              </div>
            ) : null}
            {wishDrawerOpen ? (
              <div className="wish-drawer" role="dialog" aria-label="Music wishes">
                <div className="wish-drawer-head">
                  <span>Music Wishes</span>
                  <button className="icon-btn" onClick={() => setWishDrawerOpen(false)} type="button">
                    <X size={16} />
                  </button>
                </div>
                <div className="wish-drawer-chips">
                  {["Spiel jetzt gute Laune", "Mehr 90s Pop", "Nicht so langsam", "Für die Kinder hinten"].map((chip) => (
                    <button disabled={wishLoading} key={chip} onClick={() => submitMusicWish(chip, "chip")} type="button">
                      {chip}
                    </button>
                  ))}
                </div>
                <div className="wish-list">
                  {(detail?.recentMusicWishes ?? []).length ? (
                    detail!.recentMusicWishes!.map((wish) => (
                      <div className={`wish-card ${wish.status}`} key={wish.id}>
                        <div>
                          <strong>{wish.summary}</strong>
                          <small>{wish.status} · {wish.pinned ? "pinned" : `${wish.remainingTracks}/${wish.expiresAfterTracks} songs`}</small>
                        </div>
                        <div className="wish-card-actions">
                          <button onClick={() => toggleWishPin(wish)} title={wish.pinned ? "Unpin" : "Pin"} type="button">
                            {wish.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                          </button>
                          <button onClick={() => undoWish(wish)} title="Undo" type="button">
                            <RotateCcw size={15} />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="muted">Noch keine Musikwünsche.</p>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
