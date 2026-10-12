import { describe, it, expect } from '@jest/globals';
import {
  ALIAS_MAP,
  classifyTrack,
  clusterSessions,
  detectDailyAnomalies,
  humanCountsParamsSchema,
  resolveVehicleClasses,
  VEHICLE_GROUP,
} from '../queryTools.js';
import {
  istDayStart,
  resolveRange,
  resolveIsoRange,
} from '../dateResolver.js';
import { stripUnverifiedNumbers } from '../chatService.js';

describe('classifyTrack', () => {
  it('labels ended/lost tracks as left', () => {
    expect(classifyTrack('new', 'lost')).toBe('left');
    expect(classifyTrack(null, 'lost')).toBe('left');
  });
  it('labels started tracks as returned', () => {
    expect(classifyTrack('new', 'tracked')).toBe('returned');
  });
  it('labels unknown states as observed', () => {
    expect(classifyTrack(null, null)).toBe('observed');
    expect(classifyTrack('tracked', 'tracked')).toBe('observed');
  });
  it('keeps legacy states working for older rows', () => {
    expect(classifyTrack('started', 'ended')).toBe('left');
    expect(classifyTrack('started', 'updated')).toBe('returned');
  });
});

describe('resolveVehicleClasses', () => {
  it('maps scooter to motorcycle', () => {
    expect(resolveVehicleClasses('scooter')).toEqual(['motorcycle']);
  });
  it('maps suv to car', () => {
    expect(resolveVehicleClasses('suv')).toEqual(['car']);
  });
  it('handles generic vehicle group', () => {
    expect(resolveVehicleClasses('vehicle').sort()).toEqual([...VEHICLE_GROUP].sort());
  });
  it('returns empty for unknown vehicle', () => {
    expect(resolveVehicleClasses('helicopter')).toEqual([]);
  });
  it('covers every alias key with non-empty mapping', () => {
    for (const key of Object.keys(ALIAS_MAP)) {
      expect(ALIAS_MAP[key].length).toBeGreaterThan(0);
    }
  });
});

describe('dateResolver (IST = UTC+5:30)', () => {
  it('today resolves to IST midnight boundaries', () => {
    // 2026-08-19 10:00 UTC = 15:30 IST, same IST day (19 Aug)
    const now = new Date('2026-08-19T10:00:00Z');
    const r = resolveRange('today', now);
    expect(r.from.toISOString()).toBe('2026-08-18T18:30:00.000Z'); // 19 Aug 00:00 IST
    expect(r.to.toISOString()).toBe('2026-08-19T18:30:00.000Z'); // 20 Aug 00:00 IST
    expect(r.label).toContain('2026-08-19'); // label shows the IST day, not the UTC instant's date
  });
  it('yesterday lands on the prior IST day', () => {
    const now = new Date('2026-08-19T10:00:00Z');
    const r = resolveRange('yesterday', now);
    expect(r.from.toISOString()).toBe('2026-08-17T18:30:00.000Z');
    expect(r.to.toISOString()).toBe('2026-08-18T18:30:00.000Z');
  });
  it('istDayStart handles IST days that differ from UTC days', () => {
    // 2026-08-19 01:00 UTC = 06:30 IST on 19 Aug → IST midnight is 18 Aug 18:30 UTC
    const start = istDayStart(0, new Date('2026-08-19T01:00:00Z'));
    expect(start.toISOString()).toBe('2026-08-18T18:30:00.000Z');
  });
  it('rejects ranges wider than 90 days', () => {
    expect(() =>
      resolveIsoRange('2026-01-01', '2026-06-01', new Date('2026-06-02T00:00:00Z')),
    ).toThrow(/Range too wide/);
  });
  it('rejects inverted ranges', () => {
    expect(() => resolveIsoRange('2026-08-19', '2026-08-18')).toThrow(/after start/);
  });
});

describe('stripUnverifiedNumbers', () => {
  const stats = JSON.stringify({ totals: { detections: 132, events: 24 }, humans: { unique: 5 } });
  it('keeps sentences whose numbers appear in the stats', () => {
    const out = stripUnverifiedNumbers('Total detections were 132 across 24 events.', stats);
    expect(out).toContain('132');
  });
  it('drops sentences containing numbers absent from the stats', () => {
    const out = stripUnverifiedNumbers('There were 3 people. Total was 999.', stats);
    expect(out).not.toContain('999');
    expect(out).toContain('3 people');
  });
});

describe('clusterSessions', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 7, 19, 4, min)); // 09:xx IST base

  it('merges fragments that start within the gap of the running cluster', () => {
    const spans = [
      { camera: 'cam1', first: t(0), last: t(2), obs: 5 },
      { camera: 'cam1', first: t(4), last: t(6), obs: 3 }, // starts 2 min after cluster end → merge
    ];
    const s = clusterSessions(spans);
    expect(s).toHaveLength(1);
    expect(s[0].trackCount).toBe(2);
    expect(s[0].obs).toBe(8);
    expect(s[0].first.getTime()).toBe(t(0).getTime());
    expect(s[0].last.getTime()).toBe(t(6).getTime());
  });

  it('splits visits separated by more than the gap', () => {
    const spans = [
      { camera: 'cam1', first: t(0), last: t(2), obs: 5 },
      { camera: 'cam1', first: t(30), last: t(32), obs: 4 }, // 28 min gap → new visit
    ];
    const s = clusterSessions(spans);
    expect(s).toHaveLength(2);
    expect(s.map((x) => x.obs)).toEqual([5, 4]);
  });

  it('clusters per camera independently', () => {
    const spans = [
      { camera: 'cam1', first: t(0), last: t(10), obs: 9 },
      { camera: 'cam2', first: t(1), last: t(2), obs: 2 }, // same time window, other camera
    ];
    const s = clusterSessions(spans);
    expect(s).toHaveLength(2);
    expect(new Set(s.map((x) => x.camera)).size).toBe(2);
  });

  it('handles one object scattering into many same-moment track IDs', () => {
    const spans = Array.from({ length: 12 }, (_, i) => ({
      camera: 'cam1',
      first: t(i * 3),
      last: t(i * 3 + 2),
      obs: 3,
    }));
    const s = clusterSessions(spans);
    expect(s).toHaveLength(1);
    expect(s[0].trackCount).toBe(12);
  });

  it('returns empty for no spans', () => {
    expect(clusterSessions([])).toEqual([]);
  });
});

describe('humanCountsParamsSchema', () => {
  it('accepts LLM-shaped params with nulls and defaults class to person', () => {
    const parsed = humanCountsParamsSchema.parse({
      range: 'today',
      camera: null,
      hour_from: null,
      hour_to: null,
    });
    expect(parsed.objectClass).toBe('person');
    expect(parsed.hour_from).toBeNull();
  });
  it('accepts explicit class (dog)', () => {
    const parsed = humanCountsParamsSchema.parse({ range: 'last_7_days', class: undefined, objectClass: 'dog' });
    expect(parsed.objectClass).toBe('dog');
  });
  it('rejects unknown class', () => {
    expect(
      humanCountsParamsSchema.safeParse({ range: 'today', objectClass: 'scooter' }).success,
    ).toBe(false);
  });
});

describe('detectDailyAnomalies', () => {
  it('flags days far above a camera baseline as spikes', () => {
    const series = [
      { day: '2026-08-01', camera: 'cam1', detections: 100 },
      { day: '2026-08-02', camera: 'cam1', detections: 90 },
      { day: '2026-08-03', camera: 'cam1', detections: 450 }, // ~3.6x baseline
      { day: '2026-08-04', camera: 'cam1', detections: 110 },
    ];
    const { spikes, gaps } = detectDailyAnomalies(series);
    expect(spikes.map((s) => s.day)).toEqual(['2026-08-03']);
    expect(gaps).toEqual([]);
  });

  it('never flags a quiet camera with tiny counts', () => {
    const series = [
      { day: '2026-08-01', camera: 'cam1', detections: 1 },
      { day: '2026-08-02', camera: 'cam1', detections: 3 },
      { day: '2026-08-03', camera: 'cam1', detections: 6 },
      { day: '2026-08-04', camera: 'cam1', detections: 2 },
    ];
    const { spikes } = detectDailyAnomalies(series);
    expect(spikes).toEqual([]);
  });

  it('collapses consecutive zero days into one gap span', () => {
    const series = [
      { day: '2026-08-01', camera: 'cam1', detections: 50 },
      { day: '2026-08-02', camera: 'cam1', detections: 0 },
      { day: '2026-08-03', camera: 'cam1', detections: 0 },
      { day: '2026-08-04', camera: 'cam1', detections: 0 },
      { day: '2026-08-05', camera: 'cam1', detections: 40 },
    ];
    const { gaps } = detectDailyAnomalies(series);
    expect(gaps).toEqual([
      { from: '2026-08-02', to: '2026-08-04', camera: 'cam1', days: 3 },
    ]);
  });

  it('treats each camera independently', () => {
    const series = [
      { day: '2026-08-01', camera: 'cam1', detections: 400 },
      { day: '2026-08-02', camera: 'cam1', detections: 50 },
      { day: '2026-08-01', camera: 'cam2', detections: 20 },
      { day: '2026-08-02', camera: 'cam2', detections: 22 },
    ];
    const { spikes } = detectDailyAnomalies(series);
    expect(spikes.map((s) => s.camera)).toEqual(['cam1']);
  });
});
