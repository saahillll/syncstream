import type { MediaSource } from "@syncstream/types";

// The one interface the sync engine talks to. Every source (YouTube IFrame,
// Drive HTML5 video, native mobile players) implements this. Sync code must
// never import a concrete adapter.
export interface PlayerAdapter {
  readonly source: MediaSource;
  load(sourceRef: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  getPositionMs(): Promise<number>;
  setPlaybackRate(rate: number): void; // used for gentle drift correction
  on(event: PlayerEvent, cb: () => void): void;
  destroy(): void;
}

export type PlayerEvent = "ready" | "playing" | "paused" | "buffering" | "ended" | "ad";
