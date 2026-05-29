# Tesla Fleet Telemetry Notes

This directory is reserved for local Tesla Fleet Telemetry configuration files
that should not be committed, such as generated keys and vehicle-specific
configuration.

The v1 development stack expects the official Tesla Fleet Telemetry reference
server to dispatch normalized records into Redpanda/Kafka:

- Broker: `localhost:19092` locally or `redpanda:19092` inside Docker Compose.
- Topic: `tesla.telemetry.normalized`.
- Backend env: `TESLA_TELEMETRY_ENABLED=true`.

For local work without a vehicle, use:

```bash
npm run telemetry:sim -w @ai-journey-dj/api
```

The simulator emits the same normalized event shape used by the backend.
