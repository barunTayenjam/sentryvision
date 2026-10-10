import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ReviewService } from './reviewService.js';

describe('ReviewService segment upsert from events', () => {
  let reviewService: ReviewService;
  let mockReviewSegmentRepo: any;
  let mockReviewStatusRepo: any;
  let mockTimelineService: any;
  let mockPreviewService: any;

  const baseEvent = {
    id: 'evt-1',
    camera_id: 'cam1',
    timestamp: new Date('2026-10-10T12:00:10Z'),
    severity: 'detection' as const,
    event_type: 'vehicle',
    file_path: '/data/detections/x.jpg',
    object_detections: [
      { class: 'car', confidence: 80, trackId: 1, trackState: 'updated', trackletLen: 4 },
    ],
  };

  beforeEach(() => {
    mockReviewSegmentRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      }),
      findOne: jest.fn(),
      create: jest.fn((x) => x),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn(),
      upsert: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    };

    mockReviewStatusRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };

    mockTimelineService = { getActiveObjects: jest.fn().mockResolvedValue(new Map()) };
    mockPreviewService = { generatePreview: jest.fn().mockResolvedValue('/p.mp4') };

    reviewService = new ReviewService(
      mockReviewSegmentRepo,
      mockReviewStatusRepo,
      mockTimelineService,
      mockPreviewService,
    );
  });

  describe('segmentIdForEvent', () => {
    it('derives deterministic id from camera and 30s bucket', () => {
      const id = reviewService.segmentIdForEvent('cam1', new Date('2026-10-10T12:00:10Z'));
      expect(id).toBe('rev_cam1_1791633600');
    });

    it('maps timestamps in same 30s window to same id', () => {
      const a = reviewService.segmentIdForEvent('cam1', new Date('2026-10-10T12:00:00Z'));
      const b = reviewService.segmentIdForEvent('cam1', new Date('2026-10-10T12:00:29.999Z'));
      expect(a).toBe(b);
    });

    it('maps timestamps in different windows to different ids', () => {
      const a = reviewService.segmentIdForEvent('cam1', new Date('2026-10-10T12:00:00Z'));
      const b = reviewService.segmentIdForEvent('cam1', new Date('2026-10-10T12:00:30Z'));
      expect(a).not.toBe(b);
    });
  });

  describe('upsertSegmentFromEvent', () => {
    it('upserts a segment row via ON CONFLICT with deterministic id', async () => {
      await reviewService.upsertSegmentFromEvent(baseEvent);

      expect(mockReviewSegmentRepo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockReviewSegmentRepo.query.mock.calls[0];
      expect(sql).toContain('ON CONFLICT');
      expect(params).toContain('rev_cam1_1791633600');
      expect(params).toContain('cam1');
    });

    it('derives labels from event type and object_detections classes', async () => {
      await reviewService.upsertSegmentFromEvent(baseEvent);

      const [, params] = mockReviewSegmentRepo.query.mock.calls[0];
      const labelsParam = params.find((p: unknown) => typeof p === 'string' && p.includes('car'));
      expect(labelsParam).toBeTruthy();
      expect(labelsParam).toContain('vehicle');
    });

    it('ignores info severity events (motion tab handled separately)', async () => {
      await reviewService.upsertSegmentFromEvent({ ...baseEvent, severity: 'info' });
      expect(mockReviewSegmentRepo.query).not.toHaveBeenCalled();
    });

    it('ignores events without camera_id', async () => {
      await reviewService.upsertSegmentFromEvent({ ...baseEvent, camera_id: '' });
      expect(mockReviewSegmentRepo.query).not.toHaveBeenCalled();
    });

    it('never throws — repository errors are swallowed', async () => {
      mockReviewSegmentRepo.query = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(reviewService.upsertSegmentFromEvent(baseEvent)).resolves.toBeUndefined();
    });
  });

  describe('getUnreviewedCounts', () => {
    it('returns per-severity counts excluding reviewed segments for the user', async () => {
      mockReviewSegmentRepo.query.mockResolvedValueOnce([
        { severity: 'alert', count: '3' },
        { severity: 'detection', count: '5' },
      ]);

      const counts = await reviewService.getUnreviewedCounts('user-1');

      expect(counts).toEqual({ alert: 3, detection: 5 });
      const [sql, params] = mockReviewSegmentRepo.query.mock.calls[0];
      expect(sql).toContain('user_review_status');
      expect(params).toContain('user-1');
    });

    it('returns zeroed counts when no rows', async () => {
      mockReviewSegmentRepo.query.mockResolvedValueOnce([]);
      const counts = await reviewService.getUnreviewedCounts('user-1');
      expect(counts).toEqual({ alert: 0, detection: 0 });
    });
  });

  describe('getReviewSegments reviewed filter', () => {
    it('applies user-scoped reviewed filter', async () => {
      await reviewService.getReviewSegments({ reviewed: false, userId: 'user-1' });

      expect(mockReviewSegmentRepo.createQueryBuilder().andWhere).toHaveBeenCalledWith(
        expect.stringContaining('urs.review_segment_id IS NULL'),
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('does not filter on review status when no reviewed flag', async () => {
      await reviewService.getReviewSegments({});

      const calls = mockReviewSegmentRepo.createQueryBuilder().andWhere.mock.calls as unknown[][];
      expect(calls.flat().some((c) => String(c).includes('urs.'))).toBe(false);
    });
  });

  describe('batchAcknowledge', () => {
    it('acks each segment id for the user', async () => {
      await reviewService.batchAcknowledge(['seg-1', 'seg-2'], 'user-1', 'dismiss');

      expect(mockReviewStatusRepo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockReviewStatusRepo.query.mock.calls[0];
      expect(sql).toContain('INSERT');
      expect(params[0]).toBe('user-1');
      expect(params[1]).toEqual(['seg-1', 'seg-2']);
    });

    it('rejects empty id list without querying', async () => {
      await reviewService.batchAcknowledge([], 'user-1');
      expect(mockReviewStatusRepo.query).not.toHaveBeenCalled();
    });
  });
});
