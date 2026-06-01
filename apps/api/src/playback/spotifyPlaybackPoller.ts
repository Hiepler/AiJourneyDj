import type { AppConfig } from "../config/env.js";
import type { JourneyService } from "../journeys/journeyService.js";
import type { Store } from "../db/store.js";
import { nextPollIntervalSeconds } from "./reconcile.js";

export interface SpotifyPollDeps {
  listActiveSpotifyJourneyIds: () => string[];
  reconcile: (journeyId: string) => Promise<"playing" | "idle" | "external">;
  activeSeconds: number;
  idleSeconds: number;
}

/**
 * Runs a single reconciliation pass over all active Spotify journeys and returns the number of
 * seconds the poller should wait before the next tick (adaptive: fast while playing, slow otherwise).
 * Pure of timers/scheduling so it can be unit-tested directly.
 */
export async function runSpotifyPollTick(deps: SpotifyPollDeps): Promise<number> {
  const journeyIds = deps.listActiveSpotifyJourneyIds();
  if (journeyIds.length === 0) {
    return deps.idleSeconds;
  }

  let outcome: "playing" | "idle" | "external" = "idle";
  for (const journeyId of journeyIds) {
    const result = await deps.reconcile(journeyId);
    // "playing" wins (poll fast); "external" beats "idle" but still backs off.
    if (result === "playing") outcome = "playing";
    else if (result === "external" && outcome !== "playing") outcome = "external";
  }

  return nextPollIntervalSeconds(outcome, { activeSeconds: deps.activeSeconds, idleSeconds: deps.idleSeconds });
}

export interface SpotifyPollerHandle {
  stop: () => void;
}

/**
 * Self-scheduling poller that keeps the backend playback model in sync with what Spotify is
 * actually playing, so skips in the native Tesla miniplayer are detected and trigger refill.
 * Each tick picks its own next interval; no fixed setInterval.
 */
export function startSpotifyPlaybackPoller(
  config: AppConfig,
  store: Store,
  journeyService: JourneyService,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void }
): SpotifyPollerHandle {
  if (!config.SPOTIFY_PLAYBACK_POLL_ENABLED) {
    return { stop: () => {} };
  }

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (seconds: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), seconds * 1000);
  };

  const tick = async () => {
    let nextSeconds = config.SPOTIFY_PLAYBACK_POLL_IDLE_SECONDS;
    try {
      nextSeconds = await runSpotifyPollTick({
        listActiveSpotifyJourneyIds: () =>
          store.listActiveJourneys().filter((journey) => journey.provider === "spotify").map((journey) => journey.id),
        reconcile: (journeyId) => journeyService.reconcileSpotifyPlayback(journeyId),
        activeSeconds: config.SPOTIFY_PLAYBACK_POLL_ACTIVE_SECONDS,
        idleSeconds: config.SPOTIFY_PLAYBACK_POLL_IDLE_SECONDS
      });
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "spotify.poll_error");
    }
    schedule(nextSeconds);
  };

  // First tick after the idle delay so boot isn't hammered before a journey/device exists.
  schedule(config.SPOTIFY_PLAYBACK_POLL_IDLE_SECONDS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
