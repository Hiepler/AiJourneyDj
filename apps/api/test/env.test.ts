import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env.js";

describe("env", () => {
  it("converts journey refresh minutes to milliseconds", () => {
    const config = loadConfig({
      JOURNEY_REFRESH_MINUTES: "3"
    });

    expect(config.JOURNEY_REFRESH_MINUTES).toBe(3);
    expect(config.journeyRefreshMs).toBe(180_000);
  });

  it("defaults journey refresh to twelve minutes", () => {
    const config = loadConfig({});

    expect(config.JOURNEY_REFRESH_MINUTES).toBe(12);
    expect(config.journeyRefreshMs).toBe(720_000);
  });
});
