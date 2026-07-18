import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeNativeAdapter } from "./YouTubeNativeAdapter.js";

describe("YouTubeNativeAdapter capability flags", () => {
  it("reports no fine rate control (YouTube's IFrame API only has discrete rates)", () => {
    const adapter = new YouTubeNativeAdapter();
    expect(adapter.supportsFineRateControl).toBe(false);
  });

  it("ignores non-1 setPlaybackRate calls", () => {
    const adapter = new YouTubeNativeAdapter();
    adapter.setPlaybackRate(1.02);
    expect(adapter.getSnapshot().playbackRate).toBe(1);
  });

  it("applies setPlaybackRate(1)", () => {
    const adapter = new YouTubeNativeAdapter();
    adapter.setPlaybackRate(1.02); // no-op
    adapter.setPlaybackRate(1);
    expect(adapter.getSnapshot().playbackRate).toBe(1);
  });
});

describe("YouTubeNativeAdapter.load", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the player reports ready", async () => {
    const adapter = new YouTubeNativeAdapter();
    const loadPromise = adapter.load("dQw4w9WgXcQ");
    adapter.handleReady();
    await expect(loadPromise).resolves.toBeUndefined();
  });

  it("rejects when the player reports an error (e.g. embed_not_allowed)", async () => {
    const adapter = new YouTubeNativeAdapter();
    const errors: void[] = [];
    adapter.on("error", () => errors.push(undefined));

    const loadPromise = adapter.load("dQw4w9WgXcQ");
    adapter.handleError("embed_not_allowed");

    await expect(loadPromise).rejects.toThrow(/embed_not_allowed/);
    expect(errors).toHaveLength(1);
  });

  it("rejects after a 10s timeout if neither ready nor error arrives", async () => {
    const adapter = new YouTubeNativeAdapter();
    const errors: void[] = [];
    adapter.on("error", () => errors.push(undefined));

    const loadPromise = adapter.load("dQw4w9WgXcQ");
    const assertion = expect(loadPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(errors).toHaveLength(1);
  });

  it("clears the timeout once ready arrives, so it never fires a stray error", async () => {
    const adapter = new YouTubeNativeAdapter();
    const errors: void[] = [];
    adapter.on("error", () => errors.push(undefined));

    const loadPromise = adapter.load("dQw4w9WgXcQ");
    adapter.handleReady();
    await loadPromise;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toHaveLength(0);
  });

  it("supersedes a still-pending load when load() is called again", async () => {
    const adapter = new YouTubeNativeAdapter();
    const firstLoad = adapter.load("firstVideoId");
    const secondLoad = adapter.load("secondVideoId");

    await expect(firstLoad).rejects.toThrow(/superseded/i);
    adapter.handleReady();
    await expect(secondLoad).resolves.toBeUndefined();
    expect(adapter.getSnapshot().videoId).toBe("secondVideoId");
  });

  it("rejects a pending load on destroy", async () => {
    const adapter = new YouTubeNativeAdapter();
    const loadPromise = adapter.load("dQw4w9WgXcQ");
    adapter.destroy();
    await expect(loadPromise).rejects.toThrow(/destroyed/i);
  });
});
