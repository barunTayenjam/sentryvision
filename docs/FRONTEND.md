# Frontend

Next.js 15 (App Router) + TypeScript + TailwindCSS + shadcn/ui + Zustand. Served by backend as static files.

## Quick Start

```bash
cd frontend-next
npm install
npm run dev          # Next dev server on :5173
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

**Always run `npm run lint && npm run typecheck` after changes.**

## Build

```bash
npm run build        # Next static export → out/
```

Output goes to `frontend-next/out/`, which backend serves via `FRONTEND_DIST_PATH` (see `server/src/config/frontendDist.ts`).

## Routing

Next.js App Router under `src/app/`:

```
/login              → app/login/ (LoginPage — auth + MFA)
/app/               → app/(app)/ (protected shell)
/app/streams        → StreamDashboard.tsx (default)
/app/events         → EventsPage.tsx
/app/people         → PeoplePage.tsx
/app/insights       → InsightsPage.tsx
/app/timelapse      → TimelapsePage.tsx
/app/ask            → AskPage.tsx
/app/logs           → LogsPage.tsx
/app/settings       → SettingsHub.tsx / Settings.tsx
*                   → not-found.tsx
```

Route-level views live in `src/views/`; `(app)` layout group wraps protected pages.

## State

| Store | File | State |
|-------|------|-------|
| auth | `stores/auth.ts` | User, token, login/logout, MFA |
| camera | `stores/camera.ts` | Camera list, stream management |
| socket | `stores/socket.ts` | Socket.io connection |
| ui | `stores/ui.ts` | UI state |

Zustand replaced React Contexts — see ADR-001.

## Pages

| View | Route | Purpose | Key Services |
|------|-------|---------|--------------|
| `StreamDashboard` | `/app/streams` | Live camera grid | `cameraService`, `SocketService` |
| `EventsPage` | `/app/events` | Event timeline + filters | `eventService`, `detectionService` |
| `PeoplePage` | `/app/people` | Face clusters + known faces | `personService`, `detectionService` |
| `InsightsPage` | `/app/insights` | Daily analytics dashboard | `insightsService`, `systemService` |
| `TimelapsePage` | `/app/timelapse` | Timelapse viewer + generator | `systemService` |
| `AskPage` | `/app/ask` | AI chat interface | `chatService` |
| `LogsPage` | `/app/logs` | System logs + alerts | `settingsService` |
| `Settings` / `SettingsHub` | `/app/settings` | System settings | `settingsService`, `detectionService`, `notificationService` |
| `LoginPage` | `/login` | Auth + MFA | `authService` |

## API Services

All in `src/services/api/`. Use `baseClient.ts` helpers (`apiGet`, `apiPost`, `apiPut`, `apiDelete`) for HTTP calls.

| Service | Purpose |
|---------|---------|
| `baseClient.ts` | `fetchWithRetry` with JWT, auto-refresh on 401, 120s timeout |
| `authService.ts` | Login, register, MFA, JWT management |
| `cameraService.ts` | Camera CRUD, streams, zones, filters, snapshots |
| `eventService.ts` | Event listing, calendar stats, archive |
| `detectionService.ts` | Detection triggers, settings, AI analysis, motion settings, detection redo |
| `personService.ts` | Face clusters list/name |
| `chatService.ts` | AI chat with tool calling, history |
| `insightsService.ts` | Daily insights (25+ analytics dimensions) |
| `systemService.ts` | Health, stats, overview, highlights, timelapse |
| `settingsService.ts` | System settings, detection config, logs, alerts |
| `notificationService.ts` | Push notifications, preferences, VAPID |

## Real-time

`SocketService.ts` (singleton) connects to backend via Socket.io.

Events listened: `streamFrame`, `cameraStatus`, `eventCreated`, `personDetected`, `faceDetected`, `enhancedMotionDetected`

Events emitted: `requestStream` (live tiles send `frames: false` — they decode video via WebRTC/MSE/HLS and would never draw the relayed JPEGs), `stopStream`

`useCameraStream` defaults every tile to the `<id>_cheap` go2rtc profile (640×360 @ 10 fps @ 250 kbps); focused tiles expose an "HD 60s" burst (`activateHq`, 720p `_sub`). A tab hidden for 30 s tears its streams down and resumes on return. The old JPEG-canvas fallback is gone — MSE failure surfaces an error instead of silently switching to a costlier transport.

## UI Stack

- **Radix UI (shadcn/ui)**: Dialog, Dropdown, Select, Toast, Tooltip, etc.
- **TailwindCSS**: All styling. No CSS modules, no inline styles.
- **Recharts**: Charts in analytics/insights pages.
- **Next.js App Router**: File-based routing, layouts, error/loading boundaries.
- **Zustand**: Client state (ADR-001).

## Key Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useCameraStream` | `hooks/useCameraStream.ts` | Camera stream lifecycle management |
| `useViewportStream` | `hooks/useViewportStream.ts` | Viewport-based stream optimization |
| `useCameras` / `useEvents` / `useInsights` | `hooks/` | Data-fetching hooks per domain |
| `use-toast` | `hooks/use-toast.ts` | Toast notification hook |

## Key Files

| File | Purpose |
|------|---------|
| `src/app/layout.tsx` | Root layout + providers |
| `src/app/(app)/` | Protected app shell |
| `src/services/api/baseClient.ts` | HTTP client with auth, retry, refresh |
| `src/services/SocketService.ts` | Socket.io singleton client |
| `src/stores/auth.ts` | Auth state (Zustand) |
| `src/types/` | Shared TypeScript interfaces |

## Deployment

Frontend is compiled to static files and served by the backend:

```bash
npm run build        # → frontend-next/out/
cd server && npm run build && npm start
# Backend serves frontend-next/out/ as static files (FRONTEND_DIST_PATH)
```

No separate frontend container in production.
