import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody, validateQuery } from '../middleware/zodValidation.js';
import { requireUser } from '../middleware/auth.js';
import { serviceRegistry } from '../services/serviceRegistry.js';
import { logger } from '../utils/logger.js';

const router = Router();

const ReviewQuerySchema = z.object({
  camera: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100).optional(),
  severity: z.enum(['alert', 'detection']).optional(),
  labels: z.string().optional(),
  reviewed: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const AcknowledgeBodySchema = z.object({
  action: z.enum(['dismiss', 'confirm']).optional(),
});

const BatchAcknowledgeBodySchema = z.object({
  ids: z.array(z.string().regex(/^rev_[a-zA-Z0-9_-]+_\d+$/)).min(1).max(200),
  action: z.enum(['dismiss', 'confirm']).optional(),
});

router.get('/segments', requireUser, validateQuery(ReviewQuerySchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof ReviewQuerySchema>;
    const reviewService = serviceRegistry.getReviewService();
    const result = await reviewService.getReviewSegments({
      camera: q.camera,
      severity: q.severity,
      reviewed: q.reviewed,
      labels: q.labels ? q.labels.split(',').filter(Boolean) : undefined,
      after: q.after ? new Date(q.after) : undefined,
      before: q.before ? new Date(q.before) : undefined,
      userId: (req as Request & { user?: { id: string } }).user?.id,
      limit: q.limit,
      offset: q.offset,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Failed to list review segments', 'ReviewRoutes', error);
    res.status(500).json({ success: false, error: 'Failed to list review segments' });
  }
});

router.get('/counts', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user?: { id: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const reviewService = serviceRegistry.getReviewService();
    const counts = await reviewService.getUnreviewedCounts(userId);
    res.json({ success: true, counts });
  } catch (error) {
    logger.error('Failed to get review counts', 'ReviewRoutes', error);
    res.status(500).json({ success: false, error: 'Failed to get review counts' });
  }
});

router.post(
  '/segments/:id/acknowledge',
  requireUser,
  validateBody(AcknowledgeBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id || !/^rev_[a-zA-Z0-9_-]+_\d+$/.test(id)) {
        res.status(400).json({ success: false, error: 'Invalid segment ID' });
        return;
      }
      const userId = (req as Request & { user?: { id: string } }).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }
      const reviewService = serviceRegistry.getReviewService();
      await reviewService.acknowledgeSegment(id, userId, req.body?.action);
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to acknowledge segment', 'ReviewRoutes', error);
      res.status(500).json({ success: false, error: 'Failed to acknowledge segment' });
    }
  },
);

router.post(
  '/segments/batch-acknowledge',
  requireUser,
  validateBody(BatchAcknowledgeBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { ids, action } = req.body as z.infer<typeof BatchAcknowledgeBodySchema>;
      const userId = (req as Request & { user?: { id: string } }).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }
      const reviewService = serviceRegistry.getReviewService();
      await reviewService.batchAcknowledge(ids, userId, action);
      res.json({ success: true, acknowledged: ids.length });
    } catch (error) {
      logger.error('Failed to batch acknowledge segments', 'ReviewRoutes', error);
      res.status(500).json({ success: false, error: 'Failed to batch acknowledge segments' });
    }
  },
);

export default router;
