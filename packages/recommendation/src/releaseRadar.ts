import type { SongCandidate } from "@ai-journey-dj/core";
import { normalizeText } from "@ai-journey-dj/core";

import { looksLikeSpokenWord } from "./spokenWord.js";

interface RadarAlbum {
  id: string;
  name: string;
  artist: string;
  releaseDate?: string;
}

/** Minimal album feed the radar needs (testable via a stub). */
export interface AlbumSource {
  /**
   * Returns albums by the queried artist as PRIMARY artist (not collaborations or appears-on).
   */
  getArtistAlbums(artistId: string): Promise<RadarAlbum[]>;
  getNewReleases?(): Promise<RadarAlbum[]>;
}

/** True when `releaseDate` (YYYY-MM-DD or YYYY) falls within `windowDays` of `now`. */
export function isWithinFreshWindow(
  releaseDate: string | undefined,
  windowDays: number,
  now = new Date(),
): boolean {
  if (!releaseDate) return false;
  const parsed = new Date(
    releaseDate.length === 4 ? `${releaseDate}-01-01` : releaseDate,
  );
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return false;
  const ageDays = (now.getTime() - ms) / 86_400_000;
  return ageDays >= 0 && ageDays <= windowDays;
}

export async function releaseRadarCandidates(args: {
  albums: AlbumSource;
  tasteArtists: Array<{ id: string; name: string }>;
  bannedArtists: ReadonlySet<string>;
  moodTags: string[];
  windowDays: number;
  perArtist?: number;
  limit: number;
  now?: Date;
}): Promise<SongCandidate[]> {
  const now = args.now ?? new Date();
  const perArtist = args.perArtist ?? 2;
  const out: SongCandidate[] = [];
  const seen = new Set<string>();

  const push = (album: RadarAlbum, monthLabel: string) => {
    if (!album.artist || !album.name) return;
    const key = normalizeText(album.artist);
    const dupe = normalizeText(`${album.artist}-${album.name}`);
    if (args.bannedArtists.has(key)) return;
    if (looksLikeSpokenWord(album.artist, album.name)) return;
    if (seen.has(dupe)) return;
    seen.add(dupe);
    out.push({
      artist: album.artist,
      title: album.name,
      lens: "release-radar",
      reason: `Neu von ${album.artist} (${monthLabel})`,
      source: "spotify-fresh",
      confidence: 0.75,
      moodTags: args.moodTags,
      releaseDate: album.releaseDate,
    });
  };

  const monthLabel = (releaseDate?: string) =>
    releaseDate && releaseDate.length >= 7 ? releaseDate.slice(0, 7) : "frisch";

  for (const artist of args.tasteArtists) {
    let kept = 0;
    let albums: RadarAlbum[] = [];
    try {
      albums = await args.albums.getArtistAlbums(artist.id);
    } catch {
      continue;
    }
    for (const album of albums) {
      if (kept >= perArtist) break;
      if (!isWithinFreshWindow(album.releaseDate, args.windowDays, now))
        continue;
      // Prefer the canonical artist name from tasteArtists over the raw id returned by the source
      const normalised: RadarAlbum = { ...album, artist: artist.name };
      const before = out.length;
      push(normalised, monthLabel(album.releaseDate));
      if (out.length > before) kept += 1;
    }
  }

  if (args.albums.getNewReleases) {
    try {
      const curated = await args.albums.getNewReleases();
      for (const album of curated) {
        if (isWithinFreshWindow(album.releaseDate, args.windowDays, now)) {
          push(album, monthLabel(album.releaseDate));
        }
      }
    } catch {
      // best-effort: curated releases are a bonus
    }
  }

  return out.slice(0, args.limit);
}
