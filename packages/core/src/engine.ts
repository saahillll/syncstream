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

// If this many tick()s in a row all decide "seek", hard seeking isn't
// keeping up (e.g. flaky network, player struggling) - repeated seeking is
// jarring, so back off instead of hammering it every tick.
export const HARD_SEEK_FAILURE_LIMIT = 3;
export const CORRECTION_BACKOFF_MS = 15_000;

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
// rate nudge, >600ms hard seek. Players that can't do fine-grained rate
// control (YouTube's IFrame API only supports discrete rates) degrade the
// middle band to "ignore" instead, since a 1.02x/0.98x nudge would silently
// do nothing there - leaving it as "rate" would just mean the ladder
// silently under-corrects for 450ms of its range.
export function decideDrift(
  playerPositionMs: number,
  targetMs: number,
  supportsFineRateControl = true,
): DriftDecision {
  const driftMs = playerPositionMs - targetMs;
  const absDrift = Math.abs(driftMs);

  if (absDrift < DRIFT_IGNORE_MS) {
    return { kind: "ignore", driftMs };
  }
  if (absDrift <= DRIFT_HARD_SEEK_MS) {
    if (!supportsFineRateControl) {
      return { kind: "ignore", driftMs };
    }
    // Player behind target -> speed up; player ahead -> slow down.
    return { kind: "rate", driftMs, rate: driftMs < 0 ? RATE_FAST : RATE_SLOW };
  }
  return { kind: "seek", driftMs, targetPositionMs: targetMs };
}

export interface SyncEngineOptions {
  adapter: PlayerAdapter;
  clock: ClockSync;
  // Wall-clock source for backoff bookkeeping, injectable so tests can
  // advance it without sleeping. Defaults to Date.now.
  now?: () => number;
}

// Binds a PlayerAdapter to the gateway's playback:state broadcasts. Owns no
// timers itself: the caller drives applyState() on each playback:state event
// and tick() on a ~1s interval, which keeps this class testable with fake
// clocks instead of real ones.
export class SyncEngine {
  private readonly adapter: PlayerAdapter;
  private readonly clock: ClockSync;
  private readonly now: () => number;
  private latestState: PlaybackState | null = null;
  private lastAppliedEpoch = -1;
  private loadedItemId: string | null = null;
  // Starts paused: the player hasn't confirmed it's actually playing yet, so
  // there's nothing meaningful to correct against until the first "playing"
  // event lands. "buffering" re-pauses for the same reason - a position read
  // during a buffering stall isn't a real drift measurement.
  private correctionsPaused = true;
  private lastDecision: DriftDecision | null = null;
  private consecutiveHardSeeks = 0;
  private backoffUntilMs: number | null = null;

  constructor({ adapter, clock, now = Date.now }: SyncEngineOptions) {
    this.adapter = adapter;
    this.clock = clock;
    this.now = now;
    this.adapter.on("ad", () => {
      this.correctionsPaused = true;
    });
    this.adapter.on("buffering", () => {
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
  // against yet, corrections are paused (ad/buffering/not-yet-playing), or
  // corrections are backed off after repeated failed hard seeks.
  async tick(localTimeMs: number): Promise<DriftDecision | null> {
    if (!this.latestState || this.correctionsPaused) return null;

    if (this.backoffUntilMs !== null) {
      if (this.now() < this.backoffUntilMs) return null;
      this.backoffUntilMs = null;
      this.consecutiveHardSeeks = 0;
    }

    const nowServerTime = this.clock.toServerTime(localTimeMs);
    const targetMs = targetPositionMs(this.latestState, nowServerTime);
    const playerPositionMs = await this.adapter.getPositionMs();
    const decision = decideDrift(playerPositionMs, targetMs, this.adapter.supportsFineRateControl);
    this.lastDecision = decision;

    switch (decision.kind) {
      case "ignore":
        this.consecutiveHardSeeks = 0;
        this.adapter.setPlaybackRate(RATE_NORMAL);
        break;
      case "rate":
        this.consecutiveHardSeeks = 0;
        this.adapter.setPlaybackRate(decision.rate);
        break;
      case "seek":
        this.adapter.setPlaybackRate(RATE_NORMAL);
        await this.adapter.seekTo(decision.targetPositionMs);
        this.consecutiveHardSeeks += 1;
        if (this.consecutiveHardSeeks >= HARD_SEEK_FAILURE_LIMIT) {
          this.backoffUntilMs = this.now() + CORRECTION_BACKOFF_MS;
        }
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

  isBackoffActive(): boolean {
    return this.backoffUntilMs !== null;
  }

  getBackoffUntilMs(): number | null {
    return this.backoffUntilMs;
  }

  destroy(): void {
    this.adapter.destroy();
  }
}
