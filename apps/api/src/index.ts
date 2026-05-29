import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({ path: resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env") });

import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";
import { startTelemetryConsumer } from "./telemetry/kafkaConsumer.js";

const config = loadConfig();
const { app, journeyService } = await buildApp(config);

await startTelemetryConsumer(config, journeyService).catch((error) => {
  app.log.error({ error }, "Tesla telemetry consumer failed to start.");
});

const runJourneyWorker = () => {
  journeyService.maybeRefreshActiveJourneys().catch((error) => {
    app.log.error({ error }, "Journey worker failed.");
  });
};

runJourneyWorker();
const worker = setInterval(runJourneyWorker, 60_000);

process.on("SIGTERM", async () => {
  clearInterval(worker);
  await app.close();
});

await app.listen({
  host: config.API_HOST,
  port: config.API_PORT
});
