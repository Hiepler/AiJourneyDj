export type SpeechCtor = new () => {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
};

// Uses `new (...args: never[]) => unknown` so tests can pass minimal fake constructors
// without implementing the full SpeechRecognition instance shape.
type AnyCtor = new (...args: never[]) => unknown;

type SpeechWindow = {
  SpeechRecognition?: AnyCtor;
  webkitSpeechRecognition?: AnyCtor;
};

export function getSpeechRecognitionCtor(win: SpeechWindow = window as SpeechWindow): SpeechCtor | undefined {
  return (win.SpeechRecognition ?? win.webkitSpeechRecognition) as SpeechCtor | undefined;
}

export function isSpeechRecognitionSupported(win: SpeechWindow = window as SpeechWindow): boolean {
  return Boolean(getSpeechRecognitionCtor(win));
}
