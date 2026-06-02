/**
 * Pure gate: should the REST poller run, or stand down because streaming is live?
 * Returns true (poll) when there is no fresh streaming data within the window.
 */
export function shouldPollRest(lastStreamingAtIso: string | undefined, nowMs: number, freshWindowMs: number): boolean {
  if (!lastStreamingAtIso) return true;
  const last = Date.parse(lastStreamingAtIso);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= freshWindowMs;
}

/** Tiny in-memory tracker for the last time a streaming message arrived. */
export class StreamLiveness {
  private last?: string;
  mark(iso: string): void {
    this.last = iso;
  }
  lastIso(): string | undefined {
    return this.last;
  }
}
