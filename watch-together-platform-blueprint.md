# Watch Together Platform: Complete Product and Architecture Blueprint

Working name: **SyncStream** (placeholder). Cross platform watch party application. Web, iOS, Android, Windows, macOS.

Scope decisions locked in from discovery:
* Deliverables: all 12 in this single document.
* Content scope: tiered. Tier 1 is YouTube plus Google Drive. Tier 2 adds Vimeo and direct video URLs. Tier 3 (OTT partnerships) is a business track, not an MVP engineering track. See Section 8.
* Voice chat: zero cost constraint. MVP uses peer to peer WebRTC mesh (free, capped at 8 speakers per room), with a documented migration path to self hosted LiveKit when scale demands it. See Sections 2 and 7.

## 1. Product Requirements Document (PRD)

### 1.1 Problem statement
People watching the same content in different locations have no low friction way to stay perfectly in sync while talking about it. Existing tools (Rave, Teleparty) are either mobile only, extension bound, or legally fragile.

### 1.2 Goals
* Sub 250 ms perceived playback drift between participants on stable connections.
* Join a room from an invite link in under 10 seconds, including guests without accounts.
* Fully legal content sourcing. No DRM circumvention, no scraping, no unofficial stream extraction.

### 1.3 Non goals (MVP)
* Screen sharing or camera video chat.
* Native playback of DRM protected OTT catalogs (Netflix, Disney+, Prime). See Section 8 for why and what instead.
* Monetization, ads, creator tooling.

### 1.4 Personas
* **Host Hannah**: creates rooms, curates the queue, moderates chat.
* **Guest Gio**: taps an invite link on mobile, wants to be watching within seconds, may not have an account.
* **Community Casey**: browses public rooms, joins strangers watching trending content.

### 1.5 Functional requirements

FR groups, each with acceptance criteria summarized:

**Rooms**
* Create room with title, visibility (public or private), and optional password.
* Invite link with short slug (example: sync.app/r/aB3xK9). Deep links open the native app when installed.
* Public room directory with search and category filters.
* Room capacity: 50 participants MVP, 8 concurrent voice speakers.

**Playback synchronization**
* Host or co host actions (play, pause, seek, skip to next queue item) propagate to all clients within 500 ms end to end.
* Late joiners land within 250 ms of live room position automatically.
* Volume sync is opt in per participant, never forced.

**Content sources**
* YouTube via official IFrame Player API (web, desktop) and official YouTube mobile SDKs or embedded WebView player (mobile), fully compliant with YouTube ToS (no background extraction, ads preserved).
* Google Drive: user authorizes via OAuth, app lists their own video files, playback through streamable Drive URLs in an HTML5 player. Only the file owner or users the file is shared with can play it; the app never proxies or rehosts file bytes.
* Vimeo via official Player SDK.
* Direct URLs: publicly accessible MP4/WebM/HLS links, played in HTML5 video or hls.js.

**Social**
* Text chat with typing indicators, message history for the room session, emoji reactions that float over the player.
* Voice chat: push to talk and open mic modes, per user mute, host can mute others.
* Live participant list with role badges and speaking indicators.

**Roles and permissions**
* Host: full control, assigns co hosts, kicks or bans, deletes room.
* Co host: playback control, queue management, chat moderation.
* Participant: chat, react, request control, vote skip (optional room setting).

**Auth**
* Google Sign In, Apple Sign In (required for iOS anyway), email plus password with verification.
* Guest mode: join by link with a display name only; guest identity is room scoped and ephemeral.

### 1.6 Non functional requirements
* p95 sync command latency under 500 ms globally.
* 99.5 percent uptime target for MVP, 99.9 post GA.
* Horizontal scalability to 10k concurrent rooms without redesign.
* WCAG 2.1 AA accessibility on web.
* GDPR and CCPA compliant data handling; COPPA posture: 13 plus only.

### 1.7 Success metrics
* D7 retention of room creators above 25 percent.
* Median time from link tap to synced playback under 10 s.
* Average session length above 30 minutes.
* Sync complaint rate (user reported desync) under 2 percent of sessions.

## 2. System Architecture

### 2.1 High level topology

Clients
* Web app (Next.js, deployed on Vercel or CloudFront + S3)
* Mobile apps (React Native, iOS and Android)
* Desktop apps (the Next.js web app wrapped in Electron or Tauri; Tauri preferred for footprint)

Edge and entry
* CDN and WAF (Cloudflare) in front of everything
* API Gateway / load balancer (AWS ALB or Cloudflare Load Balancing)

Services (containerized, ECS Fargate or Kubernetes; start with 4 services, not 15)
1. **Auth Service** (NestJS): OAuth flows, JWT issuance, session and refresh token management, guest tokens.
2. **Room Service** (NestJS): room CRUD, membership, roles, invites, public directory, queue management. Owns PostgreSQL writes.
3. **Sync Gateway** (Node + Socket.io): stateful WebSocket layer. Rooms are sharded across gateway instances; Redis pub/sub (Socket.io Redis adapter) fans events out across instances. Holds authoritative playback state per room in Redis.
4. **Chat/Presence Service**: can live inside the Sync Gateway for MVP (same socket), split later when message volume justifies it.

Voice (zero cost MVP)
* Pure WebRTC mesh between participants. Signaling rides the existing Socket.io connection (offer/answer/ICE relay). STUN via free Google STUN servers. No SFU, no media server bill.
* Constraint this imposes: each speaker uplinks N minus 1 audio streams, so cap active speakers at 8. Listeners beyond that receive but do not transmit.
* Migration path: self hosted LiveKit on a single VM when rooms need more speakers; the client API surface (join, publish, mute) is abstracted behind a VoiceProvider interface from day one so the swap does not touch UI code.

Data layer
* **PostgreSQL** (managed, RDS or Neon): durable data. Users, rooms, memberships, bans, queue snapshots.
* **Redis** (ElastiCache or Upstash): live room state (playback position, epoch, participants), pub/sub bus, rate limiting, presence TTLs.

Supporting
* Object storage (S3) for avatars only. No video bytes ever.
* Background worker (BullMQ on Redis) for email verification, room cleanup, abuse report processing.
* Observability: OpenTelemetry to Grafana Cloud free tier; Sentry free tier for client errors.

### 2.2 Why this shape
* Splitting the stateful realtime plane (Sync Gateway) from the stateless CRUD plane (Auth, Room) is the one microservice boundary that pays for itself immediately: they scale on different axes (connections vs requests) and fail differently.
* Everything else stays consolidated until metrics force a split. Premature microservices are the top cause of MVP timeline blowouts.

### 2.3 Request flows (summary)
* Join room: client hits Room Service REST to validate invite and fetch a room token, then opens a socket to the Sync Gateway with that token, receives full room snapshot (state, queue, participants, recent chat), and renders.
* Playback command: host emits command over socket, gateway validates role, updates Redis authoritative state, broadcasts to room channel, persists a lightweight event row asynchronously.

## 3. Database Schema (PostgreSQL)

Conventions: uuid primary keys, timestamptz, soft deletes where noted. Live playback state is in Redis, not Postgres.

**users**
* id uuid PK
* email citext unique nullable (null for pure OAuth accounts until linked)
* display_name text
* avatar_url text
* auth_provider enum(email, google, apple)
* provider_subject text (OAuth sub claim), unique per provider
* email_verified_at timestamptz
* created_at, updated_at, deleted_at

**credentials** (email auth only)
* user_id uuid PK FK users
* password_hash text (argon2id)
* updated_at

**refresh_tokens**
* id uuid PK, user_id FK, token_hash text, device_info jsonb, expires_at, revoked_at

**rooms**
* id uuid PK
* slug varchar(12) unique (invite code)
* owner_id uuid FK users
* title text, description text
* visibility enum(public, private)
* password_hash text nullable
* max_participants int default 50
* settings jsonb (vote_skip, guest_chat_allowed, volume_sync_default, e2ee_chat boolean)
* status enum(active, ended)
* created_at, ended_at

**room_members**
* room_id FK, user_id FK nullable, guest_id text nullable (one of the two)
* role enum(host, cohost, participant)
* joined_at, left_at
* PK (room_id, coalesce identity)
* Note: presence (who is online right now) lives in Redis; this table is membership and role history.

**room_bans**
* room_id FK, banned_user_id FK nullable, banned_ip_hash text nullable, reason text, created_by FK, created_at

**queue_items**
* id uuid PK, room_id FK
* source enum(youtube, gdrive, vimeo, direct)
* source_ref text (video id, Drive file id, or URL)
* title text, duration_seconds int, thumbnail_url text
* added_by FK, position int, played_at timestamptz nullable
* Unique (room_id, position)

**chat_messages** (session scoped retention, purged 24 h after room ends)
* id uuid PK, room_id FK, sender identity, body text or ciphertext bytea, is_encrypted boolean, created_at, deleted_at

**playback_events** (analytics/audit, partitioned by month)
* id bigserial, room_id, actor, event enum(play, pause, seek, skip, source_change), position_ms bigint, created_at

**reports**
* id, room_id, reporter, target, reason, status, created_at

Indexes worth calling out: rooms(visibility, status) partial index for the public directory; queue_items(room_id, position); refresh_tokens(user_id, expires_at); playback_events BRIN on created_at.

## 4. API Documentation (REST plus Socket events)

Base URL: /api/v1. JWT bearer auth unless marked public. Errors follow RFC 7807 problem+json.

### 4.1 Auth
* POST /auth/register (public): email, password, display_name. Sends verification email.
* POST /auth/login (public): email, password. Returns access (15 min) + refresh (30 d, httpOnly cookie on web).
* POST /auth/oauth/google | /auth/oauth/apple (public): id_token in, tokens out; creates account on first login.
* POST /auth/refresh, POST /auth/logout
* POST /auth/guest (public): display_name in, short lived room scoped guest token out (requires room slug).

### 4.2 Users
* GET /users/me, PATCH /users/me (display_name, avatar_url)
* DELETE /users/me (GDPR erasure, async)

### 4.3 Rooms
* POST /rooms: title, visibility, password?, settings. Returns room + slug.
* GET /rooms/:slug (public for public rooms): metadata, participant count.
* GET /rooms?visibility=public&search=&cursor=: directory listing.
* PATCH /rooms/:id (host): title, visibility, settings.
* DELETE /rooms/:id (host): ends room.
* POST /rooms/:slug/join: password? in, returns short lived **socket token** (the credential the Sync Gateway accepts).
* POST /rooms/:id/roles (host): user_id, role.
* POST /rooms/:id/bans (host/cohost), DELETE /rooms/:id/bans/:banId.

### 4.4 Queue
* GET /rooms/:id/queue
* POST /rooms/:id/queue: source, source_ref. Server resolves metadata (YouTube Data API v3, Drive Files API, Vimeo oEmbed) and validates playability.
* PATCH /rooms/:id/queue/:itemId (reorder), DELETE same.

### 4.5 Content helpers
* GET /content/resolve?url=: classifies a pasted URL into source + source_ref + metadata.
* GET /content/gdrive/files: lists the caller's own video files via their OAuth grant (drive.readonly scope, incremental consent).

### 4.6 Socket.io namespace /room (auth: socket token)

Client to server
* playback:command { action: play|pause|seek|skip, positionMs?, itemId? } (role checked)
* chat:send { body | ciphertext }
* reaction:send { emoji }
* voice:signal { to, sdp | candidate } (WebRTC signaling relay)
* sync:report { positionMs, playerState, clientTime } (drift telemetry, every 5 s)
* control:request (participant asks for control)

Server to client
* room:snapshot (on join: full state)
* playback:state { itemId, positionMs, playing, epoch, serverTime } (authoritative)
* chat:message, reaction:broadcast
* presence:update { joined[], left[], speaking[] }
* role:update, room:ended, moderation:kicked
* sync:correct { positionMs, serverTime } (targeted nudge to a drifting client)

Rate limits: chat 5 msg/5 s, playback commands 10/10 s, signaling 50/10 s. Enforced in Redis.

## 5. Frontend Folder Structure

Monorepo with Turborepo + pnpm. React Native and Next.js share logic through packages, not UI.

repo root
* apps/
  * web/ (Next.js 14 App Router; also the source for desktop)
    * app/ (routes: (marketing), (auth), r/[slug], rooms)
    * components/ (player/, chat/, voice/, room/, ui/)
    * hooks/, lib/, styles/
  * mobile/ (React Native, Expo)
    * app/ (expo router screens mirroring web routes)
    * components/, hooks/, native/ (platform modules)
  * desktop/ (Tauri shell wrapping the web build; tray, deep link registration)
* packages/
  * core/ (framework agnostic: sync engine client, drift corrector, socket client, state machines)
  * api-client/ (typed REST client generated from OpenAPI)
  * players/ (PlayerAdapter interface + youtube, gdrive, vimeo, direct adapters; each has web and native implementations behind one interface)
  * voice/ (VoiceProvider interface + webrtc-mesh implementation; livekit implementation added later)
  * ui-tokens/ (colors, spacing, typography shared as design tokens)
  * types/ (zod schemas shared client and server)
* The single most important abstraction is packages/players/PlayerAdapter: load(ref), play(), pause(), seekTo(ms), getPositionMs(), on(event). The sync engine only ever talks to this interface, so adding a source never touches sync code.

## 6. Backend Folder Structure

Same monorepo, services under services/.

* services/
  * auth/ (NestJS)
    * src/modules/ (oauth, email-auth, tokens, guests)
  * rooms/ (NestJS)
    * src/modules/ (rooms, membership, queue, directory, moderation, content-resolver)
  * sync-gateway/ (Node + Socket.io, deliberately not NestJS to keep the hot path thin)
    * src/ (gateway.ts, roomState/, handlers/ (playback, chat, voiceSignaling, presence), redis/, authz/)
  * worker/ (BullMQ processors: emails, cleanup, reports)
* packages/ (shared with frontend where relevant: types)
* infra/ (Terraform or SST definitions, Dockerfiles, GitHub Actions)
* db/ (Prisma schema or Drizzle, migrations, seeds)

## 7. Synchronization Engine Design

This is the heart of the product. Design principles: server authoritative state, client side prediction, gentle correction.

### 7.1 Authoritative room state (Redis hash per room)
* itemId, playing (bool), anchorPositionMs, anchorServerTime, epoch (int, incremented on every host command), playbackRate

Current authoritative position at any instant = anchorPositionMs + (now minus anchorServerTime) when playing, else anchorPositionMs. Storing an anchor instead of a ticking position means no server tick loop is needed.

### 7.2 Clock synchronization
* Clients run an NTP style handshake over the socket on connect and every 30 s: send t0, server replies with t1, client receives at t2; offset estimate = t1 minus (t0+t2)/2. Keep a rolling median of 5 samples. This gives each client a serverTime estimate accurate to roughly 10 to 50 ms.

### 7.3 Command flow
1. Host presses seek. Client applies it locally instantly (prediction) and emits playback:command.
2. Gateway validates role and rate limit, bumps epoch, writes new anchor to Redis, broadcasts playback:state with epoch and serverTime.
3. Every client computes target position using its clock offset and compares to its player position.

### 7.4 Drift correction ladder (per client, evaluated every second)
* Drift under 100 ms: do nothing.
* 100 to 500 ms: adjust playbackRate to 1.02 or 0.98 until converged (imperceptible; YouTube IFrame API supports setPlaybackRate, HTML5 video supports it natively).
* Over 500 ms or rate adjust unsupported on that player: hard seek to target plus a small lead compensating for seek latency (measured per adapter).
* Epoch guard: any locally applied command carries the epoch it was based on; stale epochs are discarded, which resolves races between simultaneous host actions.

### 7.5 Buffering and late join
* When any client buffers, it reports playerState=buffering. Room setting decides policy: "wait for all" (host client auto pauses via a system command) or "leave them behind" (default for large public rooms).
* Late join: snapshot carries the anchor; client seeks before first play, targets position plus measured join latency, typically landing within one correction cycle.

### 7.6 Source specific notes
* YouTube: positions only reliable to about 100 ms granularity; correction thresholds widened to 150 ms/600 ms for this adapter.
* Google Drive HTML5: standard video element, best sync fidelity of all sources.
* Ads (YouTube): ad playback is per viewer and unskippable by the app (and must not be tampered with). During an ad the client reports state=ad; the room policy pauses others or lets them run, and the client rejoins sync when the ad ends. This is an unavoidable UX seam of legal YouTube playback; surface it honestly in UI.

### 7.7 Voice (mesh) specifics
* Signaling multiplexed on the room socket. Full mesh audio only, Opus, 32 kbps per stream. 8 speakers = 7 uplinks per speaker, about 224 kbps up, fine on modern connections. Listeners publish nothing.
* TURN: none at MVP (cost zero). Roughly 8 to 15 percent of peers behind symmetric NATs will fail to connect voice; they fall back to text chat with a clear message. Document this as a known limitation; a coturn server on a small VM (about 5 USD/month) removes it when budget allows.

## 8. OTT Integration Strategy and Legal Considerations

### 8.1 The honest constraint
Netflix, Disney+, Prime Video, Hulu, Max and peers offer **no public playback API, no embeddable player, and no watch party SDK**. Their content is DRM protected (Widevine/FairPlay) and their Terms of Service prohibit third party playback control and stream manipulation. Rave's OTT support relies on techniques that would not survive this project's stated legal constraints, and companies in this space have received cease and desist actions historically.

Therefore: **no OTT catalog playback ships in this product without a signed partnership.** Anything else is legal exposure, not a feature.

### 8.2 What ships instead (tiered)
* Tier 1 (MVP): YouTube (IFrame API per YouTube API ToS: no ad blocking, no background play, no download, attribution preserved), Google Drive (user's own files via their own OAuth grant; the platform never stores, proxies, or transcodes content bytes, keeping it a player of user authorized content, not a distributor).
* Tier 2: Vimeo Player SDK, direct URLs (HLS/MP4). For direct URLs, DMCA safe harbor posture: designated agent registered, repeat infringer policy, takedown workflow, and public rooms with direct URLs are reportable.
* Tier 3 (business track, post traction): approach OTT partnership programs. Precedents worth citing in outreach: Disney+ GroupWatch and Prime Video Watch Party existed as first party features, and Teleparty operates in a tolerated extension niche. The realistic pitch is a co branded second screen social layer where playback stays entirely inside the partner's own app and this platform syncs via deep links and timeline metadata only. This requires BD effort, an NDA, and probably scale metrics; budget zero engineering for it before then.

### 8.3 A legally clean "watch together anyway" bridge feature
* **Sync by signal**: for content the app cannot play, rooms can run a shared countdown ("everyone press play in 3, 2, 1") plus a synchronized session clock and chat/voice alongside. No integration with the OTT app at all; every user plays content in their own authenticated app on their own device. This is what physically distributed friends already do manually; productizing it is legally inert and surprisingly sticky. Ship it in Tier 2.

### 8.4 Google Drive specific legal note
Drive playback must be restricted to files the authenticated user owns or has been granted access to by Google's own ACLs. The app must not enable access expansion (no re sharing of stream URLs to room members who lack Drive permission). Implementation consequence: each participant fetches their own playback URL with their own token; users lacking permission see a "request access from host" state. This is the single most important compliance detail in the whole product; it is the difference between a video player and a piracy tool.

## 9. Security Architecture

**Identity and sessions**
* Argon2id password hashing, OAuth id_token verification server side (issuer, audience, nonce), 15 min access JWTs (RS256, rotated keys), refresh tokens hashed at rest with device binding and revocation.
* Guest tokens: room scoped, 12 h max, cannot be elevated.

**Transport and platform**
* TLS 1.3 everywhere, HSTS, strict CSP on web, certificate pinning in mobile apps.
* Socket tokens are single purpose, 60 s validity, exchanged for the socket session; the JWT never rides the WebSocket query string.

**Room security**
* Private rooms: unguessable slugs plus optional password (argon2id). Signed invite links with optional expiry.
* Role checks enforced server side in the gateway on every command (never trust client role state).
* Kick/ban enforced at socket auth and at REST join.

**End to end encryption, honestly scoped**
* E2EE applies to **private room text chat**: MLS or libsignal based group encryption, keys exchanged among members, server stores ciphertext only. Feasible and shippable post MVP.
* E2EE does **not** apply to playback sync state, because the server must read it to arbitrate authority and correct drift, nor to YouTube/Vimeo content (delivered by those platforms under their own encryption).
* Voice in mesh mode is genuinely peer to peer and DTLS SRTP encrypted end to end by construction, a nice honest marketing point.
* This scoping is stated in the privacy policy in plain language. Overclaiming E2EE is a regulatory and reputational risk.

**Abuse and safety**
* Rate limiting (Redis token buckets) on auth, chat, commands, signaling.
* Public room chat passes a moderation filter (open source profanity list MVP, Perspective API later). Report flows on rooms, messages, users. Shadow ban capability.
* IP hash bans for guest abuse.

**Data protection**
* GDPR: export and erasure endpoints, chat purged 24 h after room end, playback events pseudonymized after 90 days.
* Secrets in AWS Secrets Manager or Doppler; no secrets in the monorepo.
* Dependency scanning (Renovate + npm audit in CI), SAST (Semgrep), one external pentest before GA.

## 10. MVP Roadmap

**MVP (v0.1, must ship)**
* Auth: Google, Apple, email, guest links.
* Rooms: create, private/public, invite slugs, roles (host/cohost), kick/ban.
* Sources: YouTube + Google Drive.
* Sync engine with drift correction ladder.
* Text chat + emoji reactions + participant list.
* Web app + Android + iOS (desktop via web in browser initially).
* Basic public directory.

**v0.2**
* Voice chat (WebRTC mesh, 8 speakers).
* Vimeo + direct URL sources. Sync by signal bridge feature.
* Desktop Tauri builds. Queue voting, vote skip.

**v0.3**
* E2EE private chat. Volume sync. Scheduled watch parties with calendar invites.
* Moderation upgrades, trust and safety tooling, TURN server.

**Later**
* LiveKit voice migration, watch history, friends/follows, OTT partnership pilots.

**Explicitly cut from MVP**: camera video, screen share, recommendations, monetization, localization beyond English.

## 11. Source Code Implementation Plan

Order of construction, each step producing something testable. (Per your working preferences this is the plan; code gets written per module when you ask for it, and I will request your reference files before writing any.)

1. **Foundations (repo + infra)**: Turborepo, pnpm workspaces, TypeScript strict, shared zod types package, CI (lint, typecheck, test), dev docker compose (Postgres, Redis).
2. **Auth service**: email flow, Google/Apple verification, JWT + refresh rotation, guest tokens. Contract tests against the OpenAPI spec.
3. **Room service**: rooms, membership, roles, invites, bans, queue CRUD, content resolver (YouTube Data API, Drive metadata). Directory listing.
4. **Sync gateway core**: socket auth handshake, room channels via Redis adapter, room snapshot, presence with TTL heartbeats.
5. **Sync engine server side**: authoritative anchor state, epochs, command validation, broadcast, drift telemetry ingestion.
6. **packages/core client sync**: clock sync module, prediction, correction ladder, exhaustive unit tests with a simulated player (this module gets the highest test coverage in the codebase).
7. **PlayerAdapter + YouTube adapter (web)**, then Drive adapter. Web room screen wiring player + sync + chat.
8. **Web app UI**: room screen, create/join flows, directory, auth screens. Dark theme tokens.
9. **Mobile**: RN shells, YouTube and Drive adapters for native, room screen parity.
10. **Chat + reactions** end to end, moderation basics.
11. **Hardening**: rate limits, load test sync gateway (k6, target 5k sockets/instance), Sentry, dashboards.
12. **v0.2 modules**: voice mesh (signaling handlers + VoiceProvider), Vimeo/direct adapters, Tauri desktop, sync by signal.

Testing strategy: unit tests on sync math and reducers; integration tests with two headless clients against a real gateway asserting drift bounds; Playwright happy paths; Detox smoke on mobile.

## 12. Development Timeline and Milestones

Assumption: 3 to 4 engineers (1 backend, 1 web, 1 mobile, 1 full stack/floating) plus a designer at half time. Solo development roughly triples these numbers.

**Weeks 1 to 2: M0 Foundations**
Repo, CI, infra as code, auth service functional. Milestone: login with all three providers in a test web page.

**Weeks 3 to 5: M1 Rooms and realtime skeleton**
Room service, sync gateway with presence and chat. Milestone: two browsers exchange chat in a room created via invite link.

**Weeks 6 to 8: M2 Sync engine + YouTube**
Server authority, client correction, YouTube adapter. Milestone: 5 clients hold under 250 ms drift through play/pause/seek storms; automated drift test in CI.

**Weeks 9 to 10: M3 Google Drive + web UI polish**
Drive OAuth and adapter, full dark theme room experience, directory. Milestone: mixed source queue plays through a session end to end on web.

**Weeks 11 to 14: M4 Mobile**
RN apps with parity on rooms, chat, both sources. Milestone: TestFlight and Play internal builds; cross platform room (web + iOS + Android) stays in sync.

**Weeks 15 to 16: M5 Hardening + closed beta**
Load tests, rate limits, moderation basics, observability, pentest fixes. Milestone: 200 user closed beta, sync complaint rate under 5 percent.

**Weeks 17 to 20: M6 v0.2**
Voice mesh, Vimeo/direct URLs, Tauri desktop, sync by signal. Milestone: public beta launch.

Buffer: weeks 21 to 22 reserved. App Store review realities: Apple will require Sign in with Apple (already planned) and will scrutinize user generated content moderation (report/block flows are therefore MVP, not later).

Total: about 5 months to public beta with a small team.

## Key risks register (read this before anything else)
1. **OTT expectation gap**: users comparing to Rave will ask for Netflix. Mitigate with sync by signal and honest positioning ("legal watch parties").
2. **YouTube ToS drift**: policies change; keep the adapter isolated and monitor API terms quarterly.
3. **Drive permission misuse attempts**: the per participant token rule in Section 8.4 is non negotiable and should be covered by tests.
4. **Voice mesh NAT failures**: known 8 to 15 percent failure rate without TURN; measure it in beta and budget the 5 USD/month coturn box early if it bites.
5. **Sync engine underestimation**: it looks simple and is not; that is why it gets weeks 6 to 8 dedicated and the highest test coverage.
