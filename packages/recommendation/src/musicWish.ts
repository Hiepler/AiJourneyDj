import { normalizeText, songKey } from "@ai-journey-dj/core";

export type MusicWishSource = "text" | "voice" | "chip";

export type MusicWishStatus =
  | "pending_confirmation"
  | "active"
  | "soft_applied"
  | "expired"
  | "undone"
  | "failed";

export type MusicWishIntent =
  | { type: "song"; artist?: string; title: string; immediate: boolean }
  | { type: "artist"; artist: string; strength: number }
  | { type: "genre"; genre: string; strength: number }
  | { type: "mood"; moodTags: string[]; strength: number }
  | {
      type: "avoid";
      artists?: string[];
      songKeys?: string[];
      moodTags?: string[];
    }
  | {
      type: "role";
      role: "singalong" | "wake_up" | "kids" | "calm_down";
      strength: number;
    };

export interface ParsedMusicWish {
  rawText: string;
  status: "active" | "pending_confirmation";
  confidence: number;
  summary: string;
  intents: MusicWishIntent[];
}

const ROLE_PATTERNS: Array<{
  role: Extract<MusicWishIntent, { type: "role" }>["role"];
  patterns: string[];
}> = [
  { role: "singalong", patterns: ["mitsingen", "singalong", "karaoke"] },
  { role: "wake_up", patterns: ["wach", "aufwecken", "energie", "wieder wach"] },
  { role: "kids", patterns: ["kinder", "kids", "hinten", "backseat"] },
  { role: "calm_down", patterns: ["ruhiger", "calm", "runter", "entspannen"] },
];

const GENRE_TAGS: Record<string, string[]> = {
  "90s": ["90s", "classic pop"],
  pop: ["pop"],
  "dance pop": ["dance-pop", "pop"],
  "dance-pop": ["dance-pop", "pop"],
  disney: ["disney", "family", "singalong"],
  schlager: ["schlager", "party"],
};

function cleanSubject(value: string): string {
  return value
    .replace(/[.!?]+$/g, "")
    .replace(/^von\s+/i, "")
    .trim();
}

function titleCaseWords(value: string): string {
  return cleanSubject(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function roleTagsForWish(
  role: Extract<MusicWishIntent, { type: "role" }>["role"],
): string[] {
  if (role === "singalong") return ["pop", "dance-pop", "feelgood", "karaoke"];
  if (role === "wake_up") return ["feelgood", "dance-pop", "pop rock"];
  if (role === "kids") return ["family", "kids", "pop", "singalong"];
  return ["mellow", "acoustic", "chillout"];
}

export function musicWishSummary(intents: MusicWishIntent[]): string {
  const first = intents[0];
  if (!first) return "Ich bin nicht sicher, welchen Musikwunsch du meinst.";
  if (first.type === "song") return `${first.immediate ? "Spiel jetzt" : "Mehr"} ${first.title}`;
  if (first.type === "artist") return `Mehr ${first.artist}`;
  if (first.type === "genre") return `Mehr ${first.genre}`;
  if (first.type === "mood") return `Mehr ${first.moodTags.join(", ")}`;
  if (first.type === "role") {
    return {
      singalong: "Mehr Musik zum Mitsingen",
      wake_up: "Mehr Energie für die nächsten Songs",
      kids: "Mehr Musik für die Kinder",
      calm_down: "Ruhiger für die nächsten Songs",
    }[first.role];
  }
  const avoid = [
    ...(first.artists ?? []),
    ...(first.moodTags ?? []),
    ...(first.songKeys ?? []),
  ].join(", ");
  return avoid ? `Vermeide ${avoid}` : "Vermeide diesen Vibe";
}

export function parseMusicWish(rawText: string): ParsedMusicWish {
  const text = rawText.trim();
  const normalized = normalizeText(text);
  const intents: MusicWishIntent[] = [];

  const immediateMatch = text.match(/^(spiel|spiele|play)\s+(jetzt|sofort)\s+(.+)$/i);
  if (immediateMatch?.[3]) {
    const subject = cleanSubject(immediateMatch[3]);
    const artistTitle = subject.match(/^(.+)\s+-\s+(.+)$/);
    if (artistTitle?.[1] && artistTitle?.[2]) {
      intents.push({
        type: "song",
        artist: cleanSubject(artistTitle[1]),
        title: cleanSubject(artistTitle[2]),
        immediate: true,
      });
    } else {
      intents.push({ type: "song", title: subject, immediate: true });
    }
    return { rawText: text, status: "active", confidence: 0.9, summary: musicWishSummary(intents), intents };
  }

  const moreMatch = text.match(/^(mehr|more)\s+(.+)$/i);
  if (moreMatch?.[2]) {
    const subject = cleanSubject(moreMatch[2]);
    const key = normalizeText(subject);
    if (GENRE_TAGS[key]) {
      intents.push({ type: "mood", moodTags: GENRE_TAGS[key], strength: 0.82 });
    } else if (/pop|rock|schlager|disco|rap|hip hop|hip-hop/i.test(subject)) {
      intents.push({ type: "genre", genre: subject.toLowerCase(), strength: 0.78 });
    } else {
      intents.push({ type: "artist", artist: titleCaseWords(subject), strength: 0.9 });
    }
    return { rawText: text, status: "active", confidence: 0.82, summary: musicWishSummary(intents), intents };
  }

  const avoidMatch = text.match(/^(keine|kein|nicht|weniger|not|no)\s+(schon wieder\s+)?(.+)$/i);
  if (avoidMatch?.[3]) {
    const subject = cleanSubject(avoidMatch[3]);
    const key = normalizeText(subject);
    if (/langsam|ruhig|mellow|sleepy|schlaf/i.test(subject)) {
      intents.push({ type: "avoid", moodTags: ["mellow", "sleepy", "slow"] });
    } else if (GENRE_TAGS[key]) {
      intents.push({ type: "avoid", moodTags: GENRE_TAGS[key] });
    } else {
      intents.push({ type: "avoid", artists: [titleCaseWords(subject)] });
    }
    return { rawText: text, status: "active", confidence: 0.82, summary: musicWishSummary(intents), intents };
  }

  for (const entry of ROLE_PATTERNS) {
    if (entry.patterns.some((pattern) => normalized.includes(normalizeText(pattern)))) {
      intents.push({ type: "role", role: entry.role, strength: 0.86 });
      return { rawText: text, status: "active", confidence: 0.78, summary: musicWishSummary(intents), intents };
    }
  }

  const songLike = text.match(/^(.+)\s+-\s+(.+)$/);
  if (songLike?.[1] && songLike?.[2]) {
    intents.push({
      type: "song",
      artist: cleanSubject(songLike[1]),
      title: cleanSubject(songLike[2]),
      immediate: false,
    });
    return { rawText: text, status: "active", confidence: 0.74, summary: musicWishSummary(intents), intents };
  }

  return {
    rawText: text,
    status: "pending_confirmation",
    confidence: 0.35,
    summary: musicWishSummary([]),
    intents,
  };
}

export function avoidSongKeysForWish(intents: MusicWishIntent[]): string[] {
  return intents.flatMap((intent) => (intent.type === "avoid" ? (intent.songKeys ?? []) : []));
}

export function directSongKeysForWish(intents: MusicWishIntent[]): string[] {
  return intents.flatMap((intent) =>
    intent.type === "song" ? [songKey(intent.artist ?? "", intent.title)] : [],
  );
}
