import { describe, expect, it } from "vitest";
import type { PlaybackState } from "@syncstream/types";
import { ClockSync } from "./clock.js";
import {
  CORRECTION_BACKOFF_MS,
  DRIFT_HARD_SEEK_MS,
  DRIFT_IGNORE_MS,
  HARD_SEEK_FAILURE_LIMIT,
  RATE_FAST,
  RATE_NORMAL,
  RATE_SLOW,
  SyncEngine,
  decideDrift,
  targetPositionMs,
} from "./engine.js";
import { MockPlayerAdapter } from "./test-utils/mockAdapter.js";

function baseState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    itemId: "dQw4w9WgXcQ",
    playing: true,
    anchorPositionMs: 10_000,
    anchorServerTime: 100_000,
    epoch: 0,
    ...overrides,
  };
}

describe("targetPositionMs", () => {
  it("advances with elapsed server time while playing", () => {
    const state = baseState({ playing: true, anchorPositionMs: 10_000, anchorServerTime: 100_000 });
    expect(targetPositionMs(state, 103_000)).toBe(13_000);
  });

  it("stays pinned to the anchor while paused", () => {
    const state = baseState({ playing: false, anchorPositionMs: 10_000, anchorServerTime: 100_000 });
    expect(targetPositionMs(state, 999_000)).toBe(10_000);
  });
});

describe("decideDrift (drift ladder)", () => {
  it("ignores drift under the ignore threshold", () => {
    const decision = decideDrift(10_000, 10_000 + (DRIFT_IGNORE_MS - 1));
    expect(decision.kind).toBe("ignore");
  });

  it("treats exactly the ignore threshold as a rate correction, not ignored", () => {
    const decision = decideDrift(10_000, 10_000 - DRIFT_IGNORE_MS);
    expect(decision.kind).toBe("rate");
  });

  it("speeds up when the player is behind target", () => {
    const decision = decideDrift(10_000, 10_400); // player 400ms behind
    expect(decision).toMatchObject({ kind: "rate", rate: RATE_FAST });
  });

  it("slows down when the player is ahead of target", () => {
    const decision = decideDrift(10_400, 10_000); // player 400ms ahead
    expect(decision).toMatchObject({ kind: "rate", rate: RATE_SLOW });
  });

  it("treats exactly the hard-seek threshold as a rate correction, not a seek", () => {
    const decision = decideDrift(10_000, 10_000 + DRIFT_HARD_SEEK_MS);
    expect(decision.kind).toBe("rate");
  });

  it("hard seeks beyond the hard-seek threshold", () => {
    const targetMs = 10_000;
    const decision = decideDrift(targetMs + DRIFT_HARD_SEEK_MS + 1, targetMs);
    expect(decision).toMatchObject({ kind: "seek", targetPositionMs: targetMs });
  });

  it("degrades the rate band to ignore for adapters without fine rate control", () => {
    const decision = decideDrift(10_400, 10_000, false); // 400ms ahead, would normally be a rate nudge
    expect(decision.kind).toBe("ignore");
  });

  it("still hard seeks beyond the hard-seek threshold without fine rate control", () => {
    const targetMs = 10_000;
    const decision = decideDrift(targetMs + DRIFT_HARD_SEEK_MS + 1, targetMs, false);
    expect(decision).toMatchObject({ kind: "seek", targetPositionMs: targetMs });
  });
});

describe("SyncEngine epoch guard", () => {
  it("applies the first state regardless of epoch value", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    const applied = await engine.applyState(baseState({ epoch: 0 }), 100_000);
    expect(applied).toBe(true);
    expect(engine.getLastAppliedEpoch()).toBe(0);
  });

  it("discards a state whose epoch equals the last applied epoch", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 2 }), 100_000);
    adapter.calls = [];

    const applied = await engine.applyState(baseState({ epoch: 2, anchorPositionMs: 99_999 }), 100_100);

    expect(applied).toBe(false);
    expect(engine.getLastAppliedEpoch()).toBe(2);
    expect(adapter.calls).toHaveLength(0);
  });

  it("discards a state with an older epoch than the last applied epoch", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 5 }), 100_000);
    adapter.calls = [];

    const applied = await engine.applyState(baseState({ epoch: 3 }), 100_100);

    expect(applied).toBe(false);
    expect(engine.getLastAppliedEpoch()).toBe(5);
    expect(adapter.calls).toHaveLength(0);
  });

  it("applies a state with a newer epoch and commands the adapter", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 1 }), 100_000);

    const applied = await engine.applyState(baseState({ epoch: 2, playing: false }), 100_000);

    expect(applied).toBe(true);
    expect(engine.getLastAppliedEpoch()).toBe(2);
    expect(adapter.calls.some((c) => c.method === "pause")).toBe(true);
  });
});

describe("SyncEngine ad handling", () => {
  it("pauses drift correction while an ad is reported and resumes on playing", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);

    adapter.emit("ad");
    adapter.positionMs = 50_000; // wildly drifted, would normally trigger a seek
    const duringAd = await engine.tick(60_000);
    expect(duringAd).toBeNull();

    adapter.emit("playing");
    const afterAd = await engine.tick(60_000);
    expect(afterAd?.kind).toBe("seek");
  });
});

describe("SyncEngine.tick", () => {
  it("returns null when no state has been applied yet", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    expect(await engine.tick(0)).toBeNull();
  });

  it("issues a rate nudge when the player has drifted moderately", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);
    adapter.emit("playing");

    // target at local time 10_000 (no clock offset) is 10_000ms in.
    adapter.positionMs = 10_400; // 400ms ahead
    const decision = await engine.tick(10_000);
    expect(decision).toMatchObject({ kind: "rate", rate: RATE_SLOW });
    expect(adapter.playbackRate).toBe(RATE_SLOW);
  });

  it("resets playback rate to normal once back in sync", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);
    adapter.emit("playing");

    adapter.positionMs = 10_000; // exactly on target
    const decision = await engine.tick(10_000);
    expect(decision?.kind).toBe("ignore");
    expect(adapter.playbackRate).toBe(RATE_NORMAL);
  });

  it("degrades the rate band to ignore for adapters without fine rate control", async () => {
    const adapter = new MockPlayerAdapter();
    adapter.supportsFineRateControl = false;
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);
    adapter.emit("playing");

    adapter.positionMs = 10_400; // 400ms ahead - would be a rate nudge on a fine-control adapter
    const decision = await engine.tick(10_000);
    expect(decision?.kind).toBe("ignore");
  });
});

describe("SyncEngine correction gating", () => {
  it("stays paused until the first playing event, even with a state already applied", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);

    expect(engine.isCorrectionsPaused()).toBe(true);
    adapter.positionMs = 50_000; // would otherwise be a huge drift
    expect(await engine.tick(60_000)).toBeNull();

    adapter.emit("playing");
    expect(engine.isCorrectionsPaused()).toBe(false);
    expect(await engine.tick(60_000)).not.toBeNull();
  });

  it("re-pauses corrections on buffering and resumes on the next playing event", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = new SyncEngine({ adapter, clock: new ClockSync() });
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);
    adapter.emit("playing");
    expect(engine.isCorrectionsPaused()).toBe(false);

    adapter.emit("buffering");
    expect(engine.isCorrectionsPaused()).toBe(true);
    adapter.positionMs = 50_000;
    expect(await engine.tick(60_000)).toBeNull();

    adapter.emit("playing");
    expect(await engine.tick(60_000)).not.toBeNull();
  });
});

describe("SyncEngine correction back-off", () => {
  function playingEngine(adapter: MockPlayerAdapter, now: () => number) {
    const engine = new SyncEngine({ adapter, clock: new ClockSync(), now });
    return engine;
  }

  it("is inactive before any hard seeks", async () => {
    const adapter = new MockPlayerAdapter();
    const engine = playingEngine(adapter, () => 0);
    expect(engine.isBackoffActive()).toBe(false);
    expect(engine.getBackoffUntilMs()).toBeNull();
  });

  it("suspends corrections after 3 consecutive hard seeks and resumes after the backoff window", async () => {
    const adapter = new MockPlayerAdapter();
    let nowMs = 0;
    const engine = playingEngine(adapter, () => nowMs);
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);
    adapter.emit("playing");

    // The mock adapter never advances position on its own between ticks
    // (only seekTo moves it), so spacing ticks far enough apart keeps
    // recreating a >600ms drift after every hard seek - simulating a player
    // that can't keep up with corrections.
    adapter.positionMs = 0;
    expect((await engine.tick(1000))?.kind).toBe("seek"); // 1st
    expect((await engine.tick(2000))?.kind).toBe("seek"); // 2nd
    expect((await engine.tick(3000))?.kind).toBe("seek"); // 3rd - trips backoff
    expect(engine.isBackoffActive()).toBe(true);
    expect(engine.getBackoffUntilMs()).toBe(CORRECTION_BACKOFF_MS);

    // Suppressed during the backoff window regardless of drift.
    expect(await engine.tick(4000)).toBeNull();

    // Past the backoff window, corrections resume and the counter resets.
    nowMs = CORRECTION_BACKOFF_MS + 1;
    const resumed = await engine.tick(20_000);
    expect(resumed).not.toBeNull();
    expect(engine.isBackoffActive()).toBe(false);
  });

  it("resets the consecutive hard-seek counter on a non-seek decision", async () => {
    const adapter = new MockPlayerAdapter();
    let nowMs = 0;
    const engine = playingEngine(adapter, () => nowMs);
    await engine.applyState(baseState({ epoch: 0, anchorPositionMs: 0, anchorServerTime: 0, playing: true }), 0);
    adapter.emit("playing");

    adapter.positionMs = 0;
    expect((await engine.tick(1000))?.kind).toBe("seek"); // 1st
    expect((await engine.tick(2000))?.kind).toBe("seek"); // 2nd

    adapter.positionMs = 3000; // exactly on target -> breaks the streak
    expect((await engine.tick(3000))?.kind).toBe("ignore");

    // Only the 1st in a fresh streak - no backoff yet.
    expect((await engine.tick(4000))?.kind).toBe("seek");
    expect(engine.isBackoffActive()).toBe(false);
  });

  it("counts HARD_SEEK_FAILURE_LIMIT as the trip point", () => {
    expect(HARD_SEEK_FAILURE_LIMIT).toBe(3);
  });
});
