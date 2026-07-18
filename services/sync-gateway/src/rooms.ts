import { randomInt } from "node:crypto";
import type { Participant, PlaybackCommand, PlaybackState } from "@syncstream/types";

// Ambiguous characters (I, O, 0, 1) excluded so codes are easy to read aloud
// and type on a phone keyboard.
const CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_EMPTY_MS = 30 * 60 * 1000;
const GC_SWEEP_INTERVAL_MS = 60 * 1000;

interface RoomParticipant extends Participant {
  joinedAt: number;
}

export interface Room {
  code: string;
  videoId: string;
  participants: Map<string, RoomParticipant>;
  playback: PlaybackState;
  emptySince: number | null;
}

export type PlaybackCommandResult =
  | { ok: true; state: PlaybackState }
  | { ok: false; reason: "not_host" | "stale_epoch" | "unsupported_action" };

function generateRoomCode(existing: Set<string>): string {
  let code: string;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARSET[randomInt(CODE_CHARSET.length)]).join("");
  } while (existing.has(code));
  return code;
}

function currentPositionMs(playback: PlaybackState, now: number): number {
  if (!playback.playing) return playback.anchorPositionMs;
  return playback.anchorPositionMs + (now - playback.anchorServerTime);
}

export function toParticipantList(room: Room): Participant[] {
  return Array.from(room.participants.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(({ id, name, isHost }) => ({ id, name, isHost }));
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  private gcTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.gcTimer = setInterval(() => this.sweep(), GC_SWEEP_INTERVAL_MS);
    this.gcTimer.unref?.();
  }

  createRoom(videoId: string): Room {
    const code = generateRoomCode(new Set(this.rooms.keys()));
    const room: Room = {
      code,
      videoId,
      participants: new Map(),
      playback: {
        itemId: videoId,
        playing: false,
        anchorPositionMs: 0,
        anchorServerTime: Date.now(),
        epoch: 0,
      },
      emptySince: Date.now(),
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  // First socket to join a freshly created room becomes host. Returns the
  // participant record so callers can tell whether this join granted host.
  join(code: string, socketId: string, name: string): RoomParticipant | null {
    const room = this.rooms.get(code);
    if (!room) return null;

    const isHost = !Array.from(room.participants.values()).some((p) => p.isHost);
    const participant: RoomParticipant = { id: socketId, name, isHost, joinedAt: Date.now() };
    room.participants.set(socketId, participant);
    room.emptySince = null;
    return participant;
  }

  // Removes a participant, promoting the oldest remaining participant to
  // host if the departing participant was host. Returns the room (so the
  // caller can broadcast) or null if the room no longer exists.
  leave(code: string, socketId: string): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;

    const leaving = room.participants.get(socketId);
    room.participants.delete(socketId);

    if (leaving?.isHost && room.participants.size > 0) {
      const oldest = toParticipantList(room)[0];
      const promoted = room.participants.get(oldest.id);
      if (promoted) promoted.isHost = true;
    }

    if (room.participants.size === 0) {
      room.emptySince = Date.now();
    }

    return room;
  }

  applyPlaybackCommand(code: string, socketId: string, cmd: PlaybackCommand, now = Date.now()): PlaybackCommandResult {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, reason: "not_host" };

    const participant = room.participants.get(socketId);
    if (!participant?.isHost) return { ok: false, reason: "not_host" };

    if (cmd.epoch < room.playback.epoch) {
      return { ok: false, reason: "stale_epoch" };
    }

    const nextEpoch = room.playback.epoch + 1;
    const positionAtNow = currentPositionMs(room.playback, now);

    switch (cmd.action) {
      case "play":
        room.playback = {
          ...room.playback,
          playing: true,
          anchorPositionMs: cmd.positionMs ?? positionAtNow,
          anchorServerTime: now,
          epoch: nextEpoch,
        };
        break;
      case "pause":
        room.playback = {
          ...room.playback,
          playing: false,
          anchorPositionMs: cmd.positionMs ?? positionAtNow,
          anchorServerTime: now,
          epoch: nextEpoch,
        };
        break;
      case "seek":
        room.playback = {
          ...room.playback,
          anchorPositionMs: cmd.positionMs ?? positionAtNow,
          anchorServerTime: now,
          epoch: nextEpoch,
        };
        break;
      case "skip":
        // Queue/multi-item support lands in a later build-order step; a
        // single video per room has nothing to skip to yet.
        return { ok: false, reason: "unsupported_action" };
      default:
        return { ok: false, reason: "unsupported_action" };
    }

    return { ok: true, state: room.playback };
  }

  private sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince > ROOM_TTL_EMPTY_MS) {
        this.rooms.delete(code);
      }
    }
  }
}
