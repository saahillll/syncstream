import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  LayoutChangeEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { io, type Socket } from "socket.io-client";
import type { Participant, PlaybackState, RoomSnapshot } from "@syncstream/types";
import { ClockSync, CLOCK_RESAMPLE_INTERVAL_MS, DRIFT_EVAL_INTERVAL_MS, SyncEngine, targetPositionMs } from "@syncstream/core";
import { YouTubeNativeAdapter, YouTubePlayerView } from "@syncstream/players/src/youtube";
import { GATEWAY_URL } from "../../lib/gateway";
import { COLORS } from "../../lib/theme";

const CLOCK_SAMPLE_BURST = 5;

async function sampleClockOnce(socket: Socket, clock: ClockSync): Promise<void> {
  const t0 = Date.now();
  const serverTime = await new Promise<number>((resolve) => {
    socket.once("clock:pong", (payload: { serverTime: number }) => resolve(payload.serverTime));
    socket.emit("clock:ping");
  });
  clock.recordSample(t0, serverTime, Date.now());
}

async function sampleClockBurst(socket: Socket, clock: ClockSync): Promise<void> {
  for (let i = 0; i < CLOCK_SAMPLE_BURST; i++) {
    await sampleClockOnce(socket, clock);
  }
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function Room() {
  const { code, name } = useLocalSearchParams<{ code: string; name: string }>();
  const router = useRouter();

  const [adapter] = useState(() => new YouTubeNativeAdapter());
  const [clock] = useState(() => new ClockSync());
  const [engine] = useState(() => new SyncEngine({ adapter, clock }));

  const socketRef = useRef<Socket | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  // True until the initial room:snapshot (or a definitive room:error)
  // arrives. The Render free instance sleeps when idle, so the first
  // connection here can take 30-60s while it wakes up.
  const [connecting, setConnecting] = useState(true);
  const [socketConnectError, setSocketConnectError] = useState<string | null>(null);
  const [driftMs, setDriftMs] = useState<number | null>(null);
  const [backoffActive, setBackoffActive] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [seekBarWidth, setSeekBarWidth] = useState(0);

  const isHost = participants.find((p) => p.id === selfId)?.isHost ?? false;

  const leaveRoom = useCallback(() => {
    socketRef.current?.disconnect();
    router.replace("/");
  }, [router]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      leaveRoom();
      return true;
    });
    return () => sub.remove();
  }, [leaveRoom]);

  useEffect(() => {
    adapter.on("ready", () => {
      setPlayerError(null);
      adapter.getDurationMs().then(setDurationMs);
    });
    adapter.on("error", () => {
      setPlayerError("This video can't be played in embedded players; host should pick another video.");
    });
  }, [adapter]);

  useEffect(() => {
    const socket = io(`${GATEWAY_URL}/room`, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketConnectError(null);
      setSelfId(socket.id ?? null);
      socket.emit("room:join", { code, name });
      void sampleClockBurst(socket, clock);
    });

    socket.on("connect_error", () => {
      setSocketConnectError("Having trouble reaching the server - it may be waking up from sleep.");
    });

    socket.on("room:snapshot", (snapshot: RoomSnapshot) => {
      setConnecting(false);
      setParticipants(snapshot.participants);
      setPlayback(snapshot.playback);
      // Errors surface via the adapter's "error" event listener above;
      // caught here only to avoid an unhandled rejection.
      engine.applyState(snapshot.playback, Date.now()).catch(() => {});
    });

    socket.on("presence:update", (payload: { participants: Participant[] }) => {
      setParticipants(payload.participants);
    });

    socket.on("playback:state", (state: PlaybackState) => {
      setPlayback(state);
      engine.applyState(state, Date.now()).catch(() => {});
    });

    socket.on("room:error", (payload: { message: string }) => {
      setConnecting(false);
      setConnectionError(payload.message);
    });

    const clockInterval = setInterval(() => {
      void sampleClockBurst(socket, clock);
    }, CLOCK_RESAMPLE_INTERVAL_MS);

    return () => {
      clearInterval(clockInterval);
      socket.disconnect();
      engine.destroy();
    };
  }, [code, name, clock, engine]);

  useEffect(() => {
    const tickInterval = setInterval(async () => {
      const decision = await engine.tick(Date.now());
      if (decision) setDriftMs(decision.driftMs);
      setBackoffActive(engine.isBackoffActive());

      const latest = engine.getLatestState();
      if (latest) {
        setPositionMs(targetPositionMs(latest, clock.toServerTime(Date.now())));
      }
    }, DRIFT_EVAL_INTERVAL_MS);
    return () => clearInterval(tickInterval);
  }, [engine, clock]);

  function sendCommand(action: "play" | "pause" | "seek", overridePositionMs?: number) {
    if (!socketRef.current || !playback) return;
    socketRef.current.emit("playback:command", {
      action,
      positionMs: overridePositionMs,
      itemId: playback.itemId ?? undefined,
      epoch: playback.epoch,
    });
  }

  function handleSeekBarLayout(e: LayoutChangeEvent) {
    setSeekBarWidth(e.nativeEvent.layout.width);
  }

  function handleSeekBarPress(locationX: number) {
    if (durationMs <= 0 || seekBarWidth <= 0) return;
    const fraction = Math.min(1, Math.max(0, locationX / seekBarWidth));
    sendCommand("seek", Math.round(fraction * durationMs));
  }

  function retryConnection() {
    setSocketConnectError(null);
    socketRef.current?.connect();
  }

  const progressPct = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  if (connecting) {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.code}>Room {code}</Text>
          <TouchableOpacity onPress={leaveRoom}>
            <Text style={styles.leave}>Leave</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.connectingContainer}>
          <ActivityIndicator color={COLORS.accent} size="large" />
          <Text style={styles.connectingText}>{socketConnectError ?? "Connecting to the room..."}</Text>
          <Text style={styles.connectingHint}>
            The server can take up to a minute to wake up on its first request.
          </Text>
          {socketConnectError && (
            <TouchableOpacity style={styles.retryButton} onPress={retryConnection}>
              <Text style={styles.retryButtonText}>Retry now</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.code}>Room {code}</Text>
        <TouchableOpacity onPress={leaveRoom}>
          <Text style={styles.leave}>Leave</Text>
        </TouchableOpacity>
      </View>

      {connectionError && <Text style={styles.error}>{connectionError}</Text>}
      {playerError && <Text style={styles.error}>{playerError}</Text>}

      <YouTubePlayerView adapter={adapter} height={220} />

      <View style={styles.statusRow}>
        <Text style={styles.statusText}>
          {formatClock(positionMs)} {durationMs > 0 ? `/ ${formatClock(durationMs)}` : ""}
        </Text>
        <Text style={styles.driftText}>
          {backoffActive
            ? "drift: corrections paused (struggling to keep up)"
            : `drift: ${driftMs === null ? "-" : `${Math.round(driftMs)}ms`}`}
        </Text>
      </View>

      {isHost ? (
        <View style={styles.hostControls}>
          <TouchableOpacity style={styles.playPause} onPress={() => sendCommand(playback?.playing ? "pause" : "play")}>
            <Text style={styles.playPauseText}>{playback?.playing ? "Pause" : "Play"}</Text>
          </TouchableOpacity>
          <TouchableWithoutFeedback onPress={(e) => handleSeekBarPress(e.nativeEvent.locationX)}>
            <View style={styles.seekBar} onLayout={handleSeekBarLayout}>
              <View style={[styles.seekBarFill, { width: `${progressPct}%` }]} />
            </View>
          </TouchableWithoutFeedback>
        </View>
      ) : (
        <Text style={styles.nonHostHint}>Only the host can control playback.</Text>
      )}

      <Text style={styles.participantsTitle}>Participants ({participants.length})</Text>
      {participants.map((p) => (
        <View key={p.id} style={styles.participantRow}>
          <Text style={styles.participantName}>{p.name}</Text>
          {p.isHost && <Text style={styles.hostBadge}>HOST</Text>}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  code: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 2,
  },
  leave: {
    color: COLORS.danger,
    fontSize: 14,
    fontWeight: "600",
  },
  error: {
    color: COLORS.danger,
    marginBottom: 12,
  },
  connectingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingBottom: 96,
    gap: 12,
  },
  connectingText: {
    color: COLORS.text,
    fontSize: 15,
    textAlign: "center",
  },
  connectingHint: {
    color: COLORS.textDim,
    fontSize: 12,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryButtonText: {
    color: COLORS.bg,
    fontWeight: "700",
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 12,
  },
  statusText: {
    color: COLORS.text,
    fontSize: 14,
  },
  driftText: {
    color: COLORS.textDim,
    fontSize: 12,
  },
  hostControls: {
    marginTop: 16,
  },
  playPause: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
    marginBottom: 12,
  },
  playPauseText: {
    color: COLORS.bg,
    fontWeight: "700",
  },
  seekBar: {
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.border,
    overflow: "hidden",
  },
  seekBarFill: {
    height: 8,
    backgroundColor: COLORS.accent,
  },
  nonHostHint: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 16,
  },
  participantsTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 28,
    marginBottom: 8,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  participantName: {
    color: COLORS.text,
    fontSize: 14,
    flex: 1,
  },
  hostBadge: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
});
