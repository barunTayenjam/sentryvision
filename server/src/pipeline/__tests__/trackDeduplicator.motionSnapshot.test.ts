/**
 * Motion rows must carry a snapshot.
 *
 * Live symptom: every `motion` event (dog, cat, …) persisted with file_path
 * NULL — the events page rendered "No image" for all of them. Two halves:
 *
 * 1. Python only wrote snapshots for person/vehicle tracks (fixed separately
 *    in frame_pipeline.py — motion classes now snapshot once the track's
 *    hit/confidence gate opens).
 * 2. TrackDeduplicator persisted the row on the track's FIRST event
 *    (track_started, tracklet_len 1-2) — before that gate had fired — and
 *    markPersisted() then locked the track, so the later event carrying
 *    file_path never produced a row.
 *
 * The fix makes all classes require ev.filePath, same as persons. These tests
 * pin half 2: the row is persisted only when a snapshot exists, and the
 * snapshot-bearing update of a previously skipped track still persists.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

import { TrackDeduplicator } from '../trackDeduplicator.js';
import type { TrackingEvent } from '../../services/pythonWsClient.js';

function motionEvent(over: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    cameraId: 'cam1',
    event: 'track_started',
    trackId: 1,
    timestamp: Date.now() / 1000,
    bbox: [100, 100, 50, 60],
    score: 0.7,
    class: 'dog',
    classId: 16,
    filePath: null,
    ...over,
  } as TrackingEvent;
}

describe('motion rows require a snapshot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not persist a motion event without a snapshot', () => {
    const dedup = new TrackDeduplicator();

    expect(dedup.shouldPersist(motionEvent())).toBe(false);
  });

  it('persists once the snapshot arrives, and locks the track then', () => {
    const dedup = new TrackDeduplicator();

    // Track starts with no snapshot yet (gate not open).
    expect(dedup.shouldPersist(motionEvent({ trackId: 7, filePath: null }))).toBe(false);

    // 1s later the gate fired; the update carries the JPEG.
    jest.setSystemTime(Date.now() + 1000);
    const withSnap = motionEvent({
      trackId: 7,
      event: 'track_updated',
      filePath: '/app/data/detections/2026-10/events/motion/motion_cam1_x_t7.jpg',
    });
    expect(dedup.shouldPersist(withSnap)).toBe(true);

    // Row locked: further updates of the same track do not re-persist.
    expect(dedup.shouldPersist(withSnap)).toBe(false);
  });

  it('still requires snapshots for vehicles too', () => {
    const dedup = new TrackDeduplicator();

    expect(
      dedup.shouldPersist(motionEvent({ class: 'car', classId: 2, filePath: null })),
    ).toBe(false);
    expect(
      dedup.shouldPersist(
        motionEvent({ class: 'car', classId: 2, filePath: '/tmp/car.jpg' }),
      ),
    ).toBe(true);
  });
});
