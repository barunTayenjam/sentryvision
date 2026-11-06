# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tech-savvy hobbyists who run self-hosted home automation stacks (Home Assistant, Frigate, Docker). They value data sovereignty, local-first architecture, and systems they can inspect, modify, and own. They are comfortable with CLI, Docker Compose, and RTSP camera configuration.

## Product Purpose

SentryVision is a self-hosted, AI-powered home security camera system. It provides real-time person/vehicle/animal detection, face recognition, event timelines, AI scene analysis, and live streaming — all running on user-owned hardware with zero cloud dependency.

Success means: the user trusts SentryVision as their primary security system, checks it daily, and recommends it to others in the self-hosted community.

## Positioning

100% self-hosted and private. No cloud, no subscription, no data leaves the user's network. SentryVision runs on minimal hardware (2GB RAM, 2-core) with a one-click install — solving the same problem as Ring/Nest/Arlo but with full data sovereignty.

## Operating Context

- Deployed via Docker Compose on a home server, NAS, or Raspberry Pi
- Connected to RTSP cameras (TP-LINK, Reolink, etc.) via go2rtc proxy
- Accessed via browser on desktop and mobile (LAN or VPN/Tailscale)
- Monitored via live event feed, push notifications, and optional email alerts
- Managed through a web UI for camera settings, detection tuning, and retention policies
- Part of a larger self-hosted stack (often alongside Home Assistant, Frigate, Plex)

## Capabilities and Constraints

**Core capabilities:**
- Live camera streaming (WebRTC/MSE/HLS via go2rtc; default 640×360@10fps@250 kbps per viewer, 60 s HD burst on demand)
- AI object detection (YOLOv8n): person, car, dog, cat
- Human verification pipeline (YOLO high confidence → face → MediaPipe pose → score floor)
- Face recognition and visitor timeline (InsightFace ArcFace)
- Event timeline with smart filters and AI scene analysis (NVIDIA integration)
- Daily analytics dashboard with 25+ dimensions (InsightsPage)
- AI chat interface for querying detection data (AskPage)
- System logs viewer with real-time filtering (LogsPage)
- Timelapse generation and backfill from detection snapshots
- Multi-user auth with MFA (TOTP)
- Real-time WebSocket updates

**Technical constraints:**
- PostgreSQL 15+ required
- Python OpenCV service for detection pipeline
- RTSP cameras only (no ONVIF discovery)
- Self-signed HTTPS or LAN-only access (no built-in reverse proxy)
- Browser-based — no native mobile app

**Undecided:**
- Whether to add ONVIF camera discovery
- Whether to support WebRTC camera passthrough directly (bypassing go2rtc)

## Brand Commitments

- Name: SentryVision
- Visual identity: open to full redesign (fresh start)
- Voice: technical, confident, no-nonsense — speaks to hobbyists, not consumers

## Evidence on Hand

- Running v1.7.0 production system with 60K+ detection events
- 26 database migrations, full detection pipeline operational
- Live camera streaming working across desktop and mobile browsers
- Face recognition and visitor tracking functional
- Daily analytics dashboard with 25+ dimensions (InsightsPage)
- AI chat interface querying detection data (AskPage)
- System logs viewer with real-time filtering (LogsPage)
- Timelapse generation and backfill from detection snapshots

## Product Principles

1. **Data sovereignty first.** Every feature must work without any external service. No telemetry, no analytics, no cloud calls.
2. **Runs on anything.** Design for constrained hardware. Every UI decision should consider low-bandwidth and high-latency scenarios.
3. **Verify before alert.** The human verification pipeline reduces false positives — trust is built by not crying wolf.
4. **Inspectable by default.** Users should be able to see exactly what the system detected, why it was classified, and what happened to the data.
5. **Community-driven.** The product succeeds through the self-hosted community, not marketing spend.

## Accessibility & Inclusion

- Dark theme as default (security dashboard convention)
- High contrast text on dark backgrounds
- Keyboard navigation for core flows
- Screen reader support via semantic HTML and ARIA labels
- Responsive design for mobile access (LAN viewing)
