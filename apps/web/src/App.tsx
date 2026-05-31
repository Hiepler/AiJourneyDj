import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Coffee,
  Compass,
  Crosshair,
  Heart,
  ListMusic,
  Loader2,
  MapPin,
  Music2,
  Navigation,
  Pause,
  Play,
  Power,
  RefreshCw,
  Route,
  Scale,
  SkipBack,
  SkipForward,
  Sparkles,
  Sunset,
  Wifi
} from "lucide-react";

import { api, type Health, type Journey, type JourneyDetail } from "./lib/api.js";
import {
  connectSpotifyWebPlayer,
  spotifySdkStatusLabel,
  startSpotifyBrowserPlayback,
  type SpotifyPlayerInstance,
  type SpotifySdkStatus
} from "./spotifyPlayer.js";
import { MOOD_PRESETS, moodPromptFor } from "./lib/moods.js";
import { buildContextPills } from "./lib/driveContext.js";
import { applyMediaSession, buildMediaMetadata, createSilentKeepAlive, type SilentKeepAlive } from "./backgroundAudio.js";

const passengerModes = ["solo", "couple", "family", "friends"];

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
  const [selectedMood, setSelectedMood] = useState(MOOD_PRESETS[0].key);
  const [passengerMode, setPassengerMode] = useState("couple");
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifySdkStatus>("idle");
  const [spotifyDeviceId, setSpotifyDeviceId] = useState<string>();
  const [isPaused, setIsPaused] = useState<boolean | undefined>();
  const [retuningPhase, setRetuningPhase] = useState<string>();
  const [vibeTuning, setVibeTuning] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const playerRef = useRef<SpotifyPlayerInstance | null>(null);
  const recoveryAttemptedFor = useRef<string | undefined>(undefined);
  const keepAliveRef = useRef<SilentKeepAlive | null>(null);
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

  const queuedIds = detail?.playbackSession?.queuedTrackIds ?? [];
  const bufferTracks = useMemo(() => {
    if (!detail) return [];
    const queued = new Set(queuedIds);
    return detail.tracks.filter((track) => queued.has(track.id));
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
      if (syncPlayback && spotifyConnected && !health?.spotifyMock && isSpotifyJourney) {
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
        await api.registerSpotifyDevice(activeJourneyId, { deviceId, status: "ready", syncOnly: true });
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
      const deviceId = spotifyDeviceId ?? (await ensureSpotifyDevice().catch(() => undefined));
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
  const upcoming = displayTracks.filter((track) => track.id !== heroTrack?.id).slice(0, 5);
  const currentPhase = phaseMeta(detail?.journey.phase);
  const PhaseIcon = currentPhase.Icon;
  const activeVibe = nearestVibe(detail?.journey.tasteWeight);
  const contextPills = buildContextPills(detail?.context);
  const demo = Boolean(health?.spotifyMock);
  const playing = isPaused === undefined ? isPlayingInBrowser : !isPaused;
  const nowLabel = activeTrack ? (playing ? "Now playing" : "Paused") : "Up next";
  const canSkipBack = (detail?.playbackSession?.playedTrackIds?.length ?? 0) > 0;
  const canSkipForward = upcoming.length > 0 || displayTracks.length > 1;

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
            <p className="eyebrow">Telemetry-aware soundtrack</p>
            <h1 className="setup-title">Where are we headed?</h1>
            <p className="setup-sub">{statusLine}</p>

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
                <button className="ctrl danger" disabled={loading} onClick={stop} title="Stop journey" type="button">
                  <Power size={20} />
                  <span>Stop</span>
                </button>
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

            {retuningPhase || vibeTuning ? (
              <div className="retuning" role="status">
                <div className="retuning-card">
                  <span className="retuning-orb" aria-hidden="true" />
                  <span className="retuning-label">{vibeTuning ? "Adjusting mix" : "Re-tuning the vibe"}</span>
                  <strong className="retuning-phase">{vibeTuning ?? phaseMeta(retuningPhase).label}</strong>
                </div>
              </div>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
