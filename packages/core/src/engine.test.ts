import { describe, expect, it } from "vitest";
import type { PlaybackState } from "@syncstream/types";
import { ClockSync } from "./clock.js";
import {
  DRIFT_HARD_SEEK_MS,
  DRIFT_IGNORE_MS,
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

    adapter.positionMs = 10_000; // exactly on target
    const decision = await engine.tick(10_000);
    expect(decision?.kind).toBe("ignore");
    expect(adapter.playbackRate).toBe(RATE_NORMAL);
  });
});
