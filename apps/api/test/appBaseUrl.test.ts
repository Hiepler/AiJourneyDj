import { describe, expect, it } from "vitest";

import { appBaseUrl } from "../src/http/appBaseUrl.js";
import { loadConfig } from "../src/config/env.js";

describe("appBaseUrl", () => {
  it("prefers the request origin over APP_BASE_URL", () => {
    const config = loadConfig({ APP_BASE_URL: "http://localhost:5173" });
    const base = appBaseUrl(
      {
        headers: {
          origin: "http://192.168.1.127:5173"
        }
      } as never,
      config
    );

    expect(base).toBe("http://192.168.1.127:5173");
  });

  it("falls back to APP_BASE_URL when no origin is present", () => {
    const config = loadConfig({ APP_BASE_URL: "http://localhost:5173" });
    expect(appBaseUrl({ headers: {} } as never, config)).toBe("http://localhost:5173");
  });
});
