import type { MediaSource } from "@syncstream/types";

// The one interface the sync engine talks to. Every source (YouTube IFrame,
// Drive HTML5 video, native mobile players) implements this. Sync code must
// never import a concrete adapter.
export interface PlayerAdapter {
  readonly source: MediaSource;
  // False for players limited to discrete rates (e.g. YouTube's IFrame API:
  // 0.25/0.5/0.75/1/1.25...), where a 1.02x/0.98x nudge is a silent no-op.
  // The sync engine's rate-nudge tier only applies when this is true.
  readonly supportsFineRateControl: boolean;
  load(sourceRef: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  getPositionMs(): Promise<number>;
  setPlaybackRate(rate: number): void; // used for gentle drift correction
  on(event: PlayerEvent, cb: () => void): void;
  destroy(): void;
}

export type PlayerEvent = "ready" | "playing" | "paused" | "buffering" | "ended" | "ad" | "error";
