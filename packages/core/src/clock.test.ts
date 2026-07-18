import { describe, expect, it } from "vitest";
import { ClockSync } from "./clock.js";

describe("ClockSync", () => {
  it("returns 0 offset before any samples", () => {
    const clock = new ClockSync();
    expect(clock.getOffsetMs()).toBe(0);
    expect(clock.sampleCount()).toBe(0);
  });

  it("computes offset assuming symmetric latency", () => {
    const clock = new ClockSync();
    // sent at 1000, server reports 1050, received back at 1020 -> rtt 20,
    // midpoint local time 1010, offset 1050 - 1010 = 40.
    clock.recordSample(1000, 1050, 1020);
    expect(clock.getOffsetMs()).toBe(40);
  });

  it("keeps a rolling window, dropping the oldest sample", () => {
    const clock = new ClockSync(5);
    const offsets = [10, 20, 30, 40, 50, 1000];
    for (const offset of offsets) {
      // t0=0, t1=0 -> offset === serverTime for this synthetic sample
      clock.recordSample(0, offset, 0);
    }
    expect(clock.sampleCount()).toBe(5);
    // oldest sample (10) should have been evicted; window is [20,30,40,50,1000]
    expect(clock.getOffsetMs()).toBe(40);
  });

  it("median is robust to a single outlier", () => {
    const clock = new ClockSync(5);
    for (const offset of [45, 50, 55, 48, 5000]) {
      clock.recordSample(0, offset, 0);
    }
    expect(clock.getOffsetMs()).toBe(50);
  });

  it("toServerTime adds the current offset to local time", () => {
    const clock = new ClockSync();
    clock.recordSample(1000, 1050, 1020);
    expect(clock.toServerTime(2000)).toBe(2040);
  });

  it("reset clears accumulated samples", () => {
    const clock = new ClockSync();
    clock.recordSample(1000, 1050, 1020);
    clock.reset();
    expect(clock.sampleCount()).toBe(0);
    expect(clock.getOffsetMs()).toBe(0);
  });
});
