import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockListDigests = jest.fn();
const mockGetDigest = jest.fn();
const mockPersistDigest = jest.fn();

jest.unstable_mockModule('../services/chat/dailyDigestService.js', () => ({
  listDigests: mockListDigests,
  getDigest: mockGetDigest,
  persistDigest: mockPersistDigest,
}));

jest.unstable_mockModule('../middleware/auth.js', () => ({
  requireUser: (req: any, _res: any, next: any) => next(),
  optionalAuth: (req: any, _res: any, next: any) => next(),
}));

const { default: digestRoutes } = await import('./digests.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/digests', digestRoutes);
  return app;
}

describe('digest routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('GET / lists digests paginated', async () => {
    mockListDigests.mockResolvedValue([{ id: 'x', digest_date: '2026-10-11' }]);

    const res = await request(app).get('/api/digests?limit=5');

    expect(res.status).toBe(200);
    expect(res.body.digests).toHaveLength(1);
    expect(mockListDigests).toHaveBeenCalledWith(5, 0);
  });

  it('GET /:date returns the digest', async () => {
    mockGetDigest.mockResolvedValue({ digest_date: '2026-10-11', body: 'hi' });

    const res = await request(app).get('/api/digests/2026-10-11');

    expect(res.status).toBe(200);
    expect(res.body.digest.body).toBe('hi');
  });

  it('GET /:date 404s for missing digest', async () => {
    mockGetDigest.mockResolvedValue(null);
    const res = await request(app).get('/api/digests/2020-01-01');
    expect(res.status).toBe(404);
  });

  it('POST /generate regenerates yesterday digest', async () => {
    mockPersistDigest.mockResolvedValue({ digest_date: '2026-10-11' });

    const res = await request(app).post('/api/digests/generate');

    expect(res.status).toBe(200);
    expect(res.body.digest.digest_date).toBe('2026-10-11');
  });
});
