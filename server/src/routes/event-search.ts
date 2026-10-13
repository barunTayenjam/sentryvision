import { logger } from '../utils/logger.js';
import { Router, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { z } from 'zod';
import { validateBody, validateQuery, validateParams } from '../middleware/zodValidation.js';
import eventSearchService from '../services/eventSearchService.js';
import { inMemoryState } from '../services/inMemoryStateService.js';
import { AppDataSource } from '../database.js';
import { config } from '../config/index.js';
import { optionalAuth, requireUser } from '../middleware/auth.js';

const imagePathCache = new Map<string, { path: string; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 1000;

const router = Router();

router.get(
  '/search',
  optionalAuth,
  validateQuery(
    z.object({
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}/)
        .optional(),
      endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}/)
        .optional(),
      cameraId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional(),
      eventType: z.string().optional(),
      page: z.preprocess(
        (v) => (v ? parseInt(v as string, 10) : undefined),
        z.number().min(1).optional(),
      ),
      pageSize: z.preprocess(
        (v) => (v ? parseInt(v as string, 10) : undefined),
        z.number().min(1).max(100).optional(),
      ),
      sortBy: z.string().optional(),
      sortOrder: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const filters = {
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        cameraId: req.query.cameraId as string,
        eventType: req.query.eventType as string,
        confidence: req.query.confidence as string,
        faceStatus: req.query.faceStatus as string,
        page: parseInt(req.query.page as string) || 1,
        pageSize: Math.min(parseInt(req.query.pageSize as string) || 20, 100),
        sortBy: req.query.sortBy as string,
        sortOrder:
          (req.query.sortOrder as string)?.toUpperCase() === 'ASC'
            ? ('ASC' as const)
            : ('DESC' as const),
      };
      const result = await eventSearchService.searchEvents(filters);
      res.json({ success: true, ...result });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error searching events', 'EventSearch', error);
      res.status(500).json({ success: false, error: errMsg || 'Failed to search events' });
    }
  },
);

router.get('/stats/today', optionalAuth, async (req: Request, res: Response) => {
  try {
    const count = await eventSearchService.getTodayEventCount();
    res.json({ success: true, count });
  } catch (error) {
    logger.error('Error fetching daily stats', 'EventSearch', error);
    res.status(500).json({ success: false, error: 'Failed to fetch daily stats' });
  }
});

router.get(
  '/stats/calendar',
  optionalAuth,
  validateQuery(
    z.object({
      year: z.preprocess(
        (v) => (v ? parseInt(v as string, 10) : undefined),
        z.number().min(2020).max(2100).optional(),
      ),
      month: z.preprocess(
        (v) => (v ? parseInt(v as string, 10) : undefined),
        z.number().min(1).max(12).optional(),
      ),
      camera_id: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional(),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { year, month, camera_id } = req.query;
      const currentYear = year ? parseInt(year as string) : new Date().getFullYear();
      const currentMonth = month ? parseInt(month as string) : new Date().getMonth() + 1;
      const result = await eventSearchService.getCalendarStats(
        currentYear,
        currentMonth,
        camera_id as string,
      );
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Error fetching calendar stats', 'EventSearch', error);
      res.status(500).json({ success: false, error: 'Failed to fetch calendar stats' });
    }
  },
);

router.get(
  '/stats/range',
  optionalAuth,
  validateQuery(
    z.object({
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      camera_id: z.string().optional(),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { start_date, end_date, camera_id } = req.query;
      if (!start_date || !end_date) {
        res.status(400).json({ success: false, error: 'Start and end dates required' });
        return;
      }
      const stats = await eventSearchService.getRangeStats(
        start_date as string,
        end_date as string,
        camera_id as string,
      );
      res.json({ success: true, stats });
    } catch (error) {
      logger.error('Error fetching range stats', 'EventSearch', error);
      res.status(500).json({ success: false, error: 'Failed to fetch range stats' });
    }
  },
);

router.get('/list', optionalAuth, async (req: Request, res: Response) => {
  try {
    const files = await eventSearchService.listEventFiles();
    res.json({ success: true, files });
  } catch (error) {
    logger.error('Error listing events', 'EventSearch', error);
    res.status(500).json({ success: false, error: 'Failed to list events' });
  }
});

router.get(
  '/:id/details',
  optionalAuth,
  validateParams(
    z.object({
      id: z.string().min(1).max(100),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const event = await eventSearchService.getEventDetails(req.params.id);
      if (!event) {
        res.status(404).json({ success: false, error: 'Event not found' });
        return;
      }
      res.json({ success: true, event });
    } catch (error) {
      logger.error('Failed to fetch event details', 'EventSearch', error);
      res.status(500).json({ success: false, error: 'Failed to fetch event details' });
    }
  },
);

router.get(
  '/image/:filename',
  optionalAuth,
  validateParams(
    z.object({
      filename: z.string().regex(/^[a-zA-Z0-9._-]+$/),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { filename } = req.params;
      if (
        !filename ||
        filename.includes('..') ||
        filename.includes('/') ||
        filename.includes('\\')
      ) {
        return res.status(400).json({ success: false, error: 'Invalid filename' });
      }

      const publicImagePath = path.join(config.storage.eventsDir, filename);
      if (fs.existsSync(publicImagePath)) return res.sendFile(publicImagePath);

      const cacheKey = `img:${filename}`;
      const cached = imagePathCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        if (fs.existsSync(cached.path)) return res.sendFile(cached.path);
      }

      try {
        const storagePath = await eventSearchService.lookupEventImagePath(filename);
        if (storagePath) {
          let actualImagePath = storagePath;
          if (!path.isAbsolute(actualImagePath)) {
            actualImagePath = path.join(config.storage.detectionsDir, actualImagePath);
          }
          if (fs.existsSync(actualImagePath)) {
            if (imagePathCache.size >= CACHE_MAX) imagePathCache.clear();
            imagePathCache.set(cacheKey, { path: actualImagePath, timestamp: Date.now() });
            return res.sendFile(actualImagePath);
          }
        }
      } catch (err) {
        logger.warn(`Failed to lookup event image path for ${filename}`, 'EventSearch', err);
      }

      const fallbackPath = path.join(config.storage.detectionsDir, filename);
      if (fs.existsSync(fallbackPath)) {
        if (imagePathCache.size >= CACHE_MAX) imagePathCache.clear();
        imagePathCache.set(cacheKey, { path: fallbackPath, timestamp: Date.now() });
        return res.sendFile(fallbackPath);
      }

      res.status(404).json({ success: false, error: 'Image file not found on disk' });
    } catch (error) {
      logger.error('Error serving event image', 'EventSearch', error);
      res.status(500).json({ success: false, error: 'Failed to serve image' });
    }
  },
);

router.post('/bulk/archive', requireUser, async (req: Request, res: Response) => {
  try {
    const { eventIds } = req.body;
    if (
      !Array.isArray(eventIds) ||
      eventIds.length === 0 ||
      !eventIds.every((id: unknown) => typeof id === 'string')
    ) {
      res
        .status(400)
        .json({ success: false, error: 'eventIds must be a non-empty array of strings' });
      return;
    }

    let deleted = 0;
    let fileErrors = 0;

    for (const eventId of eventIds) {
      try {
        const rows = (await AppDataSource.query('SELECT file_path FROM events WHERE id = $1', [
          eventId,
        ])) as Array<{ file_path: string | null }>;

        if (rows.length === 0) continue;

        await AppDataSource.query('DELETE FROM events WHERE id = $1', [eventId]);
        deleted++;

        const filePath = rows[0].file_path;
        if (filePath) {
          try {
            await fsp.unlink(path.join(config.storage.detectionsDir, filePath));
          } catch {
            fileErrors++;
            logger.warn(`Failed to delete image file for event ${eventId}`, 'EventArchive');
          }
        }

        inMemoryState.removeEvent(eventId);
      } catch {
        logger.warn(`Failed to delete event ${eventId} from database`, 'EventArchive');
      }
    }

    res.json({ success: true, deleted, errors: fileErrors });
  } catch (error) {
    logger.error('Error in bulk archive', 'EventSearch', error);
    res.status(500).json({ success: false, error: 'Failed to archive events' });
  }
});

router.post(
  '/:id/archive',
  requireUser,
  validateParams(
    z.object({
      id: z.string().min(1).max(100),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const eventId = req.params.id;

      const rows = (await AppDataSource.query('SELECT file_path FROM events WHERE id = $1', [
        eventId,
      ])) as Array<{ file_path: string | null }>;

      if (rows.length === 0) {
        res.status(404).json({ success: false, error: 'Event not found' });
        return;
      }

      await AppDataSource.query('DELETE FROM events WHERE id = $1', [eventId]);

      const filePath = rows[0].file_path;
      if (filePath) {
        try {
          await fsp.unlink(path.join(config.storage.detectionsDir, filePath));
        } catch {
          logger.warn(`Failed to delete image file for event ${eventId}`, 'EventArchive');
        }
      }

      inMemoryState.removeEvent(eventId);

      res.json({ success: true, message: 'Event deleted successfully' });
    } catch (error) {
      logger.error(`Error archiving event ${req.params.id}`, 'EventSearch', error);
      res.status(500).json({ success: false, error: 'Failed to archive event' });
    }
  },
);

router.get(
  '/semantic',
  optionalAuth,
  validateQuery(
    z.object({
      q: z.string().min(1).max(500),
      cameraId: z.string().optional(),
      eventType: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  ),
  async (req: Request, res: Response) => {
    try {
      const { q, cameraId, eventType, limit } = req.query as Record<string, string | number>;
      const result = await eventSearchService.semanticSearch(String(q), {
        cameraId: cameraId as string | undefined,
        eventType: eventType as string | undefined,
        limit: limit ? Number(limit) : 20,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Error running semantic search', 'EventSearch', error);
      res.status(500).json({ success: false, error: 'Failed to run semantic search' });
    }
  },
);

export default router;
