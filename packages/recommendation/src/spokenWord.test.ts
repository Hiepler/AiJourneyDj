import { describe, expect, it } from "vitest";

import { looksLikeSpokenWord } from "./spokenWord.js";

describe("looksLikeSpokenWord", () => {
  it("flags German Hörspiel / audiobook tracks", () => {
    expect(looksLikeSpokenWord("Die drei ???", "Folge 215: Feuriges Auge")).toBe(true);
    expect(looksLikeSpokenWord("Bibi Blocksberg", "Kapitel 1")).toBe(true);
    expect(looksLikeSpokenWord("TKKG", "Teil 12 - Die Jagd")).toBe(true);
    expect(looksLikeSpokenWord("Benjamin Blümchen", "Als Pilot")).toBe(true);
    expect(
      looksLikeSpokenWord("Sebastian Fitzek", "Das Geschenk (Ungekürzt)"),
    ).toBe(true);
    expect(looksLikeSpokenWord("Some Narrator", "Gute Nacht Geschichte")).toBe(
      true,
    );
    expect(looksLikeSpokenWord("Irgendwer", "Das große Hörspiel")).toBe(true);
    expect(looksLikeSpokenWord("Bibi und Tina", "Intro")).toBe(true);
  });

  it("does not flag real songs (no false positives)", () => {
    expect(looksLikeSpokenWord("Tame Impala", "The Less I Know the Better")).toBe(
      false,
    );
    expect(looksLikeSpokenWord("Bonobo", "Kerala")).toBe(false);
    expect(looksLikeSpokenWord("AnnenMayKantereit", "Pocahontas")).toBe(false);
    expect(looksLikeSpokenWord("Beatles", "Eight Days a Week")).toBe(false);
    expect(looksLikeSpokenWord("Drei Meter Feldweg", "Sommer")).toBe(false);
    // "Part" in an English title must not trip the German episode heuristic.
    expect(looksLikeSpokenWord("Coldplay", "Part of the Plan")).toBe(false);
  });
});
