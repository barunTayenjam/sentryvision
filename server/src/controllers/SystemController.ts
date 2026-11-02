import { logger } from '../utils/logger.js';
import { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { BaseController } from './BaseController.js';
import { serviceRegistry } from '../services/serviceRegistry.js';
import { serviceLogService } from '../services/serviceLogService.js';
import { inMemoryState } from '../services/inMemoryStateService.js';
import { AutomatedCleanupService } from '../services/automatedCleanupService.js';
import type { Camera } from '../streams/rtspManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SystemController extends BaseController {
  async health(req: Request, res: Response): Promise<void> {
    let db: string;
    try {
      const { AppDataSource } = await import('../database.js');
      await AppDataSource.query('SELECT 1');
      db = 'ok';
    } catch {
      db = 'error';
    }

    let pipeline: string;
    try {
      const pythonWs = serviceRegistry.getPythonWsClient();
      pipeline = pythonWs.connected ? 'connected' : 'disconnected';
    } catch {
      pipeline = 'unavailable';
    }

    try {
      const streamManager = serviceRegistry.getStreamManager();
      const cameras = streamManager.getAllCameras();
      const overallStatus = db === 'ok' && pipeline === 'connected' ? 'ok' : 'degraded';
      res.json({
        status: overallStatus,
        timestamp: new Date().toISOString(),
        activeCameras: cameras.filter((c: Camera) => c.isActive).length,
        db,
        pipeline,
      });
    } catch (error) {
      res.json({
        status: db === 'ok' ? 'degraded' : 'error',
        timestamp: new Date().toISOString(),
        activeCameras: 0,
        db,
        pipeline,
      });
    }
  }

  async stats(req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const { Event } = await import('../models/index.js');

      const eventRepo = AppDataSource.getRepository(Event);
      const totalEvents = await eventRepo.count();

      const streamManager = serviceRegistry.getStreamManager();
      const cameras = streamManager.getAllCameras();
      const activeCameras = cameras.filter((c: Camera) => c.isActive).length;

      let knownVisitors = 0;
      try {
        const visitorResult = await AppDataSource.query(
          'SELECT COUNT(Distinct visitor_id) as count FROM visitor_timeline',
        );
        knownVisitors = parseInt(visitorResult?.[0]?.count) || 0;
      } catch (err) {
        logger.warn('Failed to query visitor count', 'System', err);
      }

      let storageUsed = 0;
      let storageTotal = 0;
      try {
        const { config } = await import('../config/index.js');
        const dbResult = await AppDataSource.query(
          `SELECT COALESCE(SUM(file_size), 0) as total_bytes FROM detection_files WHERE is_deleted = FALSE`,
        );
        storageUsed = parseInt(dbResult[0]?.total_bytes) || 0;
        const fs = await import('node:fs');
        const detectionsPath = config.storage.detectionsDir;
        if (
          (fs as any).existsSync(detectionsPath) &&
          typeof (fs as any).statfsSync === 'function'
        ) {
          const stat = (fs as any).statfsSync(detectionsPath);
          storageTotal = stat.blocks * stat.bsize;
        }
      } catch (err) {
        logger.warn('Failed to query storage stats', 'System', err);
      }
      this.ok(res, {
        stats: {
          totalEvents,
          totalCameras: cameras.length,
          activeCameras,
          knownVisitors,
          storageUsed,
          storageTotal,
        },
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'stats');
    }
  }

  async cleanupImages(req: Request, res: Response): Promise<void> {
    try {
      const retentionDays = parseInt(req.body.retentionDays) || 7;
      if (retentionDays < 1 || retentionDays > 365) {
        this.badRequest(res, 'Retention days must be between 1 and 365');
        return;
      }

      logger.info(`Admin triggered image cleanup with ${retentionDays} days retention`, 'System');
      const cleanupService = AutomatedCleanupService.getInstance();
      const result = await cleanupService.cleanupOldImages(retentionDays);

      res.json({
        success: true,
        message: 'Cleanup complete',
        retentionDays,
        deleted: result.deleted,
        preserved: result.preserved,
        freedBytes: result.freedBytes,
        freedMB: (result.freedBytes / 1024 / 1024).toFixed(2),
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'cleanupImages');
    }
  }

  async runFullCleanup(_req: Request, res: Response): Promise<void> {
    try {
      logger.info('Admin triggered full retention cleanup', 'System');
      const cleanupService = AutomatedCleanupService.getInstance();
      await cleanupService.runAutomaticCleanup();
      res.json({ success: true, message: 'Full cleanup completed' });
    } catch (error: unknown) {
      this.serverError(res, error, 'runFullCleanup');
    }
  }

  async cleanupStatus(_req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const lastCleanup = await AppDataSource.query(
        `SELECT value FROM system_settings WHERE key = 'last_cleanup_timestamp'`,
      );
      const cleanupService = AutomatedCleanupService.getInstance();
      const inProgress = cleanupService.isCleanupInProgress();
      res.json({
        success: true,
        data: {
          lastRun: lastCleanup[0]?.value || null,
          status: inProgress ? 'running' : 'idle',
          nextScheduled: 'Daily at 3:00 AM',
        },
      });
    } catch (error) {
      const cleanupService = AutomatedCleanupService.getInstance();
      const inProgress = cleanupService?.isCleanupInProgress?.() ?? false;
      res.json({
        success: true,
        data: {
          lastRun: null,
          status: inProgress ? 'running' : 'idle',
          nextScheduled: 'Daily at 3:00 AM',
        },
      });
    }
  }

  async overview(req: Request, res: Response): Promise<void> {
    try {
      const streamManager = serviceRegistry.getStreamManager();
      const cameras = streamManager.getAllCameras();

      let storageUsed = 0;
      let storageTotal = 0;
      try {
        const { AppDataSource } = await import('../database.js');
        const { config } = await import('../config/index.js');
        const dbResult = await AppDataSource.query(
          `SELECT COALESCE(SUM(file_size), 0) as total_bytes FROM detection_files WHERE is_deleted = FALSE`,
        );
        storageUsed = parseInt(dbResult[0]?.total_bytes) || 0;
        if (
          fs.existsSync(config.storage.detectionsDir) &&
          typeof (fs as any).statfsSync === 'function'
        ) {
          const stat = (fs as any).statfsSync(config.storage.detectionsDir);
          storageTotal = stat.blocks * stat.bsize;
        }
      } catch (err) {
        logger.warn('Failed to query storage stats in overview', 'System', err);
      }

      // Event counts come from PostgreSQL — the in-memory buffer is empty
      // after a restart, so durable counters must not read from it.
      const { AppDataSource: db } = await import('../database.js');
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const weekAgoStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

      const dbRows = await db.query(
        `SELECT COUNT(*)::int AS total_events,
                COUNT(*) FILTER (WHERE timestamp >= $1::timestamptz AND timestamp < $2::timestamptz) AS today_events
         FROM events
         WHERE timestamp >= $3::timestamptz`,
        [todayStart, new Date(todayStart.getTime() + 24 * 60 * 60 * 1000), weekAgoStart],
      );
      const totalEvents = parseInt(String(dbRows[0]?.total_events)) || 0;
      const todayEvents = parseInt(String(dbRows[0]?.today_events)) || 0;

      const overview = {
        status: 'healthy',
        uptime: process.uptime(),
        totalCameras: cameras.length,
        onlineCameras: cameras.filter((c: Camera) => c.isActive).length,
        totalEvents,
        todayEvents,
        storageUsed,
        storageTotal,
      };

      this.ok(res, { data: overview });
    } catch (error) {
      this.serverError(res, error, 'overview');
    }
  }

  async systemHealth(req: Request, res: Response): Promise<void> {
    try {
      const streamManager = serviceRegistry.getStreamManager();
      const cameras = streamManager.getAllCameras();
      const onlineCameras = cameras.filter((c: Camera) => c.isActive);
      const offlineCameras = cameras.filter((c: Camera) => !c.isActive);

      let status = 'healthy';
      const issues: string[] = [];
      if (offlineCameras.length > 0) {
        status = 'warning';
        issues.push(`${offlineCameras.length} camera(s) offline`);
      }
      if (onlineCameras.length === 0 && cameras.length > 0) {
        status = 'critical';
        issues.push('All cameras offline');
      }

      const uptime = process.uptime();
      if (uptime < 300) issues.push('System recently restarted');

      let dbHealthy = false;
      try {
        const { AppDataSource } = await import('../database.js');
        await AppDataSource.query('SELECT 1');
        dbHealthy = true;
      } catch (err) {
        logger.warn('Database health check failed', 'System', err);
      }
      if (!dbHealthy) issues.push('Database connectivity issue');

      // Event counts come from PostgreSQL — the in-memory buffer is empty
      // after a restart, so durable counters must not read from it.
      const { AppDataSource: db } = await import('../database.js');
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const weekAgoStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
      const dbRows = await db.query(
        `SELECT COUNT(*)::int AS total_events,
                COUNT(*) FILTER (WHERE timestamp >= $1::timestamptz AND timestamp < $2::timestamptz) AS today_events
         FROM events
         WHERE timestamp >= $3::timestamptz`,
        [todayStart, new Date(todayStart.getTime() + 24 * 60 * 60 * 1000), weekAgoStart],
      );
      const totalEvents = parseInt(String(dbRows[0]?.total_events)) || 0;
      const todayEvents = parseInt(String(dbRows[0]?.today_events)) || 0;

      const cpus = os.cpus();
      const loadAvg = os.loadavg();
      const cpuUsage = (loadAvg[0] / cpus.length) * 100;

      let opencvBreakerState = 'unknown';
      try {
        const { getOpenCVClient } = await import('../services/opencvMicroserviceClient.js');
        opencvBreakerState = getOpenCVClient().getBreakerState();
      } catch {
        /* OpenCV client not initialized yet */
      }

      let nvidiaBreakerState = 'unknown';
      try {
        const { getNvidiaBreakerState } = await import(
          '../services/nvidia/nvidiaClient.js'
        );
        nvidiaBreakerState = getNvidiaBreakerState();
      } catch {
        /* NVIDIA client not initialized yet */
      }

      let relationsBreakerState = 'unknown';
      try {
        const { relationsServiceClient } = await import('../services/relationsServiceClient.js');
        relationsBreakerState = relationsServiceClient.getBreakerState();
      } catch {
        /* Relations client not initialized yet */
      }

      let pipelineConnected = true;
      try {
        pipelineConnected = serviceRegistry.getPythonWsClient()?.connected ?? true;
      } catch {
        /* registry not populated yet */
      }

      let disk: { freeBytes: number; totalBytes: number; freePercent: number } | null = null;
      try {
        const { getDiskUsage } = await import('../services/monitorService.js');
        disk = await getDiskUsage(process.env.DETECTIONS_DIR || './data/detections');
      } catch {
        /* disk stats unavailable */
      }

      let relationsQueue: Record<string, number> | null = null;
      try {
        const { AppDataSource } = await import('../database.js');
        const rows = (await AppDataSource.query(
          `SELECT status, count(*)::int AS n,
                  COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::int AS oldest_age_s
           FROM relation_jobs WHERE status IN ('pending', 'processing', 'failed') GROUP BY status`,
        )) as Array<{ status: string; n: number; oldest_age_s: number }>;
        const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
        const oldest = rows
          .filter((r) => r.status === 'pending')
          .reduce((max, r) => Math.max(max, r.oldest_age_s), 0);
        relationsQueue = {
          pending: byStatus.pending ?? 0,
          processing: byStatus.processing ?? 0,
          failed: byStatus.failed ?? 0,
          oldestPendingSeconds: oldest,
        };
      } catch {
        /* queue stats unavailable */
      }

      if (!pipelineConnected) {
        status = 'critical';
        issues.push('Detection pipeline disconnected');
      }
      if (disk && disk.freePercent < 5) {
        status = 'critical';
        issues.push(`Disk space critical (${disk.freePercent}% free)`);
      } else if (disk && disk.freePercent < 15) {
        if (status !== 'critical') status = 'warning';
        issues.push(`Disk space low (${disk.freePercent}% free)`);
      }
      if (relationsQueue && relationsQueue.failed > 0) {
        if (status === 'healthy') status = 'warning';
        issues.push(`${relationsQueue.failed} relation job(s) failed`);
      }

      res.json({
        success: true,
        health: {
          status,
          uptime,
          issues,
          cameras: {
            total: cameras.length,
            online: onlineCameras.length,
            offline: offlineCameras.length,
          },
          memory: {
            used: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
            total: Math.round((process.memoryUsage().heapTotal / 1024 / 1024) * 100) / 100,
            systemTotal: Math.round((os.totalmem() / 1024 / 1024) * 100) / 100,
            systemFree: Math.round((os.freemem() / 1024 / 1024) * 100) / 100,
          },
          cpu: {
            usage: Math.min(100, Math.round(cpuUsage * 100) / 100),
            cores: cpus.length,
            model: cpus[0].model,
            loadAvg: loadAvg,
          },
          circuitBreakers: {
            opencv: opencvBreakerState,
            nvidia: nvidiaBreakerState,
            relations: relationsBreakerState,
          },
          pipeline: {
            pythonWsConnected: pipelineConnected,
          },
          ...(disk ? { disk } : {}),
          ...(relationsQueue ? { relationsQueue } : {}),
          events: {
            recent: totalEvents,
            today: todayEvents,
          },
        },
      });
    } catch (error) {
      this.serverError(res, error, 'systemHealth');
    }
  }

  async getLogs(req: Request, res: Response): Promise<void> {
    try {
      const { service, level, cameraId, since, limit } = req.query;
      const sinceDate = since ? new Date(since as string) : undefined;
      const logs = await serviceLogService.queryLogs({
        service: service as string | undefined,
        level: level as string | undefined,
        cameraId: cameraId as string | undefined,
        since: sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : undefined,
        limit: parseInt(limit as string) || 100,
      });
      this.ok(res, { logs });
    } catch (error) {
      this.serverError(res, error, 'getLogs');
    }
  }

  async clearLogs(req: Request, res: Response): Promise<void> {
    try {
      const days = parseInt(req.query.days as string) || 0;
      const deleted = days
        ? await serviceLogService.purgeOlderThanDays(days)
        : await serviceLogService.purgeOlderThanDays(0);

      const logsDir = path.join(__dirname, '../../logs');
      const errorLogFile = path.join(logsDir, 'error.log');
      const combinedLogFile = path.join(logsDir, 'combined.log');
      const cleared: string[] = [];
      if (fs.existsSync(errorLogFile)) {
        fs.writeFileSync(errorLogFile, '');
        cleared.push('error.log');
      }
      if (fs.existsSync(combinedLogFile)) {
        fs.writeFileSync(combinedLogFile, '');
        cleared.push('combined.log');
      }

      this.ok(res, { message: 'Logs cleared', deleted, cleared });
    } catch (error) {
      this.serverError(res, error, 'clearLogs');
    }
  }
}

export const systemController = new SystemController();
