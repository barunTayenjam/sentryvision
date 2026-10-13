import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateQuery, validateParams } from '../middleware/zodValidation.js';
import { optionalAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { listDigests, getDigest, persistDigest } from '../services/chat/dailyDigestService.js';

const router = Router();

router.get(
  '/',
  optionalAuth,
  validateQuery(
    z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const q = req.query as unknown as { limit?: string; offset?: string };
      const digests = await listDigests(
        q.limit ? parseInt(q.limit, 10) : 30,
        q.offset ? parseInt(q.offset, 10) : 0,
      );
      res.json({ success: true, digests });
    } catch (error) {
      logger.error('Failed to list digests', 'DigestRoutes', error);
      res.status(500).json({ success: false, error: 'Failed to list digests' });
    }
  },
);

router.get(
  '/:date',
  optionalAuth,
  validateParams(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (req: Request, res: Response) => {
    try {
      const digest = await getDigest(req.params.date);
      if (!digest) {
        res.status(404).json({ success: false, error: 'Digest not found' });
        return;
      }
      res.json({ success: true, digest });
    } catch (error) {
      logger.error('Failed to fetch digest', 'DigestRoutes', error);
      res.status(500).json({ success: false, error: 'Failed to fetch digest' });
    }
  },
);

// Manual regeneration (admin cron catch-up)
router.post('/generate', optionalAuth, async (_req: Request, res: Response) => {
  try {
    const stored = await persistDigest();
    if (!stored) {
      res.status(500).json({ success: false, error: 'Digest generation failed' });
      return;
    }
    res.json({ success: true, digest: stored });
  } catch (error) {
    logger.error('Failed to generate digest', 'DigestRoutes', error);
    res.status(500).json({ success: false, error: 'Failed to generate digest' });
  }
});

export default router;
