# SyncStream

Cross platform watch party app (chat + synchronized YouTube + Google Drive playback). Web, iOS, Android now; desktop (Tauri) later. Full blueprint lives in docs/blueprint.md if present; this file is the working contract.

## Stack and layout
* pnpm 9 + Turborepo monorepo. Node 20+ (dev machine runs Node 24, works so far).
* apps/web: Next.js 14 App Router, port 3000. Dark theme, colors #0f1117 bg / #e6e8ee text.
* apps/mobile: Expo + expo-router, EAS builds. Bundle ids still com.CHANGE_ME.syncstream.
* services/auth: NestJS, port 4001. services/rooms: NestJS, port 4002.
* services/sync-gateway: plain Node + Socket.io + tsx, port 4003, /health endpoint. Single instance for MVP: do NOT add the Socket.io Redis adapter yet.
* packages/types: zod schemas shared everywhere. packages/players: PlayerAdapter interface. packages/core: client sync engine (clock sync + drift corrector), not yet implemented.
* db: Prisma 5, PostgreSQL. Local infra via docker compose (postgres 5432, redis 6379).

## Hard rules (do not violate)
* Google Drive uses the drive.file scope with Google Picker ONLY. Never introduce drive.readonly or any restricted scope (it triggers Google CASA assessment and blocks store release). Each participant fetches their own playback URL with their own OAuth token; never proxy, rehost, or share Drive stream URLs across users.
* YouTube: official IFrame API / react-native-youtube-iframe only. Never block ads, extract streams, or enable background playback.
* No OTT (Netflix etc.) integrations of any kind. No DRM circumvention.
* Sync authority lives server side in the gateway: anchor state { itemId, playing, anchorPositionMs, anchorServerTime, epoch }. Clients predict locally and correct via ladder: drift <100ms ignore, 100-500ms playbackRate nudge (1.02/0.98), >500ms hard seek. Commands carry epoch; stale epochs are discarded.
* Playback role checks happen in the gateway on every command, never trust client role state.
* After completing each task, provide stesps for commit with a descriptive message

## Conventions
* TypeScript strict everywhere. Shared request/response shapes go in packages/types as zod schemas first, then infer types.
* Sync engine code in packages/core must only depend on the PlayerAdapter interface, never a concrete adapter.
* Auth: argon2id for passwords, RS256 JWTs (15 min access), refresh rotation with hashed tokens in DB. Guest tokens are room scoped, max 12h.
* REST errors: RFC 7807 problem+json. Socket events named domain:action (playback:command, chat:send).
* Keep services free of business logic duplication: rooms service issues short lived socket tokens; gateway verifies them.

## Environment quirks (already learned the hard way)
* Windows dev machine, PowerShell. Prisma needs db/.env as a copy of root .env (DATABASE_URL). If DATABASE_URL changes, update both, or better: fix env loading properly and delete the duplicate.
* @types/node was added to auth, rooms, sync-gateway after initial scaffold; keep it when adding new services.
* pnpm dev runs everything including Expo (noisy). Web+backend only: pnpm dev --filter=!@syncstream/mobile
* Migrations: pnpm --filter @syncstream/db generate, then pnpm db:migrate.

## Deployment targets (free tier)
* Web on Vercel. Services on Render (free instances sleep after 15 min idle; gateway must NOT move to Vercel, it needs long lived WebSockets). Postgres on Neon, Redis on Upstash (Redis protocol via ioredis).

## Build order and current status
Done: scaffold runs locally (web 3000 OK, gateway /health OK, both Nest services boot, Prisma migrated).
1. NEXT: Auth service modules: email register/login/verify, Google id_token verification, refresh rotation, guest tokens. Apple Sign In stubbed until Apple Developer enrollment completes.
2. Rooms service: CRUD, nanoid(8) slugs, join + socket token issuance, queue with YouTube Data API v3 metadata resolution.
3. Gateway: socket auth, room join + room:snapshot, chat:send with Redis rate limit (5 msg/5s), persistence.
4. Gateway: playback authority (anchor + epoch broadcast).
5. packages/core: clock sync (NTP style over socket, rolling median of 5) + drift corrector + heavy unit tests with a simulated player. Highest test coverage in the repo.
6. Web: YouTube adapter, Drive Picker adapter, room screen wiring player + sync + chat.
7. Mobile parity, EAS builds.
8. Store packaging: report/block moderation features (Apple and Google require them for UGC), privacy policy URL, data safety forms.

## Store constraints to remember
* Google Play personal account: closed test with 12 testers for 14 continuous days before production access.
* Apple requires Sign in with Apple because Google login is offered.

## Working style for this repo owner
* Explain decisions briefly before large changes; prefer incremental module by module implementation matching the build order above.
* Never use em dashes or triple hyphen horizontal rules in generated docs or comments.
