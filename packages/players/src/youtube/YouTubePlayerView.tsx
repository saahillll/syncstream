import React, { useEffect, useRef, useState } from "react";
import YoutubePlayer, { type YoutubeIframeRef } from "react-native-youtube-iframe";
import type { YouTubeAdapterState, YouTubeNativeAdapter } from "./YouTubeNativeAdapter.js";

export interface YouTubePlayerViewProps {
  adapter: YouTubeNativeAdapter;
  height: number;
}

// Renders the official YouTube IFrame player (inside a WebView, via
// react-native-youtube-iframe) and keeps it in sync with the adapter's
// pub/sub state. This is the only place in the app that touches the
// underlying library's props/ref API - everything else talks to the
// PlayerAdapter interface.
export function YouTubePlayerView({ adapter, height }: YouTubePlayerViewProps) {
  const playerRef = useRef<YoutubeIframeRef | null>(null);
  const [state, setState] = useState<YouTubeAdapterState>(() => adapter.getSnapshot());

  useEffect(() => adapter.subscribe(setState), [adapter]);

  useEffect(() => {
    adapter.bindPlayerRef(playerRef.current);
    return () => adapter.bindPlayerRef(null);
  }, [adapter, state.videoId]);

  if (!state.videoId) return null;

  return (
    <YoutubePlayer
      ref={playerRef}
      height={height}
      play={state.playing}
      playbackRate={state.playbackRate}
      videoId={state.videoId}
      onReady={() => adapter.handleReady()}
      onChangeState={(iframeState: string) => adapter.handleStateChange(iframeState)}
    />
  );
}
