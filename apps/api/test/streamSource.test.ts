import { describe, expect, it } from "vitest";

import { shouldPollRest, StreamLiveness } from "../src/telemetry/streamSource.js";

describe("shouldPollRest", () => {
  const now = Date.parse("2026-06-02T12:00:00.000Z");
  const windowMs = 90_000;

  it("polls when streaming has never produced data", () => {
    expect(shouldPollRest(undefined, now, windowMs)).toBe(true);
  });
  it("stands down while streaming is fresh", () => {
    expect(shouldPollRest("2026-06-02T11:59:30.000Z", now, windowMs)).toBe(false); // 30s ago
  });
  it("resumes polling once streaming is stale", () => {
    expect(shouldPollRest("2026-06-02T11:58:00.000Z", now, windowMs)).toBe(true); // 2 min ago
  });
  it("polls on an unparseable timestamp", () => {
    expect(shouldPollRest("nonsense", now, windowMs)).toBe(true);
  });
});

describe("StreamLiveness", () => {
  it("records the last stream time and reports source", () => {
    const live = new StreamLiveness();
    expect(live.lastIso()).toBeUndefined();
    live.mark("2026-06-02T12:00:00.000Z");
    expect(live.lastIso()).toBe("2026-06-02T12:00:00.000Z");
  });
});
