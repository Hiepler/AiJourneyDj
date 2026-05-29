import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Coffee,
  Crosshair,
  Loader2,
  MapPin,
  Music2,
  Navigation,
  Pause,
  Play,
  Power,
  RefreshCw,
  Route,
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

export function App() {
  const [health, setHealth] = useState<Health>();
  const [history, setHistory] = useState<Journey[]>([]);
  const [activeJourneyId, setActiveJourneyId] = useState<string>();
  const [detail, setDetail] = useState<JourneyDetail>();
  const [destination, setDestination] = useState("Lago di Garda");
  const [userPrompt, setUserPrompt] = useState("cinematic golden-hour drive, focused but emotional");
  const [passengerMode, setPassengerMode] = useState("couple");
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifySdkStatus>("idle");
  const [spotifyDeviceId, setSpotifyDeviceId] = useState<string>();
  const [isPaused, setIsPaused] = useState<boolean | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const playerRef = useRef<SpotifyPlayerInstance | null>(null);
  const recoveryAttemptedFor = useRef<string | undefined>(undefined);

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
        userPrompt,
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
        setSpotifyStatus("ready");
      }
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
    try {
      await player.togglePlay();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!activeJourneyId || !detail || loading) return;
    if (!detail.needsAnalysis) return;
    if (recoveryAttemptedFor.current === activeJourneyId) return;
    recoveryAttemptedFor.current = activeJourneyId;
    void loadTracks(false);
  }, [activeJourneyId, detail?.needsAnalysis, loading]);

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
        userPrompt,
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
  const demo = Boolean(health?.spotifyMock);
  const playing = isPaused === undefined ? isPlayingInBrowser : !isPaused;
  const nowLabel = activeTrack ? (playing ? "Now playing" : "Paused") : "Up next";

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
            <label className="field">
              <span>Mood &amp; direction</span>
              <textarea onChange={(event) => setUserPrompt(event.target.value)} rows={2} value={userPrompt} />
            </label>

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
                <p className="muted big">
                  {detail?.analysisError ?? "Could not load tracks. Check xAI and Spotify settings, then refresh."}
                </p>
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
                  <button className="ctrl primary big" disabled={loading} onClick={togglePlayPause} type="button">
                    {playing ? <Pause size={22} /> : <Play size={22} />}
                    <span>{playing ? "Pause" : "Play"}</span>
                  </button>
                )}
                <button className="ctrl" disabled={loading} onClick={refreshQueue} title="Refresh queue" type="button">
                  <RefreshCw className={loading ? "spin" : undefined} size={20} />
                  <span>Refresh</span>
                </button>
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
                    <li className="q-row" key={track.id}>
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
                ) : (
                  <li className="muted">Buffering upcoming tracks…</li>
                )}
              </ol>

              <div className="phase-rail" aria-label="Drive phase">
                {PHASES.map((entry) => {
                  const Icon = entry.Icon;
                  const isActive = entry.key === detail?.journey.phase;
                  return (
                    <span className={isActive ? "phase on" : "phase"} key={entry.key} title={entry.label}>
                      <Icon size={15} />
                      {isActive ? <em>{entry.label}</em> : null}
                    </span>
                  );
                })}
              </div>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}
