import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetReviewSegments = jest.fn();
const mockAcknowledgeSegment = jest.fn();
const mockBatchAcknowledge = jest.fn();
const mockGetUnreviewedCounts = jest.fn();

jest.unstable_mockModule('../services/serviceRegistry.js', () => ({
  serviceRegistry: {
    getReviewService: () => ({
      getReviewSegments: mockGetReviewSegments,
      acknowledgeSegment: mockAcknowledgeSegment,
      batchAcknowledge: mockBatchAcknowledge,
      getUnreviewedCounts: mockGetUnreviewedCounts,
    }),
  },
}));

jest.unstable_mockModule('../middleware/auth.js', () => ({
  requireUser: (req: any, res: any, next: any) => {
    req.user = { id: 'user-1', role: 'user' };
    next();
  },
}));

const { default: reviewRoutes } = await import('./review.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/review', reviewRoutes);
  return app;
}

describe('review routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('GET /segments returns segments from service', async () => {
    mockGetReviewSegments.mockResolvedValue({ segments: [], total: 0, hasMore: false });

    const res = await request(app).get('/api/review/segments?severity=alert&camera=cam1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockGetReviewSegments).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'alert', camera: 'cam1', userId: 'user-1' }),
    );
  });

  it('GET /segments rejects bad severity', async () => {
    const res = await request(app).get('/api/review/segments?severity=bogus');
    expect(res.status).toBe(400);
  });

  it('GET /counts returns per-severity unreviewed counts', async () => {
    mockGetUnreviewedCounts.mockResolvedValue({ alert: 3, detection: 5 });

    const res = await request(app).get('/api/review/counts');

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ alert: 3, detection: 5 });
    expect(mockGetUnreviewedCounts).toHaveBeenCalledWith('user-1');
  });

  it('POST /segments/:id/acknowledge acks with action', async () => {
    mockAcknowledgeSegment.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/review/segments/rev_cam1_1791633600/acknowledge')
      .send({ action: 'dismiss' });

    expect(res.status).toBe(200);
    expect(mockAcknowledgeSegment).toHaveBeenCalledWith('rev_cam1_1791633600', 'user-1', 'dismiss');
  });

  it('POST /segments/:id/acknowledge rejects bad action', async () => {
    const res = await request(app)
      .post('/api/review/segments/rev_cam1_1791633600/acknowledge')
      .send({ action: 'nonsense' });
    expect(res.status).toBe(400);
  });

  it('POST /segments/batch-acknowledge acks id list', async () => {
    mockBatchAcknowledge.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/review/segments/batch-acknowledge')
      .send({ ids: ['rev_cam1_1791633600', 'rev_cam2_1791633630'], action: 'confirm' });

    expect(res.status).toBe(200);
    expect(mockBatchAcknowledge).toHaveBeenCalledWith(['rev_cam1_1791633600', 'rev_cam2_1791633630'], 'user-1', 'confirm');
  });

  it('POST /segments/batch-acknowledge rejects empty or oversized list', async () => {
    const empty = await request(app).post('/api/review/segments/batch-acknowledge').send({ ids: [] });
    expect(empty.status).toBe(400);

    const big = await request(app)
      .post('/api/review/segments/batch-acknowledge')
      .send({ ids: new Array(201).fill('x') });
    expect(big.status).toBe(400);
  });
});
