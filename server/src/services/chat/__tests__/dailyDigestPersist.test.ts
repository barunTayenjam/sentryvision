import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockQuery = jest.fn();
const mockCollectReportStats = jest.fn();
const mockCollectReportScenes = jest.fn();
const mockSendNotificationToUser = jest.fn();

jest.unstable_mockModule('../../../database.js', () => ({
  AppDataSource: {
    query: mockQuery,
    getRepository: jest.fn().mockReturnValue({ find: jest.fn(), findOne: jest.fn() }),
  },
}));

jest.unstable_mockModule('../reportGenerator.js', () => ({
  collectReportStats: mockCollectReportStats,
  collectReportScenes: mockCollectReportScenes,
}));

jest.unstable_mockModule('../../notificationService.js', () => ({
  default: { sendNotificationToUser: mockSendNotificationToUser },
  NotificationService: { sendNotificationToUser: mockSendNotificationToUser },
}));

const { persistDigest, listDigests, getDigest, persistAndPushDigest } = await import(
  '../dailyDigestService.js'
);

const STATS = {
  totals: { events: 1721, detections: 3284 },
  humans: { unique: 1170, detections: 1675, verified: 1675 },
  vehicles: [{ class: 'car', tracks: 121, detections: 179, arrived: 26, left: 30 }],
  busyHours: [{ hour: 6, detections: 805 }],
  longestTracks: [],
  threats: [{ level: 'low', events: 1000 }],
  cameras: ['cam1', 'cam2'],
};

describe('persistDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollectReportStats.mockResolvedValue(STATS);
    mockCollectReportScenes.mockResolvedValue([]);
    mockQuery.mockResolvedValue([]);
  });

  it('upserts the digest for yesterday IST', async () => {
    await persistDigest();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO daily_digests'),
      expect.arrayContaining([expect.any(String), expect.stringContaining('Daily digest'), expect.any(String)]),
    );
  });

  it('stores event/detection counts', async () => {
    await persistDigest();
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain(1721);
    expect(params).toContain(3284);
  });

  it('never throws — DB failure returns null', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(persistDigest()).resolves.toBeNull();
  });
});

describe('listDigests / getDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists most recent digests with pagination', async () => {
    mockQuery.mockResolvedValue([
      { id: 'a', digest_date: '2026-10-11', title: 'Daily digest — 2026-10-11', event_count: 1721 },
    ]);
    const rows = await listDigests(10, 0);
    expect(rows).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY digest_date DESC'),
      [10, 0],
    );
  });

  it('fetches a single digest by date', async () => {
    mockQuery.mockResolvedValue([
      { id: 'a', digest_date: '2026-10-11', title: 'x', body: 'y' },
    ]);
    const row = await getDigest('2026-10-11');
    expect(row?.digest_date).toBe('2026-10-11');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE digest_date = $1'),
      ['2026-10-11'],
    );
  });

  it('returns null for invalid date input', async () => {
    await expect(getDigest('not-a-date')).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('persistAndPushDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollectReportStats.mockResolvedValue(STATS);
    mockCollectReportScenes.mockResolvedValue([]);
    mockQuery
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([{ user_id: 'u1' }]); // subscribers
    mockSendNotificationToUser.mockResolvedValue(undefined);
  });

  it('persists first, then pushes deep-link digest payload', async () => {
    const result = await persistAndPushDigest();

    expect(result.persisted).toBe(true);
    expect(result.pushed).toBe(1);
    expect(mockSendNotificationToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ url: expect.stringContaining('/events?digest=') }),
      'system',
    );
  });
});
