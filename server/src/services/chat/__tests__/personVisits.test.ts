import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockQuery = jest.fn();

jest.unstable_mockModule('../../../database.js', () => ({
  AppDataSource: {
    query: mockQuery,
    getRepository: jest.fn().mockReturnValue({ find: jest.fn(), save: jest.fn() }),
    isInitialized: true,
  },
}));

const {
  directionOf,
  personVisits,
  personVisitsParamsSchema,
} = await import('../queryTools.js');

const T = (iso: string) => new Date(iso);

describe('directionOf', () => {
  it('labels rightward movement', () => {
    expect(directionOf(100, 400, 640)).toBe('left-to-right');
  });
  it('labels leftward movement', () => {
    expect(directionOf(400, 100, 640)).toBe('right-to-left');
  });
  it('labels small drift stationary', () => {
    expect(directionOf(300, 330, 640)).toBe('stationary');
  });
});

describe('clusterPersonVisits', () => {
  it('merges nearby person tracks into one visit and splits >5min gaps', async () => {
    const { clusterPersonVisits } = await import('../queryTools.js');
    const visits = clusterPersonVisits([
      { camera: 'cam1', first: T('2026-10-16T10:00:00Z'), last: T('2026-10-16T10:02:00Z'), obs: 5, firstX: 100, lastX: 400, identity: 'unknown' },
      { camera: 'cam1', first: T('2026-10-16T10:04:00Z'), last: T('2026-10-16T10:05:00Z'), obs: 3, firstX: 120, lastX: 380, identity: 'unknown' },
      { camera: 'cam1', first: T('2026-10-16T10:30:00Z'), last: T('2026-10-16T10:31:00Z'), obs: 2, firstX: 500, lastX: 150, identity: 'unknown' },
    ]);
    expect(visits).toHaveLength(2);
    expect(visits[0].trackCount).toBe(2);
    expect(visits[0].direction).toBe('left-to-right');
    expect(visits[1].direction).toBe('right-to-left');
  });
});

describe('personVisits tool', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY')) {
        return Promise.resolve([
          {
            track_id: 't1', camera_id: 'cam1',
            first_seen: T('2026-10-16T04:30:00Z'), last_seen: T('2026-10-16T04:32:00Z'),
            obs: 6, events: 2,
            first_x: 100, last_x: 420, identity: 'unknown',
          },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  it('validates params', () => {
    expect(personVisitsParamsSchema.safeParse({ from: 'x' }).success).toBe(false);
  });

  it('returns visit table with arrival/departure and direction', async () => {
    const res = await personVisits({ camera: null, from: T('2026-10-16T00:00:00Z'), to: T('2026-10-17T00:00:00Z') });
    expect(res.tables).toHaveLength(1);
    const row = res.tables[0].rows[0];
    expect(String(row[0])).toBe('cam1');
    expect(row).toEqual(expect.arrayContaining(['left-to-right']));
    expect(res.evidence.visits).toBe(1);
    expect(res.images).toHaveLength(0); // no file candidates in mock
  });

  it('handles empty archive', async () => {
    mockQuery.mockResolvedValue([]);
    const res = await personVisits({ camera: null, from: T('2026-10-16T00:00:00Z'), to: T('2026-10-17T00:00:00Z') });
    expect(res.tables[0].rows).toHaveLength(0);
    expect(res.evidence.visits).toBe(0);
  });
});
