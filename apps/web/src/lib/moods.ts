import { Coffee, Crosshair, Disc3, Mountain, Sparkles, Sunset, type LucideIcon } from "lucide-react";

export interface MoodPreset {
  key: string;
  label: string;
  Icon: LucideIcon;
  /** Prompt text handed to the recommendation engine as `userPrompt`. */
  prompt: string;
}

// Order matters: index 0 is the default selection.
export const MOOD_PRESETS: MoodPreset[] = [
  { key: "cinematic", label: "Cinematic", Icon: Sunset, prompt: "cinematic, widescreen, emotional but focused drive" },
  { key: "focused", label: "Focused", Icon: Crosshair, prompt: "calm focused flow, low-distraction, steady" },
  { key: "euphoric", label: "Euphoric", Icon: Sparkles, prompt: "uplifting, high-energy, feel-good momentum" },
  { key: "mellow", label: "Mellow", Icon: Coffee, prompt: "relaxed, warm, easygoing cruise" },
  { key: "nostalgic", label: "Nostalgic", Icon: Disc3, prompt: "nostalgic throwback warmth, timeless feel" },
  { key: "adventure", label: "Adventure", Icon: Mountain, prompt: "bold, driving, sense of adventure and discovery" }
];

export function moodPromptFor(key: string): string {
  return (MOOD_PRESETS.find((preset) => preset.key === key) ?? MOOD_PRESETS[0]).prompt;
}
