import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Server } from "socket.io";
import { PlaybackCommand, RoomCreateRequest, RoomJoin, type RoomSnapshot } from "@syncstream/types";
import { RoomStore, toParticipantList } from "./rooms.js";
import { parseYouTubeVideoId } from "./youtube.js";

// Sync gateway for the pre-auth vertical slice milestone: no persistence, no
// JWT verification, no Redis. Room state lives entirely in the RoomStore
// (in-memory Map). MVP runs a SINGLE instance, so the Socket.io Redis
// adapter is intentionally omitted.
//
// Handlers implemented here:
//   REST POST /rooms          create a room from a pasted YouTube URL
//   socket room:join          first joiner becomes host, replies room:snapshot
//   socket playback:command   host-only, epoch-guarded, broadcasts playback:state
//   socket clock:ping         NTP style offset sampling, replies clock:pong
//   socket disconnect         leave, promote oldest participant to host

const rooms = new RoomStore();

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendProblem(res: ServerResponse, status: number, title: string, detail: string) {
  res.writeHead(status, { "Content-Type": "application/problem+json" });
  res.end(JSON.stringify({ type: "about:blank", title, status, detail }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length ? JSON.parse(raw) : {};
}

async function handleCreateRoom(req: IncomingMessage, res: ServerResponse) {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendProblem(res, 400, "Invalid JSON", "Request body could not be parsed as JSON.");
  }

  const parsed = RoomCreateRequest.safeParse(body);
  if (!parsed.success) {
    return sendProblem(res, 400, "Invalid request", parsed.error.issues.map((i) => i.message).join("; "));
  }

  const videoId = parseYouTubeVideoId(parsed.data.videoUrl);
  if (!videoId) {
    return sendProblem(res, 400, "Unrecognized YouTube URL", "Could not extract a videoId from videoUrl.");
  }

  const room = rooms.createRoom(videoId);
  console.log(`room:create code=${room.code} videoId=${videoId}`);
  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: room.code }));
}

const httpServer = createServer((req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.method === "POST" && req.url === "/rooms") {
    handleCreateRoom(req, res).catch(() => sendProblem(res, 500, "Internal error", "Failed to create room."));
    return;
  }

  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const roomNamespace = io.of("/room");

function snapshotFor(code: string): RoomSnapshot | null {
  const room = rooms.getRoom(code);
  if (!room) return null;
  return {
    code: room.code,
    videoId: room.videoId,
    participants: toParticipantList(room),
    playback: room.playback,
  };
}

roomNamespace.on("connection", (socket) => {
  socket.emit("gateway:hello", { serverTime: Date.now() });

  let joinedCode: string | null = null;
  let joinedName: string | null = null;

  socket.on("room:join", (payload) => {
    const parsed = RoomJoin.safeParse(payload);
    if (!parsed.success) {
      socket.emit("room:error", { message: "Invalid join payload." });
      return;
    }

    const { code, name } = parsed.data;

    if (joinedCode && joinedCode !== code) {
      const previousRoom = rooms.leave(joinedCode, socket.id);
      socket.leave(joinedCode);
      console.log(`room:leave code=${joinedCode} name=${joinedName}`);
      if (previousRoom) {
        roomNamespace.to(joinedCode).emit("presence:update", { participants: toParticipantList(previousRoom) });
      }
      joinedCode = null;
      joinedName = null;
    }

    const participant = rooms.join(code, socket.id, name);
    if (!participant) {
      socket.emit("room:error", { message: `Room ${code} not found.` });
      return;
    }

    joinedCode = code;
    joinedName = name;
    socket.join(code);
    console.log(`room:join code=${code} name=${name}`);

    const room = rooms.getRoom(code)!;
    socket.emit("room:snapshot", snapshotFor(code));
    roomNamespace.to(code).emit("presence:update", { participants: toParticipantList(room) });
  });

  socket.on("playback:command", (payload) => {
    if (!joinedCode) {
      socket.emit("room:error", { message: "Join a room before sending playback commands." });
      return;
    }

    const parsed = PlaybackCommand.safeParse(payload);
    if (!parsed.success) {
      socket.emit("room:error", { message: "Invalid playback command." });
      return;
    }

    const result = rooms.applyPlaybackCommand(joinedCode, socket.id, parsed.data);
    if (!result.ok) {
      socket.emit("room:error", { message: `Playback command rejected: ${result.reason}` });
      return;
    }

    roomNamespace.to(joinedCode).emit("playback:state", result.state);
  });

  socket.on("clock:ping", () => {
    socket.emit("clock:pong", { serverTime: Date.now() });
  });

  socket.on("disconnect", () => {
    if (!joinedCode) return;
    const room = rooms.leave(joinedCode, socket.id);
    console.log(`room:leave code=${joinedCode} name=${joinedName}`);
    if (room) {
      roomNamespace.to(joinedCode).emit("presence:update", { participants: toParticipantList(room) });
    }
  });
});

// Render's port detection requires binding a non-loopback interface;
// binding only "localhost" (the default when host is omitted) is invisible
// to it and readiness checks time out.
const port = Number(process.env.PORT ?? process.env.GATEWAY_PORT ?? 4003);
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`sync-gateway listening on 0.0.0.0:${port}`);
});
