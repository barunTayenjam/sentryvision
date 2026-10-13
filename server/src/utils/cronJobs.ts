import { logger } from './logger.js';
import cron from 'node-cron';
import { serviceLogService } from '../services/serviceLogService.js';
import { Server as SocketIOServer } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getDetectionsPath, getEventPath, getArchivePath } from '../config/paths.js';
import { TimelapseService } from '../services/timelapse/timelapseService.js';
import { serviceRegistry } from '../services/serviceRegistry.js';
import NotificationService from '../services/notificationService.js';
import { sampleAllCalmCameras } from '../services/sceneMemoryService.js';
import { AppDataSource } from '../database.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

interface MotionEvent {
  id: string;
  cameraId: string;
  timestamp: string;
  imagePath: string;
  confidence: number;
  duration: number;
}

// Generate daily report with visitor statistics and snapshots
async function generateDailyReport(io: SocketIOServer) {
  // Daily report log disabled - console.log('Generating daily report...');

  try {
    // Get the stream manager from the service registry
    const streamManager = serviceRegistry.getStreamManager();

    let eventsLast24Hours: MotionEvent[] = [];
    try {
      const rows = await AppDataSource.query(
        `SELECT id, camera_id, timestamp, file_path, confidence
         FROM events
         WHERE timestamp > NOW() - INTERVAL '24 hours'
         ORDER BY timestamp DESC`,
      );
      eventsLast24Hours = (rows || []).map((row: any) => ({
        id: row.id,
        cameraId: row.camera_id,
        timestamp: row.timestamp,
        imagePath: row.file_path,
        confidence: row.confidence || 0,
        duration: 0,
      }));
    } catch (dbError) {
      logger.warn(`Failed to query recent events for daily report: ${dbError}`, 'Cron');
    }

    // Group events by camera
    const eventsByCamera = eventsLast24Hours.reduce(
      (acc, event) => {
        if (!acc[event.cameraId]) {
          acc[event.cameraId] = [];
        }
        acc[event.cameraId].push(event);
        return acc;
      },
      {} as Record<string, MotionEvent[]>,
    );

    // Generate statistics
    const totalEvents = eventsLast24Hours.length;
    const cameraStats = Object.entries(eventsByCamera).map(([cameraId, events]) => ({
      cameraId,
      eventCount: events.length,
      firstEvent: events[events.length - 1]?.timestamp,
      lastEvent: events[0]?.timestamp,
    }));

    // Get camera names
    const cameras = streamManager.getAllCameras();
    const cameraNames = cameras.reduce(
      (acc: Record<string, string>, cam: { id: string; name: string }) => {
        acc[cam.id] = cam.name;
        return acc;
      },
      {} as Record<string, string>,
    );

    // In a real implementation, this would generate an email report
    // For this simplified version, we'll just emit an event with the report data
    const reportData = {
      date: new Date().toLocaleDateString(),
      totalEvents,
      cameraStats,
      eventsByCamera: Object.entries(eventsByCamera).map(([cameraId, events]) => ({
        cameraId,
        cameraName: cameraNames[cameraId] || cameraId,
        events: events.slice(0, 5).map((event) => ({
          id: event.id,
          timestamp: event.timestamp,
          imagePath: event.imagePath,
          confidence: event.confidence,
        })),
      })),
    };

    // Emit the report to connected clients
    io.emit('dailyReport', { success: true, report: reportData });

    // Daily report success log disabled - console.log('Daily report generated successfully');
    return {
      success: true,
      report: reportData,
    };
  } catch (error) {
    // Daily report error log disabled - console.error('Error generating daily report:', error);
    return {
      success: false,
      error: 'Failed to generate daily report',
    };
  }
}

// Start scheduled tasks
export function startCronJobs(io: SocketIOServer) {
  // Schedule daily report at 8:00 AM every day
  cron.schedule('0 8 * * *', async () => {
    // Cron job log disabled - console.log('Running daily report job');
    await generateDailyReport(io);
    try {
      const { persistAndPushDigest } = await import(
        '../services/chat/dailyDigestService.js'
      );
      const result = await persistAndPushDigest();
      logger.info(
        `Daily digest: persisted=${result.persisted} pushed=${result.pushed} failed=${result.failed}`,
        'Cron',
      );
    } catch (err) {
      logger.error(`Daily digest generation failed: ${err}`, 'Cron');
    }
  });

  // Schedule cleanup of old snapshots and events (keep last 30 days)
  cron.schedule('0 3 * * *', () => {
    // Cleanup job log disabled - console.log('Running cleanup job');
    cleanupOldFiles();
    void serviceLogService
      .purgeOlderThanDays(parseInt(process.env.SERVICE_LOG_RETENTION_DAYS || '14', 10))
      .then((deleted) => {
        if (deleted > 0) logger.info(`Purged ${deleted} old service_logs rows`, 'CLEANUP');
      })
      .catch(() => {});
  });

  // Stitch yesterday's raw timelapse frames into MP4s at 00:01 daily
  cron.schedule('1 0 * * *', async () => {
    try {
      const timelapseService = serviceRegistry.getTimelapseService();
      const results = await timelapseService.stitchYesterday();
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok && r.error !== 'No raw frames captured');
      logger.info(
        `Nightly stitch: ${ok}/${results.length} cameras ok, ${failed.length} failures`,
        'Cron',
      );
      if (failed.length > 0) {
        logger.warn(`Stitch failures: ${JSON.stringify(failed)}`, 'Cron');
      }
    } catch (err) {
      logger.error(`Nightly timelapse stitch failed: ${err}`, 'Cron');
    }
  });

  // Delete timelapse files older than 30 days at 00:30
  cron.schedule('30 0 * * *', async () => {
    try {
      const timelapseService = serviceRegistry.getTimelapseService();
      const deleted = await timelapseService.cleanupOldFiles(30);
      logger.info(`Timelapse cleanup removed ${deleted} files`, 'Cron');
    } catch (err) {
      logger.error(`Timelapse cleanup failed: ${err}`, 'Cron');
    }
  });
  cron.schedule('*/30 * * * *', () => {
    // Every 30 minutes
    // Health check log disabled - console.log('Running camera health check');
    checkCameraHealth(io);
  });

  // Expired subscription cleanup daily at 3:00 AM
  cron.schedule('0 3 * * *', async () => {
    try {
      await NotificationService.cleanupExpiredSubscriptions();
      logger.info('Expired subscription cleanup completed', 'Cron');
    } catch (error) {
      logger.error('Expired subscription cleanup failed:', 'Cron', error);
    }
  });

  // Scene memory sampling every 15 min (service gates: night window, load, camera calm)
  cron.schedule('*/15 * * * *', async () => {
    try {
      await sampleAllCalmCameras();
    } catch (error) {
      logger.error(`Scene memory sampling failed: ${error}`, 'Cron');
    }
  });

  // System monitor every 5 min: disk space, pipeline connectivity, relation
  // queue failures, external heartbeat ping — alerts via web push
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runMonitorChecks } = await import('../services/monitorService.js');
      const result = await runMonitorChecks(
        process.env.DETECTIONS_DIR || './data/detections',
      );
      logger.debug(
        `Monitor: disk=${result.disk ? result.disk.freePercent + '%' : 'n/a'} pipeline=${result.pipelineConnected ? 'up' : 'DOWN'} failedJobs=${result.failedJobs}`,
        'Cron',
      );
    } catch (error) {
      logger.error(`System monitor check failed: ${error}`, 'Cron');
    }
  });

  // Scheduled tasks log disabled - console.log('Scheduled tasks started');
}

// Run expired subscription cleanup on startup
export async function runStartupCleanup(): Promise<void> {
  try {
    const cleaned = await NotificationService.cleanupExpiredSubscriptions();
    logger.info(`Startup cleanup removed ${cleaned} expired subscriptions`, 'Cron');
  } catch (error) {
    logger.error('Startup cleanup failed:', 'Cron', error);
  }
}

// Start the live frame sampler and stitch any past days whose raws weren't processed
export async function runStartupTimelapseCatchup(): Promise<void> {
  try {
    const timelapseService = serviceRegistry.getTimelapseService();
    timelapseService.startSampler();

    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    const results = await timelapseService.stitchDate(yesterday);
    const stitched = results.filter((r) => r.ok && r.count > 0).length;
    if (stitched > 0) {
      logger.info(`Startup catchup stitched ${stitched} cameras for ${yesterday}`, 'Cron');
    }
  } catch (error) {
    logger.error('Startup timelapse catchup failed:', 'Cron', error);
  }
}

// Clean up old snapshots and event images using database
async function cleanupOldFiles() {
  try {
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
    const now = Date.now();

    // Import database dynamically
    const { getBatchProcessingDatabase } =
      await import('../services/batchProcessingDatabasePostgres.js');
    const db = await getBatchProcessingDatabase();

    if (!db) {
      logger.warn('Database not available for cleanup', 'Cron');
      return;
    }

    // Mark files as archived in database
    await (db as any).dataSource.query(
      `UPDATE detection_files
       SET is_archived = true
       WHERE created_at < NOW() - INTERVAL '30 days'
         AND is_archived = false
         AND is_deleted = false`,
    );

    // Get archived files for filesystem cleanup
    const archivedFiles = await (db as any).dataSource.query(
      `SELECT file_uuid, storage_path, created_at
       FROM events
       WHERE is_archived = true
         AND is_deleted = false
       LIMIT 10000`,
    );

    // Move files to archive
    for (const file of archivedFiles) {
      try {
        const createdDate = new Date(file.created_at);
        const archivePath = getArchivePath(createdDate);

        // Create archive directory if needed
        await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });

        // Move file to archive
        await fs.promises.rename(file.storage_path, archivePath);

        // Update storage_path in database
        await (db as any).dataSource.query(
          `UPDATE detection_files
           SET storage_path = $1
           WHERE file_uuid = $2`,
          [archivePath, file.file_uuid],
        );
      } catch (err) {
        logger.error(`Error archiving file ${file.file_uuid}`, 'Cron', err);
      }
    }

    // Cleanup completion log disabled
    logger.info(`Archived ${archivedFiles.length} files`, 'Cron');
  } catch (error) {
    // Cleanup error log disabled
    logger.error('Error cleaning up old files', 'Cron', error);
  }
}

// Check camera health and restart if needed
function checkCameraHealth(io: SocketIOServer) {
  try {
    const streamManager = serviceRegistry.getStreamManager();

    const cameras = streamManager.getAllCameras();
    // Camera health check log disabled - console.log(`Checking health of ${cameras.length} cameras`);

    // Check each camera
    cameras.forEach((camera: { id: string; name: string; isActive: boolean }) => {
      // Camera status log disabled - console.log(`Camera health check: Camera ${camera.id} is active: ${camera.isActive}`); // Added logging
      if (camera.isActive) {
        // Camera active log disabled - console.log(`Camera ${camera.id} (${camera.name}) is active`);
      } else {
        // Camera inactive log disabled - console.log(`Camera ${camera.id} (${camera.name}) is inactive, attempting to start test stream`);
        streamManager.startStream(camera.id, 'detect');
      }
    });

    // Emit system status update
    io.emit('systemStatus', {
      status: 'healthy',
      uptime: process.uptime(),
      totalCameras: cameras.length,
      activeCameras: cameras.filter((c: { isActive: boolean }) => c.isActive).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Health check error log disabled - console.error('Error checking camera health:', error);
  }
}
