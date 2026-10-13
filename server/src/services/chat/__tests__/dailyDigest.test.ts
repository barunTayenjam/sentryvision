import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockCollectReportStats = jest.fn();
const mockCollectReportScenes = jest.fn();
const mockSendNotificationToUser = jest.fn();
const mockQuery = jest.fn();

jest.unstable_mockModule('../reportGenerator.js', () => ({
  collectReportStats: mockCollectReportStats,
  collectReportScenes: mockCollectReportScenes,
}));

jest.unstable_mockModule('../../../database.js', () => ({
  AppDataSource: {
    query: mockQuery,
    getRepository: jest.fn().mockReturnValue({ find: jest.fn(), findOne: jest.fn() }),
  },
}));

jest.unstable_mockModule('../../notificationService.js', () => ({
  default: { sendNotificationToUser: mockSendNotificationToUser },
  NotificationService: { sendNotificationToUser: mockSendNotificationToUser },
}));

const { buildYesterdayDigest, sendDailyDigest } = await import('../dailyDigestService.js');

describe('buildYesterdayDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollectReportStats.mockResolvedValue({
      totals: { events: 1721, detections: 3284 },
      humans: { unique: 1170, detections: 1675, verified: 1675 },
      vehicles: [
        { class: 'motorcycle', tracks: 519, detections: 781, arrived: 28, left: 149 },
        { class: 'car', tracks: 121, detections: 179, arrived: 26, left: 30 },
      ],
      busyHours: [{ hour: 6, detections: 805 }, { hour: 16, detections: 383 }],
      longestTracks: [],
      threats: [
        { level: 'critical', events: 412 },
        { level: 'high', events: 369 },
        { level: 'low', events: 659 },
      ],
      cameras: ['cam1', 'cam2'],
    });
    mockCollectReportScenes.mockResolvedValue([
      {
        id: 'e1',
        camera: 'cam1',
        timestamp: new Date('2026-10-11T14:30:00Z'),
        description: 'A person is standing next to a silver car near the gate.',
        relations: [],
      },
    ]);
  });

  it('builds a concise digest with totals, vehicles, peaks, threat', async () => {
    const digest = await buildYesterdayDigest();

    expect(digest.title).toContain('Daily digest');
    expect(digest.body).toContain('1,721');
    expect(digest.body).toContain('1,170');
    expect(digest.body).toContain('motorcycle');
    expect(digest.body).toContain('arriv');
    expect(digest.body).toContain('06:00');
  });

  it('includes scene highlight when one exists', async () => {
    const digest = await buildYesterdayDigest();
    expect(digest.body).toContain('silver car');
  });

  it('omits scene section when none exist', async () => {
    mockCollectReportScenes.mockResolvedValue([]);
    const digest = await buildYesterdayDigest();
    expect(digest.body).not.toContain('Highlights');
  });

  it('returns zero-state digest for empty day', async () => {
    mockCollectReportStats.mockResolvedValue({
      totals: { events: 0, detections: 0 },
      humans: { unique: 0, detections: 0, verified: 0 },
      vehicles: [],
      busyHours: [],
      longestTracks: [],
      threats: [],
      cameras: [],
    });
    const digest = await buildYesterdayDigest();
    expect(digest.body.toLowerCase()).toContain('no events');
  });

  it('queries yesterday IST window', async () => {
    await buildYesterdayDigest();
    const arg = mockCollectReportStats.mock.calls[0][0];
    expect(arg.from).toBeInstanceOf(Date);
    expect(arg.to).toBeInstanceOf(Date);
    expect(arg.to.getTime() - arg.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('sendDailyDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    mockCollectReportStats.mockResolvedValue({
      totals: { events: 5, detections: 10 },
      humans: { unique: 3, detections: 5, verified: 5 },
      vehicles: [],
      busyHours: [],
      longestTracks: [],
      threats: [],
      cameras: ['cam1'],
    });
    mockCollectReportScenes.mockResolvedValue([]);
    mockSendNotificationToUser.mockResolvedValue(undefined);
  });

  it('pushes digest to every subscribed user', async () => {
    const result = await sendDailyDigest();

    expect(mockSendNotificationToUser).toHaveBeenCalledTimes(2);
    expect(mockSendNotificationToUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ title: expect.stringContaining('Daily digest') }),
      'system',
    );
    expect(result.pushed).toBe(2);
  });

  it('skips push when no subscribers', async () => {
    mockQuery.mockResolvedValue([]);
    const result = await sendDailyDigest();
    expect(mockSendNotificationToUser).not.toHaveBeenCalled();
    expect(result.pushed).toBe(0);
  });

  it('never throws — notification failure is logged, not fatal', async () => {
    mockSendNotificationToUser.mockRejectedValue(new Error('push down'));
    const result = await sendDailyDigest();
    expect(result.pushed).toBe(0);
    expect(result.failed).toBe(2);
  });
});
