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

const LOAD_TIMEOUT_MS = 10_000;

interface PendingLoad {
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

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
  // The IFrame API only supports discrete rates (0.25/0.5/0.75/1/1.25...),
  // so the sync engine's fine 1.02x/0.98x rate-nudge tier is a no-op here.
  readonly supportsFineRateControl = false;

  private state: YouTubeAdapterState = { videoId: null, playing: false, playbackRate: 1 };
  private stateListeners = new Set<(state: YouTubeAdapterState) => void>();
  private eventListeners = new Map<PlayerEvent, Set<() => void>>();
  private playerRef: YoutubeIframeRef | null = null;
  private pendingLoad: PendingLoad | null = null;

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
    this.dispatch("ready");
    this.settlePendingLoad((load) => load.resolve());
  }

  handleStateChange(iframeState: string): void {
    const event = YOUTUBE_IFRAME_STATE_TO_EVENT[iframeState];
    if (event) this.dispatch(event);
  }

  // react-native-youtube-iframe's onError callback (e.g. "embed_not_allowed"
  // for videos with embedding disabled by the uploader).
  handleError(message: string): void {
    this.dispatch("error");
    this.settlePendingLoad((load) => load.reject(new Error(message)));
  }

  async load(sourceRef: string): Promise<void> {
    // A load already in flight (e.g. the host switched videos again before
    // the previous one became ready) is superseded, not left dangling.
    this.settlePendingLoad((load) => load.reject(new Error("Load superseded by a newer load() call.")));

    this.setState({ videoId: sourceRef });

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingLoad = null;
        this.dispatch("error");
        reject(new Error(`Timed out loading video ${sourceRef}.`));
      }, LOAD_TIMEOUT_MS);
      this.pendingLoad = { resolve, reject, timeoutId };
    });
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

  // The IFrame API's discrete rates make anything other than "back to
  // normal speed" a no-op - see supportsFineRateControl.
  setPlaybackRate(rate: number): void {
    if (rate !== 1) return;
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
    this.settlePendingLoad((load) => load.reject(new Error("Adapter destroyed while load() was pending.")));
    this.playerRef = null;
  }

  private setState(patch: Partial<YouTubeAdapterState>): void {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((cb) => cb(this.state));
  }

  private dispatch(event: PlayerEvent): void {
    this.eventListeners.get(event)?.forEach((cb) => cb());
  }

  private settlePendingLoad(settle: (load: PendingLoad) => void): void {
    const load = this.pendingLoad;
    if (!load) return;
    clearTimeout(load.timeoutId);
    this.pendingLoad = null;
    settle(load);
  }
}
