import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({ path: resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env") });

import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";
import { startTelemetryConsumer } from "./telemetry/kafkaConsumer.js";
import { startTeslaFleetPoller } from "./telemetry/teslaFleetPoller.js";
import { startSpotifyPlaybackPoller } from "./playback/spotifyPlaybackPoller.js";

const config = loadConfig();
const { app, store, journeyService, teslaAuth } = await buildApp(config);

await startTelemetryConsumer(config, journeyService).catch((error) => {
  app.log.error({ error }, "Tesla telemetry consumer failed to start.");
});

const teslaPoller = startTeslaFleetPoller(config, store, teslaAuth, journeyService, app.log);
const spotifyPoller = startSpotifyPlaybackPoller(config, store, journeyService, app.log);

const runJourneyWorker = () => {
  journeyService.maybeRefreshActiveJourneys().catch((error) => {
    app.log.error({ error }, "Journey worker failed.");
  });
};

runJourneyWorker();
const worker = setInterval(runJourneyWorker, 60_000);

process.on("SIGTERM", async () => {
  clearInterval(worker);
  if (teslaPoller) clearInterval(teslaPoller);
  spotifyPoller.stop();
  await app.close();
});

await app.listen({
  host: config.API_HOST,
  port: config.API_PORT
});
