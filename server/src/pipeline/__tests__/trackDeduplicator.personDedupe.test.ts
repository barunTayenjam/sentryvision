/**
 * Stationarity dedupe for person events.
 *
 * Live symptom: a single parked Bolero + motorcycle on cam2 produced 35
 * `event_type='person'` events across 34 distinct track ids. The jeep's track
 * reached PERSON_MIN_TRACK_HITS (3), emitted an event, then died — motion
 * detection pauses, the track ages out, IR noise re-triggers, YOLO re-detects
 * the same object at the same coordinates, a fresh track id is minted, and the
 * cycle repeats. Track-id dedupe cannot see this because every sighting is a
 * new id.
 *
 * `TrackDeduplicator` already suppresses repeat sightings for other classes
 * using a spatial/temporal window, but persons were exempted outright:
 *
 *     if (ev.class === 'person') return !!ev.filePath;
 *
 * Replaying that existing window over 24h of real events made it clear why the
 * exemption exists. At its current 80px shift, it would suppress 99 events to
 * catch 28 ghosts — 71 real detections lost, and zero ghosts caught on cam1.
 * People legitimately stand in the same doorway repeatedly. 80px is far too
 * loose for a class that does not teleport.
 *
 * What actually separates the fixture from a person is how *little* it moves.
 * Consecutive bbox shifts between same-camera person events:
 *
 *     jeep ghost   n=35   p50=2.4px   p90=15.4px   31/35 under 15px
 *     real people  n=269  p50=127.5px p90=256.9px  17/269 under 15px
 *
 * So persons get their own, much tighter window. A person who has not shifted
 * more than a few pixels in ten minutes is standing still or is a fixture —
 * either way one event is the right answer, not a new row every few minutes.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

import { TrackDeduplicator } from '../trackDeduplicator.js';
import type { TrackingEvent } from '../../services/pythonWsClient.js';

function personEvent(over: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    cameraId: 'cam2',
    event: 'track_started',
    trackId: 1,
    timestamp: Date.now() / 1000,
    bbox: [41, 229, 72, 70],
    score: 0.63,
    class: 'person',
    classId: 0,
    filePath: '/tmp/person.jpg',
    ...over,
  } as TrackingEvent;
}

const BASE = new Date('2026-10-05T00:00:00Z').getTime();

/** Advance the dedup's clock without sleeping. */
function tick(ms: number): void {
  jest.setSystemTime(BASE + ms);
}

describe('person stationarity dedupe', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    delete process.env.PERSON_DEDUPE_SHIFT_PX;
    delete process.env.PERSON_DEDUPE_WINDOW_MS;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('still persists the first sighting', () => {
    const dedup = new TrackDeduplicator();

    expect(dedup.shouldPersist(personEvent())).toBe(true);
  });

  it('suppresses the same object re-detected at the same spot in a new track', () => {
    const dedup = new TrackDeduplicator();
    dedup.shouldPersist(personEvent({ trackId: 16 }));

    // The jeep again two minutes later, brand new track id, 1px of jitter.
    tick(120_000);
    const second = dedup.shouldPersist(personEvent({ trackId: 17, bbox: [42, 230, 72, 70] }));

    expect(second).toBe(false);
  });

  it('collapses a run of sightings inside one window into a single event', () => {
    // Five sightings spread over 2.5 minutes must all fall inside the 3 minute window.
    const dedup = new TrackDeduplicator();
    let persisted = 0;
    for (let i = 0; i < 5; i++) {
      tick(i * 38_000);
      if (dedup.shouldPersist(personEvent({ trackId: 100 + i }))) persisted++;
    }

    expect(persisted).toBe(1);
  });

  it('shrinks the 35-sighting ghost stream from 35 events to a handful', () => {
    // Not to one: the window is 3 minutes, so a stream that never pauses for
    // longer than that still re-fires once per window.
    const dedup = new TrackDeduplicator();
    let persisted = 0;
    for (let i = 0; i < 35; i++) {
      tick(i * 60_000);
      if (dedup.shouldPersist(personEvent({ trackId: 100 + i }))) persisted++;
    }

    expect(persisted).toBeLessThanOrEqual(13);
    expect(persisted).toBeGreaterThan(0);
  });

  it('persists a person who has walked somewhere else', () => {
    const dedup = new TrackDeduplicator();
    dedup.shouldPersist(personEvent({ trackId: 1 }));

    // A real person's bbox moves ~127px between sightings.
    tick(120_000);
    const moved = dedup.shouldPersist(personEvent({ trackId: 2, bbox: [168, 229, 72, 70] }));

    expect(moved).toBe(true);
  });

  it('persists the same spot again once the window has expired', () => {
    const dedup = new TrackDeduplicator();
    dedup.shouldPersist(personEvent({ trackId: 1 }));

    // Beyond the 3 minute window, even an unmoved box counts as new.
    tick(4 * 60_000);
    const later = dedup.shouldPersist(personEvent({ trackId: 2 }));

    expect(later).toBe(true);
  });

  it('does not let one camera suppress another', () => {
    const dedup = new TrackDeduplicator();
    dedup.shouldPersist(personEvent({ cameraId: 'cam2', trackId: 1 }));

    tick(60_000);
    const otherCam = dedup.shouldPersist(personEvent({ cameraId: 'cam1', trackId: 1 }));

    expect(otherCam).toBe(true);
  });

  it('honours the configured shift threshold', () => {
    process.env.PERSON_DEDUPE_SHIFT_PX = '200';
    const dedup = new TrackDeduplicator();
    dedup.shouldPersist(personEvent({ trackId: 1 }));

    tick(60_000);
    const withinLoose = dedup.shouldPersist(personEvent({ trackId: 2, bbox: [168, 229, 72, 70] }));

    expect(withinLoose).toBe(false);
  });

  it('leaves vehicle dedupe thresholds untouched', () => {
    const dedup = new TrackDeduplicator();
    const car = {
      cameraId: 'cam2', event: 'track_started' as const, trackId: 5, score: 0.7,
      bbox: [41, 229, 72, 70], class: 'car', classId: 2, filePath: '/tmp/car.jpg',
    } as unknown as TrackingEvent;
    dedup.shouldPersist(car);

    // 150px apart: beyond the 80px vehicle window, so a new vehicle event.
    tick(60_000);
    const far = dedup.shouldPersist({ ...car, trackId: 6, bbox: [191, 229, 72, 70] } as TrackingEvent);

    expect(far).toBe(true);
  });

  it('a person with no snapshot is still rejected', () => {
    const dedup = new TrackDeduplicator();

    expect(dedup.shouldPersist(personEvent({ filePath: null }))).toBe(false);
  });
});