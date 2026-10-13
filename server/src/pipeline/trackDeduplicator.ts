import type { TrackingEvent } from '../services/pythonWsClient.js';
import { VEHICLE_CLASSES } from '../shared/constants.js';

/** Spatial shift below which two sightings are considered the same object. */
const DEFAULT_SHIFT_PX = 80;
/** How long that spatial match stays authoritative. */
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Persons get a much tighter window. A person does not teleport, so a box that
 * has not shifted by more than a few pixels in ten minutes is either someone
 * standing still or a scene fixture — one event either way, not a new row every
 * few minutes. At the default 80px this would suppress 99 events to catch 28
 * false positives (71 real detections lost), because people legitimately
 * occupy the same doorway repeatedly. Measured consecutive bbox shifts:
 * fixture p50=2.4px, real people p50=127.5px.
 */
const PERSON_SHIFT_PX = 18;
// 3min, not 10: a person returning to the same spot within 10min (courier,
// resident) was silently swallowed. 3min still collapses a single visit.
const PERSON_WINDOW_MS = 3 * 60 * 1000;

function envNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bboxOf(ev: TrackingEvent): { x: number; y: number; w: number; h: number } {
  return {
    x: ev.bbox?.[0] ?? 0,
    y: ev.bbox?.[1] ?? 0,
    w: ev.bbox?.[2] ?? 0,
    h: ev.bbox?.[3] ?? 0,
  };
}

function shiftBetween(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const dw = Math.abs(b.w - a.w);
  const dh = Math.abs(b.h - a.h);
  return Math.sqrt(dx * dx + dy * dy + dw * dw + dh * dh);
}

export class TrackDeduplicator {
  private persistedTracks = new Set<string>();
  private lastSavedPerCameraClass = new Map<
    string,
    { bbox: { x: number; y: number; w: number; h: number }; ts: number }
  >();

  shouldPersist(ev: TrackingEvent): boolean {
    if (!ev.cameraId) return false;

    const trackKey = `${ev.cameraId}:${ev.trackId}`;

    if (ev.event === 'track_ended') {
      this.persistedTracks.delete(trackKey);
      return false;
    }

    if (this.persistedTracks.has(trackKey)) return false;
    if (ev.event !== 'track_started' && ev.event !== 'track_updated') return false;

    const isPerson = ev.class === 'person';

    // A person event with no snapshot has nothing to show.
    if (isPerson && !ev.filePath) return false;

    const sceneKey = `${ev.cameraId}:${ev.class}`;
    const prev = this.lastSavedPerCameraClass.get(sceneKey);
    const now = Date.now();

    const shiftPx = isPerson
      ? envNumber(process.env.PERSON_DEDUPE_SHIFT_PX, PERSON_SHIFT_PX)
      : DEFAULT_SHIFT_PX;
    const windowMs = isPerson
      ? envNumber(process.env.PERSON_DEDUPE_WINDOW_MS, PERSON_WINDOW_MS)
      : DEFAULT_WINDOW_MS;

    if (prev && shiftBetween(prev.bbox, bboxOf(ev)) < shiftPx && now - prev.ts < windowMs) {
      return false;
    }

    // Every class now requires a snapshot: Python writes the JPEG once the
    // track's hit/confidence gate opens, and the first event carrying that
    // path is the one persisted. Without this, motion rows persisted on
    // track_started (tracklet_len 1-2) — before Python's snapshot gate fired
    // — locked the track with file_path NULL forever ("No image" on the
    // events page).
    const shouldPersist = !!ev.filePath;
    if (shouldPersist) {
      this.lastSavedPerCameraClass.set(sceneKey, { bbox: bboxOf(ev), ts: now });
    }

    return shouldPersist;
  }

  markPersisted(ev: TrackingEvent): void {
    if (!ev.cameraId) return;
    const trackKey = `${ev.cameraId}:${ev.trackId}`;
    this.persistedTracks.add(trackKey);
  }

  clearTrack(cameraId: string, trackId: number): void {
    this.persistedTracks.delete(`${cameraId}:${trackId}`);
  }
}
