# SyncStream Scaffold

Monorepo for the watch together platform. Scope of this scaffold: chat, YouTube, Google Drive, store ready packaging. See the blueprint document for full architecture.

## Layout
* apps/web: Next.js 14 (deploys to Vercel; desktop wraps this later)
* apps/mobile: Expo + expo-router (EAS builds for both stores)
* services/auth: NestJS, OAuth + email + guest tokens (port 4001)
* services/rooms: NestJS, rooms/queue/roles, issues socket tokens (port 4002)
* services/sync-gateway: plain Node + Socket.io, single instance for MVP (port 4003)
* packages/types: zod schemas shared everywhere
* packages/players: PlayerAdapter interface (the sync engine only sees this)
* packages/core: client sync engine (clock sync + drift corrector), built in M2
* db: Prisma schema and migrations

## Vertical slice: YouTube sync demo (pre-auth milestone)

This milestone proves out room creation, join-by-code, and synchronized YouTube
playback on Android before auth/persistence exist. No Postgres, no Docker,
no auth service needed for this slice - only sync-gateway and apps/mobile.

### 1. Run the gateway locally

```
pnpm --filter @syncstream/sync-gateway dev
```

Confirm `http://localhost:4003/health` returns `ok`. Find your dev machine's
LAN IP (Windows: `ipconfig`, look for the IPv4 address on your active
network adapter) - physical devices need this, the emulator does not.

### 2. Point the app at the gateway

The Android emulator reaches the host machine at `10.0.2.2`, which is the
default (`EXPO_PUBLIC_GATEWAY_URL` unset). A physical device is on the same
Wi-Fi as your dev machine but cannot resolve `10.0.2.2`, so it needs the LAN
IP instead:

```
EXPO_PUBLIC_GATEWAY_URL=http://<your-lan-ip>:4003 pnpm --filter @syncstream/mobile android
```

Run the emulator with the default env (no override needed) and the physical
device build with the LAN IP override. Both must be able to reach port 4003
on the dev machine - check Windows Firewall if the physical device times out.

### 3. Two-device sync check

1. On device A (host): enter a name, paste a YouTube URL, tap "Create room".
   Note the 6-character room code shown in the room screen header.
2. On device B: enter a name, enter the room code, tap "Join room".
3. Confirm the participant list on both devices shows both names, and only
   device A shows host controls (play/pause + seek bar); device A has the
   HOST badge.
4. Press play on device A. Confirm playback starts on both devices within
   about a second of each other.
5. Seek storm: on device A, tap several different points along the seek bar
   in quick succession (5-6 taps within a couple seconds). On both devices,
   watch the drift indicator under the player (`drift: Nms`). It should
   spike briefly after each seek and settle back under 600ms within a couple
   of drift-evaluation ticks (evaluated every 1s) - if it stays pinned above
   600ms, the epoch guard or hard-seek correction has a bug.
6. Pause on device A, confirm both devices pause within about a second.
7. Press the Android hardware back button on device B. Confirm it leaves the
   room (participant list on device A drops to one) rather than exiting the
   app.
8. Disconnect device A (kill the app or hardware back). Confirm device B is
   promoted to host (HOST badge and controls appear) within a couple seconds.

### Known limitation

The YouTube IFrame API does not expose a distinct "this is an ad" player
state (ads and content both report `playing`), so drift correction does not
currently pause during ads - see the comment in
`packages/players/src/youtube/YouTubeNativeAdapter.ts`.

## Local setup
1. Install Node 20+, pnpm 9, Docker.
2. cp .env.example .env and fill Google credentials (see below).
3. docker compose up -d
4. pnpm install
5. pnpm --filter @syncstream/db generate && pnpm db:migrate
6. pnpm dev (turbo runs web + all services)

Note: dependency versions are pinned loosely; run pnpm install and resolve any peer warnings once, then commit the lockfile.

## Free tier deployment
* Web: Vercel (import apps/web, set env vars).
* auth, rooms, sync-gateway: Render free web services. Caveat: free instances sleep after 15 min idle, so first join after idle takes ~30 s. Fine for dev/beta, upgrade the gateway first when it matters. WebSockets are supported on Render.
* Postgres: Neon free tier (set DATABASE_URL, run migrate:deploy).
* Redis: Upstash free tier (Redis protocol URL, works with ioredis).
* Vercel cannot host the Socket.io server; the gateway must live on Render.

## Google Cloud setup (do this first, it gates everything)
1. Create a project, enable: YouTube Data API v3, Google Picker API, Google Drive API.
2. OAuth consent screen: External. Scopes: openid, email, profile, drive.file.
   drive.file is deliberately chosen over drive.readonly: it is NOT a restricted
   scope, so no CASA security assessment is required for store release. Users pick
   videos with the Google Picker; the app only ever sees files they picked.
3. Create OAuth clients: Web (Vercel + localhost origins), iOS, Android.
4. Create an API key restricted to YouTube Data API for metadata resolution.

## Store readiness checklist (start these NOW, they have lead times)
* Apple Developer Program: enroll (99 USD/yr, verification can take days).
  Required for Sign in with Apple, which Apple mandates because we offer Google login.
* Google Play Console: register (25 USD). IMPORTANT: new personal accounts must run
  a closed test with 12 testers for 14 continuous days before production access is
  granted. This is the longest pole in "deployable to all stores"; create the
  account and start a closed track as early as builds exist. Organization accounts
  (with a D-U-N-S number) skip this requirement.
* Both stores will review UGC features: report content, block user, and moderation
  contact must exist in the app before submission (planned in M5).
* Privacy: App Store privacy nutrition labels + Google Play Data safety form; a
  hosted privacy policy URL is mandatory for both.
* YouTube ToS reminders baked into the design: ads play per viewer untouched, no
  background extraction, official players only.

## Build order (matches the blueprint implementation plan)
1. Auth service modules
2. Rooms service modules + socket token issuance
3. Gateway: join, snapshot, chat
4. Gateway: playback authority (anchor + epoch)
5. packages/core sync engine + tests
6. Web YouTube adapter, then Drive (Picker) adapter, room screen
7. Mobile parity, EAS builds
8. Store packaging + UGC moderation features
