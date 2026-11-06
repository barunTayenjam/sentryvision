# Documentation Index

**SentryVision v1.7.0** · Last updated 2026-09-24

## Core Docs

| Doc | Purpose | Audience |
|-----|---------|----------|
| [`README.md`](../README.md) | Overview, quick start, architecture | Everyone |
| [`PRODUCT.md`](./PRODUCT.md) | Product vision, users, capabilities | Product / contributors |
| [`AGENTS.md`](../AGENTS.md) | AI agent instructions + codebase reference | AI agents |
| [`API-SOURCE-OF-TRUTH.md`](./API-SOURCE-OF-TRUTH.md) | Complete API endpoint inventory | Developers |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev workflow, conventions, PR process | Contributors |
| [`ENVIRONMENT.md`](./ENVIRONMENT.md) | All environment variables | Operators |
| [`DATABASE.md`](./DATABASE.md) | Schema, migrations, queries | Developers |
| [`BACKEND.md`](./BACKEND.md) | Express API, routes, services, Socket.io | Backend devs |
| [`FRONTEND.md`](./FRONTEND.md) | React app, pages, services, routing | Frontend devs |
| [`OPENCV-SERVICE.md`](./OPENCV-SERVICE.md) | Python detection pipeline | CV / backend devs |
| [`SECURITY.md`](./SECURITY.md) | Auth, rate limiting, headers, risks | Security reviewers |
| [`RELEASE_NOTES.md`](./RELEASE_NOTES.md) | Release history (v1.6.0, v1.7.0) | Everyone |
| [`REVIEW-2026-11-06-cheap-stream-profile.md`](./REVIEW-2026-11-06-cheap-stream-profile.md) | Review brief: streaming bandwidth change (scope, invariants, evidence) | Reviewers |
| [`REVIEW-2026-11-06-full-repo.md`](./REVIEW-2026-11-06-full-repo.md) | Review brief: whole repo (areas by risk, invariants, verification) | Reviewers |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Full system architecture with C4 diagrams | Architects / senior devs |

## Architecture Decision Records (ADRs)

| ADR | Decision | Status |
|-----|----------|--------|
| [`ADR-001-state-management.md`](./ADR-001-state-management.md) | Zustand over React Contexts for frontend client state | Proposed |
| [`ADR-002-service-decomposition.md`](./ADR-002-service-decomposition.md) | Decomposing oversized frontend API services | Proposed |
| [`ADR-003-route-consistency.md`](./ADR-003-route-consistency.md) | Enforcing strict MVC pattern across all backend routes | Proposed |

## Reference

| Doc | Purpose |
|-----|---------|
| [`DESIGN.md`](./DESIGN.md) | Visual system spec — design tokens, motion rules |

## Quick Links

**New developer?** Read in order:
1. `README.md` → `PRODUCT.md` → `CONTRIBUTING.md`
2. `BACKEND.md` or `FRONTEND.md` (depending on your focus)
3. `API-SOURCE-OF-TRUTH.md` (for endpoint reference)
4. `ENVIRONMENT.md` + `DATABASE.md` (for local setup)

**Deploying?** Read:
1. `ENVIRONMENT.md` (all required secrets)
2. `DATABASE.md` (migrations + backup)

**Redesigning frontend?** Read:
1. `FRONTEND.md` (pages + services map)
2. `API-SOURCE-OF-TRUTH.md` (endpoint inventory + stale call audit)
3. `DESIGN.md` (visual system spec — tokens, motion rules)
