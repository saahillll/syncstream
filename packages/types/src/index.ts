import { z } from "zod";

export const MediaSource = z.enum(["youtube", "gdrive"]);
export type MediaSource = z.infer<typeof MediaSource>;

// itemId is a plain string (the YouTube videoId) for this milestone; a real
// queue with uuid item ids arrives in a later build-order step.
export const PlaybackCommand = z.object({
  action: z.enum(["play", "pause", "seek", "skip"]),
  positionMs: z.number().int().nonnegative().optional(),
  itemId: z.string().min(1).optional(),
  epoch: z.number().int().nonnegative(),
});
export type PlaybackCommand = z.infer<typeof PlaybackCommand>;

// Authoritative state broadcast by the gateway. Position at time t is
// anchorPositionMs + (t - anchorServerTime) while playing.
export const PlaybackState = z.object({
  itemId: z.string().min(1).nullable(),
  playing: z.boolean(),
  anchorPositionMs: z.number().int().nonnegative(),
  anchorServerTime: z.number(),
  epoch: z.number().int().nonnegative(),
});
export type PlaybackState = z.infer<typeof PlaybackState>;

export const ChatSend = z.object({ body: z.string().min(1).max(2000) });
export type ChatSend = z.infer<typeof ChatSend>;

// --- Vertical slice: room creation, join, presence, clock sync ---

export const RoomCreateRequest = z.object({
  hostName: z.string().min(1).max(40),
  videoUrl: z.string().min(1),
});
export type RoomCreateRequest = z.infer<typeof RoomCreateRequest>;

export const RoomCreateResponse = z.object({ code: z.string().length(6) });
export type RoomCreateResponse = z.infer<typeof RoomCreateResponse>;

export const RoomJoin = z.object({
  code: z.string().length(6),
  name: z.string().min(1).max(40),
});
export type RoomJoin = z.infer<typeof RoomJoin>;

export const Participant = z.object({
  id: z.string(),
  name: z.string(),
  isHost: z.boolean(),
});
export type Participant = z.infer<typeof Participant>;

export const RoomSnapshot = z.object({
  code: z.string().length(6),
  videoId: z.string(),
  participants: z.array(Participant),
  playback: PlaybackState,
});
export type RoomSnapshot = z.infer<typeof RoomSnapshot>;

export const PresenceUpdate = z.object({
  participants: z.array(Participant),
});
export type PresenceUpdate = z.infer<typeof PresenceUpdate>;

export const ClockPong = z.object({ serverTime: z.number() });
export type ClockPong = z.infer<typeof ClockPong>;

export const ErrorPayload = z.object({ message: z.string() });
export type ErrorPayload = z.infer<typeof ErrorPayload>;
