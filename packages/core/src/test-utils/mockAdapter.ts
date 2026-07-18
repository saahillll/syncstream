import type { PlayerAdapter, PlayerEvent } from "@syncstream/players";
import type { MediaSource } from "@syncstream/types";

// Minimal in-memory PlayerAdapter for tests: records every call and lets a
// test manually fire adapter events (e.g. "ad") to exercise engine reactions.
export class MockPlayerAdapter implements PlayerAdapter {
  readonly source: MediaSource = "youtube";
  positionMs = 0;
  playbackRate = 1;
  calls: { method: string; args: unknown[] }[] = [];
  private listeners = new Map<PlayerEvent, (() => void)[]>();

  async load(sourceRef: string): Promise<void> {
    this.calls.push({ method: "load", args: [sourceRef] });
  }

  async play(): Promise<void> {
    this.calls.push({ method: "play", args: [] });
  }

  async pause(): Promise<void> {
    this.calls.push({ method: "pause", args: [] });
  }

  async seekTo(positionMs: number): Promise<void> {
    this.calls.push({ method: "seekTo", args: [positionMs] });
    this.positionMs = positionMs;
  }

  async getPositionMs(): Promise<number> {
    return this.positionMs;
  }

  setPlaybackRate(rate: number): void {
    this.calls.push({ method: "setPlaybackRate", args: [rate] });
    this.playbackRate = rate;
  }

  on(event: PlayerEvent, cb: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  emit(event: PlayerEvent): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }

  destroy(): void {
    this.calls.push({ method: "destroy", args: [] });
  }
}
