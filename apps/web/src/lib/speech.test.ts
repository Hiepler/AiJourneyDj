import { describe, expect, it } from "vitest";

import { getSpeechRecognitionCtor, isSpeechRecognitionSupported } from "./speech.js";

describe("speech helpers", () => {
  it("detects missing speech recognition", () => {
    expect(isSpeechRecognitionSupported({})).toBe(false);
    expect(getSpeechRecognitionCtor({})).toBeUndefined();
  });

  it("detects prefixed browser speech recognition", () => {
    class FakeRecognition {}
    const win = { webkitSpeechRecognition: FakeRecognition };

    expect(isSpeechRecognitionSupported(win)).toBe(true);
    expect(getSpeechRecognitionCtor(win)).toBe(FakeRecognition);
  });
});
