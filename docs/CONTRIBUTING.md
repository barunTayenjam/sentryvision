# Contributing to SentryVision

## Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Python 3.10+ (for OpenCV service)
- Docker + Docker Compose (for full stack)
- FFmpeg (for RTSP processing)

## Quick Start

```bash
git clone https://github.com/barunTayenjam/sentryvision.git
cd sentryvision
cp .env.example .env        # Edit with your secrets
npm install
npm run dev:full             # Starts frontend + backend
```

Default login: `admin` / `admin123` (change on first login).

## Project Structure

| Directory | Purpose | Language |
|-----------|---------|----------|
| `frontend-next/` | Next.js 14 UI (App Router + TailwindCSS + shadcn/ui) | TypeScript |
| `server/` | Express 5 API + Socket.io + persistence pipeline | TypeScript |
| `opencv-service/` | Python Flask service (YOLOv8n + InsightFace + ByteTrack) | Python |
| `database/` | PostgreSQL migrations (TypeORM) | SQL |
| `docs/` | Project documentation | Markdown |
| `scripts/` | Install, deploy, diagnostics, maintenance | Bash |

## Development Workflow

### Frontend

```bash
cd frontend-next
npm install
npm run dev          # Next dev server on :5173 (proxies /api to :9753)
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run test         # Vitest
```

**Always run `npm run lint && npm run typecheck` after changes.**

### Backend

```bash
cd server
npm install
npm run dev          # Nodemon hot reload on :9753
npm run build        # Compile TS → dist/
npm run lint:server  # ESLint
```

### OpenCV Service

```bash
cd opencv-service
pip install -r requirements.txt
python3 -m flask --app app run --host 0.0.0.0 --port 8084
```

Or restart in Docker: `docker restart sentryvision-opencv`

## Code Conventions

- **TypeScript** with strict types on backend, permissive on frontend
- **File naming**: PascalCase components (`CameraGrid.tsx`), camelCase utils (`eventService.ts`)
- **Imports**: external → internal → types
- **Components**: shadcn/ui patterns, Radix primitives
- **Backend routes**: MVC — Controller handles logic, Route file wires Express
- **Validation**: Zod schemas in `middleware/zodValidation.ts`
- **API calls**: Always use `services/api/baseClient.ts` (handles auth, retry, refresh)
- **No comments** in code unless asked
- **Tailwind only** — no inline styles, no CSS modules

## Backend Route Pattern

```typescript
// routes/example.ts
import { Router } from 'express';
import { requireUser } from '../middleware/auth.js';
import { exampleController } from '../controllers/ExampleController.js';

const router = Router();
router.get('/', requireUser, (req, res) => exampleController.list(req, res));
router.post('/', requireUser, (req, res) => exampleController.create(req, res));
export default router;
```

## Frontend API Service Pattern

```typescript
// services/api/exampleService.ts
import { apiGet, apiPost } from './baseClient';

export const exampleService = {
  async getItems(): Promise<Item[]> {
    const response = await apiGet<{ success: boolean; items: Item[] }>('/example');
    if (!response.success) throw new Error('Failed');
    return response.items;
  },
};
```

## Testing

```bash
# Frontend (Vitest, tests colocated as src/**/*.test.ts)
cd frontend-next && npm test

# Backend (Jest, tests in server/src/**/*.test.ts)
cd server && npm run test:server

# Python detection pipeline (needs the opencv image for cv2)
docker run --rm -v $(pwd)/opencv-service:/app:ro -w /app sentryvision-opencv:latest \
  sh -c "pip install -q pytest pytest-asyncio && python -m pytest tests -q"
```

## Commit Messages

Use conventional commits:
- `feat: add face cluster naming`
- `fix: resolve stream reconnection loop`
- `chore: bump version to 1.7.0`
- `docs: update API reference`

## Pull Requests

1. Branch from `main`
2. Run `npm run lint && npm run typecheck` before committing
3. Include test coverage for new features
4. Update relevant docs if adding/changing endpoints
5. PR description should explain *why*, not *what*

## Architecture Rules

1. **Detection runs in Python only.** Node.js receives structured events via WebSocket. Never add OpenCV/cv2 imports to the TypeScript backend.
2. **Frontend served by backend.** One container serves both static files and API. Do not add a separate frontend service.
3. **No Redis by default.** Use in-memory cache. Redis is optional (`REDIS_DISABLED=false`).
4. **Camera RTSP via go2rtc.** Cameras allow only 1 concurrent RTSP connection. Never connect Python/FFmpeg directly to cameras.
5. **Data sovereignty.** No external telemetry, no analytics, no cloud calls. Every feature must work offline.
