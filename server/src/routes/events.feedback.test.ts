/**
 * Feedback loop Phase A (Frigate parity #7): per-event user verdict.
 *
 * PATCH /api/events/:id/feedback stores 'false_positive' | 'false_negative'
 * | 'confirmed' (or null to clear) on the event row — one verdict per event,
 * updated in place. Feeds export-training-set.py (YOLO-format dataset) and
 * the fine-tune loop; never auto-retrains (data sovereignty).
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockSetFeedback = jest.fn();

jest.unstable_mockModule('../services/eventSearchService.js', () => ({
  default: { setEventFeedback: mockSetFeedback },
}));

jest.unstable_mockModule('../middleware/auth.js', () => ({
  requireUser: (req: any, _res: any, next: any) => next(),
  optionalAuth: (req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('../services/relationAnalysisService.js', () => ({
  relationAnalysisService: {},
}));

jest.unstable_mockModule('../services/relationThreatService.js', () => ({
  relationThreatService: {},
}));

const { default: eventRoutes } = await import('./events.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/events', eventRoutes);
  return app;
}

const UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('PATCH /api/events/:id/feedback', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it.each(['false_positive', 'false_negative', 'confirmed'])(
    'stores verdict %s',
    async (verdict) => {
      mockSetFeedback.mockResolvedValue({ id: UUID, user_feedback: verdict });

      const res = await request(app)
        .patch(`/api/events/${UUID}/feedback`)
        .send({ feedback: verdict });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.event.user_feedback).toBe(verdict);
      expect(mockSetFeedback).toHaveBeenCalledWith(UUID, verdict);
    },
  );

  it('clears verdict with null', async () => {
    mockSetFeedback.mockResolvedValue({ id: UUID, user_feedback: null });

    const res = await request(app)
      .patch(`/api/events/${UUID}/feedback`)
      .send({ feedback: null });

    expect(res.status).toBe(200);
    expect(res.body.event.user_feedback).toBeNull();
    expect(mockSetFeedback).toHaveBeenCalledWith(UUID, null);
  });

  it('400s on invalid verdict value', async () => {
    const res = await request(app)
      .patch(`/api/events/${UUID}/feedback`)
      .send({ feedback: 'sort_of_ok' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockSetFeedback).not.toHaveBeenCalled();
  });

  it('400s on missing feedback field', async () => {
    const res = await request(app).patch(`/api/events/${UUID}/feedback`).send({});

    expect(res.status).toBe(400);
    expect(mockSetFeedback).not.toHaveBeenCalled();
  });

  it('404s when event does not exist', async () => {
    mockSetFeedback.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/events/${UUID}/feedback`)
      .send({ feedback: 'confirmed' });

    expect(res.status).toBe(404);
  });
});
