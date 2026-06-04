import { describe, expect, it } from "vitest";

import {
  musicWishSummary,
  parseMusicWish,
  roleTagsForWish,
} from "./musicWish.js";

describe("parseMusicWish", () => {
  it("parses explicit immediate song wishes", () => {
    const wish = parseMusicWish("spiel jetzt Taylor Swift - Shake It Off");

    expect(wish.status).toBe("active");
    expect(wish.confidence).toBeGreaterThanOrEqual(0.8);
    expect(wish.intents).toEqual([
      { type: "song", artist: "Taylor Swift", title: "Shake It Off", immediate: true },
    ]);
    expect(musicWishSummary(wish.intents)).toBe("Spiel jetzt Shake It Off");
  });

  it("parses non-immediate artist boosts", () => {
    const wish = parseMusicWish("mehr Taylor Swift");

    expect(wish.status).toBe("active");
    expect(wish.intents).toEqual([
      { type: "artist", artist: "Taylor Swift", strength: 0.9 },
    ]);
    expect(musicWishSummary(wish.intents)).toBe("Mehr Taylor Swift");
  });

  it("parses avoid wishes without interrupting playback", () => {
    const wish = parseMusicWish("nicht schon wieder Dua Lipa");

    expect(wish.status).toBe("active");
    expect(wish.intents).toEqual([
      { type: "avoid", artists: ["Dua Lipa"] },
    ]);
    expect(wish.intents.some((intent) => "immediate" in intent && intent.immediate)).toBe(false);
  });

  it("parses simple role wishes", () => {
    expect(parseMusicWish("was zum Mitsingen").intents).toEqual([
      { type: "role", role: "singalong", strength: 0.86 },
    ]);
    expect(parseMusicWish("mach alle wieder wach").intents).toEqual([
      { type: "role", role: "wake_up", strength: 0.86 },
    ]);
    expect(roleTagsForWish("singalong")).toEqual([
      "pop",
      "dance-pop",
      "feelgood",
      "karaoke",
    ]);
  });

  it("returns pending confirmation for ambiguous text", () => {
    const wish = parseMusicWish("irgendwie anders");

    expect(wish.status).toBe("pending_confirmation");
    expect(wish.confidence).toBeLessThan(0.65);
    expect(wish.intents).toEqual([]);
    expect(wish.summary).toBe("Ich bin nicht sicher, welchen Musikwunsch du meinst.");
  });
});
