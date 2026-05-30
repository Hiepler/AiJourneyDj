import { describe, expect, it } from "vitest";

import { MOOD_PRESETS, moodPromptFor } from "./moods.js";

describe("mood presets", () => {
  it("exposes 6 presets, each with key/label/prompt, default cinematic first", () => {
    expect(MOOD_PRESETS).toHaveLength(6);
    expect(MOOD_PRESETS[0].key).toBe("cinematic");
    for (const preset of MOOD_PRESETS) {
      expect(preset.key).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.prompt.length).toBeGreaterThan(8);
      expect(typeof preset.Icon).toBe("object");
    }
    // keys are unique
    expect(new Set(MOOD_PRESETS.map((preset) => preset.key)).size).toBe(MOOD_PRESETS.length);
  });

  it("maps a key to its prompt and falls back to cinematic for unknown keys", () => {
    expect(moodPromptFor("euphoric")).toMatch(/uplifting/i);
    expect(moodPromptFor("does-not-exist")).toBe(moodPromptFor("cinematic"));
  });
});
