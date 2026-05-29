import { describe, expect, it } from "vitest";

import { spotifyBrowserCapability, spotifySdkStatusLabel } from "./spotifyPlayer.js";

describe("spotify player helpers", () => {
  it("reports missing EME support as a browser fallback condition", () => {
    expect(
      spotifyBrowserCapability({
        hasSpotifySdk: true,
        hasMediaKeys: false
      })
    ).toEqual({
      ok: false,
      reason: "encrypted_media_unavailable"
    });
  });

  it("maps SDK errors to user-friendly status labels", () => {
    expect(spotifySdkStatusLabel("ready")).toBe("Player ready");
    expect(spotifySdkStatusLabel("account_error")).toBe("Spotify Premium required");
    expect(spotifySdkStatusLabel("autoplay_failed")).toBe("Tap Start again to unlock audio");
  });
});
