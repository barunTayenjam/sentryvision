# Review brief — Cheap Stream Profile (v1.7.2)

One complete brief for reviewing this change. Everything a reviewer needs is
here or referenced by path. No session history required.

## Scope under review

```bash
git diff ef442b0..bc158cf          # full change, 18 files, +354/−171
git log --oneline ef442b0..bc158cf --no-merges   # 10 commits
```

**Out of scope** (unrelated owner WIP, uncommitted, do not review):
`docker-compose.yml`, `opencv-service/arcface_recognizer.py`,
`opencv-service/cluster_and_populate.py`,
`opencv-service/rtsp_ingestion/frame_pipeline.py`,
`database/migrations/046_create_face_clusters.sql`,
`opencv-service/tests/test_arcface_cosine.py`.

## What this change does

Cuts live-view bandwidth ~6–8× per viewer, on LAN and internet. Before: every
tile pulled a 1500 kbps 720p transcode; a focused tile pulled the camera's
native 1440p main stream (~4 Mbps); a hidden tab streamed forever; and the
server relayed JPEG frames over Socket.io (~4.5 Mbps per camera) to clients
that never drew them. After: every viewer pulls a dedicated 640×360 @ 10 fps
@ 250 kbps transcode; full quality is a manual 60 s burst; hidden tabs stop
after 30 s; the JPEG relay is opt-out and off for video-decoding clients.

Design doc: `docs/superpowers/specs/2026-11-06-cheap-stream-profile-design.md`.
Plan: `docs/superpowers/plans/2026-11-06-cheap-stream-profile.md`.

## Stream topology (go2rtc.yaml)

go2rtc holds the **only** RTSP connection per camera. Everything downstream
fans out from its loopback RTSP server (`127.0.0.1:8554`) — no change here,
this predates the branch.

| Stream | Source | Purpose | Lifecycle |
|---|---|---|---|
| `cam1` / `cam2` | camera main (1440p) | feed for transcoders only | go2rtc-internal |
| `cam1_low` / `cam2_low` | ffmpeg `h264_low` (720p, 10 fps, 1500k) | OpenCV detection pipeline | 24/7, unchanged |
| `cam1_sub` / `cam2_sub` | relay of `*_low` | HD 60s burst target | on demand |
| `cam1_cheap` / `cam2_cheap` | ffmpeg `h264_cheap` (640×360, 10 fps, 250k, `-g 20`, CBR-ish `maxrate=bufsize=2×`) | **every browser viewer, default** | spawns per viewer, despawns idle |

Verified on live system: single ESTABLISHED connection to each camera
(`192.168.31.61:554`, `192.168.31.62:554`), both from go2rtc PID 7.

## File manifest

| File | Change |
|---|---|
| `go2rtc.yaml` | +`h264_cheap` ffmpeg template, +`cam{1,2}_cheap` streams |
| `frontend-next/src/lib/streamSrc.ts` | rewritten: `streamSrcForTile(id)` → `${id}_cheap`; `streamSrcForHq(id)` → `${id}_sub`. `focused` parameter dropped |
| `frontend-next/src/lib/streamSrc.test.ts` | new, 4 tests |
| `frontend-next/src/hooks/useCameraStream.ts` | HQ burst state (`hqActive`/`activateHq` + tier-change effect); hidden-tab teardown (`HIDDEN_GRACE_MS = 30000`); JPEG-canvas path deleted (`setupWanStream`, `startFrameRender`, `stopFrameRender`, 5 refs); remote viewer goes straight to MSE; HLS failure retries MSE once, then errors |
| `frontend-next/src/components/live/AdaptiveCameraGrid.tsx` | tile always uses `streamSrcForTile(camera.id)`; focused tile renders "HD 60s" button (`aria-pressed`, `stopPropagation`) |
| `frontend-next/src/services/SocketService.ts` | `requestStream(id, role, { frames? })`; `requestedStreams` Set→Map of full payloads; new exported `streamRequestPayload()`; reconnect replay emits stored payload (flag survives) |
| `frontend-next/src/services/SocketService.test.ts` | new, 2 tests |
| `frontend-next/src/stores/camera.ts` | live tiles call `requestStream(id, 'live', { frames: false })` |
| `server/src/streams/rtspManager.ts` | `requestStream` accepts `frames?: boolean` (default `true`); exported `frameRoomFor(cameraId, frames)` returns `null` when `frames === false` — socket skips the JPEG room; viewer tracking, health monitor, python subscription untouched |
| `server/src/streams/rtspManager.test.ts` | +2 tests for `frameRoomFor` |
| `frontend-next/src/app/faces/page.tsx` | removed unused `type SortOption` — this lint error had failed every `next build` since `ef442b0`; deployed bundle was stale since Nov 3 |
| `README.md`, `AGENTS.md`, `docs/{ARCHITECTURE,BACKEND,FRONTEND,PRODUCT,RELEASE_NOTES}.md` | doc updates |

## Server contract change

```ts
// client → server
socket.emit('requestStream', { cameraId, role, frames? })  // frames default true
// frames:false → socket joins viewer tracking + python subscription but NOT
// the `camera-<id>-live` JPEG room. Back-compat: old clients omitting the
// flag keep getting frames.
```

## Invariants — verify each deliberately

1. **No path reaches the native 1440p main stream.** Check every `src`
   resolution: `streamSrcForTile`, `streamSrcForHq`, and the residual
   `streamSrc ?? camera.id` fallback in `useCameraStream.ts` (callers always
   pass a streamSrc today — is that guaranteed?).
2. **Detection pipeline untouched**: `h264_low` params (720p/10 fps/1500k)
   unchanged; OpenCV still consumes `cam{1,2}_low`. Verified live: YOLO fired,
   7 events in DB in 15 min post-deploy.
3. **Hidden tab stops within ~30 s** under *any* state churn: the teardown
   timer must survive effect re-runs (re-armed in the effect body), and start
   paths (`maybeStart`, `handleStreamStart`, tier-change effect) must refuse
   while `document.hidden`. Look for remaining paths that set `isStreaming`
   true or call start while hidden.
4. **`frames:false` survives reconnect**: replay path in `SocketService.ts`
   must emit the stored payload, not a reconstructed `{cameraId, role}`.
5. **No silent fallback to a costlier transport**: MSE failure → one MSE
   retry → error state. The `isWanRef.current = true` assignment in the
   all-transports-failed branch is now vestigial — check it can't route back
   into a canvas path (there is none).
6. **No orphaned ffmpeg consumers**: rapid tab switching / focus toggling —
   each restart does stop→start(1 s); cheap transcoder spawns per consumer.
   Look for sequences that start twice without a stop (rate limiter:
   `RESTART_COOLDOWN_MS = 5000`, `CONNECTION_RATE_LIMIT_MS = 3000`, max 10
   attempts/min).
7. **Visibility resume can't leave a black tile**: if the restart was
   suppressed by cooldown, one retry fires at `RESTART_COOLDOWN_MS + 2000`,
   gated on `streamActionRef.current !== 'start'`. Check the gate logic —
   `streamActionRef` stays `'start'` after success, is `null`/`'stop'` when a
   start never ran.

## Measured evidence (live system, post-deploy)

| Metric | Before | After | How |
|---|---|---|---|
| `cam1_cheap` bitrate | — | 267 kbps (640×360@10) | `ffmpeg -c copy` 20 s sample |
| Per-tile to tablet | 1500 kbps (tile) / ~4000 (focused) | **254–257 kbps** | go2rtc `/api/streams` `bytes_send` delta, 20 s |
| App container TX | 3861 kbps | **8–12 kbps** | `eth0/tx_bytes` delta (JPEG relay off) |
| Hidden tab | streamed forever | consumers vanish | `/api/streams` consumer list |

go2rtc container's ~4.3 Mbps eth0 TX is docker-bridge traffic to OpenCV
(`cam{1,2}_low` × 1500k) — never leaves the host NIC. WebRTC cannot cross
cloudflared (UDP); remote viewers use MSE (`/go2rtc/api/ws`), ~1 s latency.

## Already reviewed and fixed (don't re-derive, do verify)

A whole-branch review found and this branch fixed: hidden-tab teardown undone
by auto-start ~1.5 s later; teardown timer disarmed by effect re-runs;
`frames` flag dropped on reconnect replay; tier-change restarting while
hidden; visibility resume silenced by rate limit (commit `9a1ed5d`).

## Known deferred (accepted, don't block on)

- Stale error copy still mentions "browser canvas" in one message.
- `isWanStream` state is dead but still returned by the hook.
- `streamSrc ?? camera.id` latent 1440p path (see invariant 1).
- `activateHq` can't extend an active burst (no-op while `hqActive`).
- No graceful fallback when a camera lacks a `_cheap` stream.
- Hidden-tab and HD-burst behaviour verified by measurement and code reading,
  never exercised in a logged-in browser by a human.

## How to verify locally

```bash
cd frontend-next && npx vitest run && npm run typecheck && npm run lint   # 33/33, clean, 0 errors
cd server && node --experimental-vm-modules node_modules/.bin/jest        # 515/515 — plain npx jest fails on ESM
npm run build && npm run build:server && docker restart sentryvision-app  # deploy
curl -s http://127.0.0.1:1984/api/streams | python3 -m json.tool          # consumers, bytes_send
```
