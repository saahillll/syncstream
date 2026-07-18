import type { PlaybackState } from "@syncstream/types";
import type { PlayerAdapter } from "@syncstream/players";
import { ClockSync } from "./clock.js";

// YouTube-specific drift ladder. Looser than the general 100/500ms ladder in
// CLAUDE.md because the IFrame API's seekTo/getCurrentTime granularity is
// coarser than a native player's.
export const DRIFT_IGNORE_MS = 150;
export const DRIFT_HARD_SEEK_MS = 600;
export const RATE_FAST = 1.02;
export const RATE_SLOW = 0.98;
export const RATE_NORMAL = 1;
export const DRIFT_EVAL_INTERVAL_MS = 1000;

export type DriftDecision =
  | { kind: "ignore"; driftMs: number }
  | { kind: "rate"; driftMs: number; rate: number }
  | { kind: "seek"; driftMs: number; targetPositionMs: number };

// Server-authoritative position at a given server time. Pure function so the
// projection math is trivial to unit test independent of any clock or timer.
export function targetPositionMs(state: PlaybackState, nowServerTimeMs: number): number {
  if (!state.playing) return state.anchorPositionMs;
  return state.anchorPositionMs + (nowServerTimeMs - state.anchorServerTime);
}

// Given where the player actually is vs. where it should be, decide what
// correction (if any) applies. Boundaries: <150ms ignore, 150-600ms inclusive
// rate nudge, >600ms hard seek.
export function decideDrift(playerPositionMs: number, targetMs: number): DriftDecision {
  const driftMs = playerPositionMs - targetMs;
  const absDrift = Math.abs(driftMs);

  if (absDrift < DRIFT_IGNORE_MS) {
    return { kind: "ignore", driftMs };
  }
  if (absDrift <= DRIFT_HARD_SEEK_MS) {
    // Player behind target -> speed up; player ahead -> slow down.
    return { kind: "rate", driftMs, rate: driftMs < 0 ? RATE_FAST : RATE_SLOW };
  }
  return { kind: "seek", driftMs, targetPositionMs: targetMs };
}

export interface SyncEngineOptions {
  adapter: PlayerAdapter;
  clock: ClockSync;
}

// Binds a PlayerAdapter to the gateway's playback:state broadcasts. Owns no
// timers itself: the caller drives applyState() on each playback:state event
// and tick() on a ~1s interval, which keeps this class testable with fake
// clocks instead of real ones.
export class SyncEngine {
  private readonly adapter: PlayerAdapter;
  private readonly clock: ClockSync;
  private latestState: PlaybackState | null = null;
  private lastAppliedEpoch = -1;
  private loadedItemId: string | null = null;
  private correctionsPaused = false;
  private lastDecision: DriftDecision | null = null;

  constructor({ adapter, clock }: SyncEngineOptions) {
    this.adapter = adapter;
    this.clock = clock;
    this.adapter.on("ad", () => {
      this.correctionsPaused = true;
    });
    this.adapter.on("playing", () => {
      this.correctionsPaused = false;
    });
  }

  // Applies a playback:state broadcast. Returns false (and does nothing
  // else) if the state's epoch is stale, per the epoch guard: states with
  // epoch <= the last applied epoch are discarded.
  async applyState(state: PlaybackState, localTimeMs: number): Promise<boolean> {
    if (state.epoch <= this.lastAppliedEpoch) return false;
    this.lastAppliedEpoch = state.epoch;
    this.latestState = state;

    if (state.itemId && state.itemId !== this.loadedItemId) {
      await this.adapter.load(state.itemId);
      this.loadedItemId = state.itemId;
    }

    const nowServerTime = this.clock.toServerTime(localTimeMs);
    const targetMs = targetPositionMs(state, nowServerTime);
    this.adapter.setPlaybackRate(RATE_NORMAL);
    await this.adapter.seekTo(targetMs);
    if (state.playing) {
      await this.adapter.play();
    } else {
      await this.adapter.pause();
    }

    return true;
  }

  // One drift-evaluation tick. Returns null if there is no state to compare
  // against yet or corrections are paused for an ad.
  async tick(localTimeMs: number): Promise<DriftDecision | null> {
    if (!this.latestState || this.correctionsPaused) return null;

    const nowServerTime = this.clock.toServerTime(localTimeMs);
    const targetMs = targetPositionMs(this.latestState, nowServerTime);
    const playerPositionMs = await this.adapter.getPositionMs();
    const decision = decideDrift(playerPositionMs, targetMs);
    this.lastDecision = decision;

    switch (decision.kind) {
      case "ignore":
        this.adapter.setPlaybackRate(RATE_NORMAL);
        break;
      case "rate":
        this.adapter.setPlaybackRate(decision.rate);
        break;
      case "seek":
        this.adapter.setPlaybackRate(RATE_NORMAL);
        await this.adapter.seekTo(decision.targetPositionMs);
        break;
    }

    return decision;
  }

  getLastAppliedEpoch(): number {
    return this.lastAppliedEpoch;
  }

  getLatestState(): PlaybackState | null {
    return this.latestState;
  }

  getLastDecision(): DriftDecision | null {
    return this.lastDecision;
  }

  isCorrectionsPaused(): boolean {
    return this.correctionsPaused;
  }

  destroy(): void {
    this.adapter.destroy();
  }
}
