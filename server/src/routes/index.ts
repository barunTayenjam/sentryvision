import { Express, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { createApiRateLimit } from '../middleware/enhancedRateLimit.js';
import { requireUser, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { serviceRegistry } from '../services/serviceRegistry.js';
import { streamController } from '../controllers/StreamController.js';
import { systemController } from '../controllers/SystemController.js';
import { detectionImageController } from '../controllers/DetectionImageController.js';

import authRoutes from './auth.js';
import cameraRoutes from './cameras.js';
import streamRoutes from './streams.js';
import analyticsRoutes from './analytics.js';
import settingsRoutes from './settings.js';
import nvidiaRoutes from './nvidiaRoutes.js';
import motionRoutes from './motion.js';
import eventSearchRoutes from './event-search.js';
import detectionDataRoutes from './detectionData.js';
import eventRoutes from './events.js';
import alertRoutes from './alerts.js';
import notificationRoutes from './notificationRoutes.js';
import detectionOperationsRoutes from './detection-operations.js';
import detectionRoutes from './detectionRoutes.js';
import detectionRedoRoutes from './detectionRedoRoutes.js';
import highlightsRoutes from './highlights.js';
import timelapseRoutes, { setTimelapseService } from './timelapse.js';
import faceClusterRoutes from './face-clusters.js';
import faceIdentityRoutes from './face-identities.js';
import chatRoutes from './chat.js';
import digestRoutes from './digests.js';
import { reembedEvents } from '../services/eventSearch/sceneEmbeddingService.js';
import { AppDataSource } from '../database.js';
import { enrollFace } from '../services/faces/faceEnrollmentService.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CAMERA_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateCameraId(cameraId: string): boolean {
  return CAMERA_ID_PATTERN.test(cameraId) && cameraId.length <= 100;
}

function validateCameraIdParam(cameraId: string, res: Response): boolean {
  if (!cameraId || !validateCameraId(cameraId)) {
    res.status(400).json({ success: false, error: 'Invalid camera ID format' });
    return false;
  }
  return true;
}

logger.info('Configuring main API routes', 'ROUTES');

export function configureRoutes(app: Express, io: SocketIOServer) {
  // Store io on app for route files that need it
  app.set('io', io);

  // Global API rate limit must be mounted BEFORE any /api route — Express
  // runs middleware in registration order, so a limiter mounted after the
  // routers never executes.
  app.use(createApiRateLimit());

  // Controller-delegated routes (unique paths that can't be grouped under /api prefix)
  app.get('/api/streaming/metrics', optionalAuth, (req, res) =>
    streamController.getMetrics(req, res),
  );
  app.get('/snapshot/:cameraId.jpg', optionalAuth, (req, res) =>
    streamController.getSnapshot(req, res),
  );
  app.get('/stream/:cameraId/test', optionalAuth, (req, res) =>
    streamController.getMjpegStream(req, res),
  );
  app.get('/stream/:cameraId', optionalAuth, (req, res) =>
    streamController.getMjpegStream(req, res),
  );

  // System routes
  app.get('/api/health', (req, res) => systemController.health(req, res));
  app.get('/api/stats', optionalAuth, (req, res) => systemController.stats(req, res));
  app.get('/api/system/overview', requireUser, (req, res) => systemController.overview(req, res));
  app.get('/api/system/health', optionalAuth, (req, res) =>
    systemController.systemHealth(req, res),
  );
  app.get('/api/system/logs', requireUser, (req, res) => systemController.getLogs(req, res));
  app.delete('/api/system/logs', requireAdmin, (req, res) => systemController.clearLogs(req, res));
  app.post('/api/maintenance/cleanup-images', requireAdmin, (req, res) =>
    systemController.cleanupImages(req, res),
  );
  app.post('/api/maintenance/cleanup-full', requireAdmin, (req, res) =>
    systemController.runFullCleanup(req, res),
  );
  app.get('/api/maintenance/cleanup-status', requireAdmin, (req, res) =>
    systemController.cleanupStatus(req, res),
  );
  app.post('/api/maintenance/reindex-embeddings', requireAdmin, async (req, res) => {
    try {
      const batch = Math.min(Math.max(parseInt(String(req.body?.batch ?? 200), 10) || 200, 1), 1000);
      const remaining = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM events WHERE scene_embedding IS NULL OR scene_caption IS NULL`,
      );
      const done = await reembedEvents(batch);
      const after = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM events WHERE scene_embedding IS NULL OR scene_caption IS NULL`,
      );
      res.json({
        success: true,
        embedded: done,
        batch,
        remainingBefore: remaining[0]?.n ?? 0,
        remainingAfter: after[0]?.n ?? 0,
      });
    } catch (error) {
      logger.error('Failed to reindex embeddings', 'Maintenance', error);
      res.status(500).json({ success: false, error: 'Failed to reindex embeddings' });
    }
  });
  app.post(
    '/api/faces/enroll-from-event/:eventId',
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const { eventId } = req.params;
        const { name } = req.body;
        if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
          res.status(400).json({ success: false, error: 'Name is required (1-100 chars)' });
          return;
        }
        const rows = await AppDataSource.query(
          `SELECT COALESCE(df.storage_path, e.file_path) AS path
           FROM events e
           LEFT JOIN detection_files df ON e.file_path = df.storage_path OR e.file_path LIKE '%' || df.original_filename
           WHERE (e.id = $1 OR df.file_uuid = $1) ORDER BY COALESCE(df.created_at, e.created_at) DESC LIMIT 1`,
          [eventId],
        );
        const imagePath = rows[0]?.path;
        if (!imagePath) {
          res.status(404).json({ success: false, error: 'Event image not found' });
          return;
        }
        const absPath = path.isAbsolute(imagePath)
          ? imagePath
          : join(process.cwd(), 'data', 'detections', imagePath);
        if (!fs.existsSync(absPath)) {
          res.status(404).json({ success: false, error: 'Event image not found on disk' });
          return;
        }
        const result = await enrollFace(readFileSync(absPath), name.trim());
        res.json(result);
      } catch (error) {
        logger.error('Failed to enroll face from event', 'Faces', error);
        res.status(500).json({ success: false, error: 'Failed to enroll face' });
      }
    },
  );

  // Detection image with overlays
  app.get('/detections/image/:imageId', optionalAuth, (req: Request, res: Response) =>
    detectionImageController.getImageWithOverlay(req, res),
  );

  // Snapshots list
  app.get('/api/snapshots/list', optionalAuth, (req: Request, res: Response) =>
    detectionImageController.listSnapshots(req, res),
  );

  // Domain routers
  app.use('/api/auth', authRoutes);
  app.use('/api/cameras', cameraRoutes);
  app.use('/api/streams', streamRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/detection-data', detectionDataRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/nvidia', nvidiaRoutes);
  app.use('/api/motion', motionRoutes);
  app.use('/api/events', eventSearchRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/detection', detectionOperationsRoutes);
  app.use('/api/detection', detectionRoutes);
  app.use('/api/detection-redo', detectionRedoRoutes);
  app.use('/api/highlights', highlightsRoutes);
  app.use('/api/timelapse', timelapseRoutes);
  app.use('/api/face-clusters', faceClusterRoutes);
  app.use('/api/face-identities', faceIdentityRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/digests', digestRoutes);
}
