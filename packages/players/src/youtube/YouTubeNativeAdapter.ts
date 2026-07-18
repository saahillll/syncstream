import type { MediaSource } from "@syncstream/types";
import type { YoutubeIframeRef } from "react-native-youtube-iframe";
import type { PlayerAdapter, PlayerEvent } from "../index.js";

// react-native-youtube-iframe wraps the official IFrame Player API and is
// prop/ref driven (play as a boolean prop, seekTo/getCurrentTime on a ref)
// rather than imperative. This adapter bridges that to the imperative,
// Promise-based PlayerAdapter contract: it holds the render state the
// YouTubePlayerView component reads, and exposes hooks that view calls back
// into (bindPlayerRef, handleReady, handleStateChange).
//
// Ad detection: the official IFrame Player API does not expose a distinct
// "this is an ad" state (ads and content both report state PLAYING) -
// that's a deliberate limitation which is also why ad blocking isn't
// possible through this API. handleStateChange therefore never dispatches
// "ad" today; the PlayerEvent stays in the interface so a future signal
// (e.g. a player param workaround) can wire into it without changing the
// PlayerAdapter contract or packages/core.

export interface YouTubeAdapterState {
  videoId: string | null;
  playing: boolean;
  playbackRate: number;
}

const YOUTUBE_IFRAME_STATE_TO_EVENT: Record<string, PlayerEvent | undefined> = {
  playing: "playing",
  paused: "paused",
  buffering: "buffering",
  ended: "ended",
  unstarted: "ready",
  "video cued": "ready",
};

export class YouTubeNativeAdapter implements PlayerAdapter {
  readonly source: MediaSource = "youtube";

  private state: YouTubeAdapterState = { videoId: null, playing: false, playbackRate: 1 };
  private stateListeners = new Set<(state: YouTubeAdapterState) => void>();
  private eventListeners = new Map<PlayerEvent, Set<() => void>>();
  private playerRef: YoutubeIframeRef | null = null;
  private ready = false;
  private readyWaiters: (() => void)[] = [];

  getSnapshot(): YouTubeAdapterState {
    return this.state;
  }

  subscribe(cb: (state: YouTubeAdapterState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  bindPlayerRef(ref: YoutubeIframeRef | null): void {
    this.playerRef = ref;
  }

  handleReady(): void {
    this.ready = true;
    this.readyWaiters.splice(0).forEach((resolve) => resolve());
    this.dispatch("ready");
  }

  handleStateChange(iframeState: string): void {
    const event = YOUTUBE_IFRAME_STATE_TO_EVENT[iframeState];
    if (event) this.dispatch(event);
  }

  async load(sourceRef: string): Promise<void> {
    this.ready = false;
    this.setState({ videoId: sourceRef });
    await this.waitForReady();
  }

  async play(): Promise<void> {
    this.setState({ playing: true });
  }

  async pause(): Promise<void> {
    this.setState({ playing: false });
  }

  async seekTo(positionMs: number): Promise<void> {
    this.playerRef?.seekTo(positionMs / 1000, true);
  }

  async getPositionMs(): Promise<number> {
    if (!this.playerRef) return 0;
    const seconds = await this.playerRef.getCurrentTime();
    return Math.round(seconds * 1000);
  }

  // Not part of the generic PlayerAdapter contract (packages/core never
  // needs it); exposed for UI concerns like a host seek bar, which callers
  // reach by holding this concrete adapter rather than the interface.
  async getDurationMs(): Promise<number> {
    if (!this.playerRef) return 0;
    const seconds = await this.playerRef.getDuration();
    return Math.round(seconds * 1000);
  }

  setPlaybackRate(rate: number): void {
    this.setState({ playbackRate: rate });
  }

  on(event: PlayerEvent, cb: () => void): void {
    const set = this.eventListeners.get(event) ?? new Set();
    set.add(cb);
    this.eventListeners.set(event, set);
  }

  destroy(): void {
    this.stateListeners.clear();
    this.eventListeners.clear();
    this.readyWaiters = [];
    this.playerRef = null;
  }

  private setState(patch: Partial<YouTubeAdapterState>): void {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((cb) => cb(this.state));
  }

  private dispatch(event: PlayerEvent): void {
    this.eventListeners.get(event)?.forEach((cb) => cb());
  }

  private waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }
}
