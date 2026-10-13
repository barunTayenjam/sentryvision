import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from './utils/logger.js';
import { config, validateConfig } from './config/index.js';
import { initializeDb, shutdownDb } from './initializers/database.js';
import { initializeServices as initAllServices } from './initializers/services.js';
import { initializeCron } from './initializers/cron.js';
import { serviceRegistry } from './services/serviceRegistry.js';
import { serviceLogService } from './services/serviceLogService.js';
import { inMemoryState } from './services/inMemoryStateService.js';
import { shutdownMqttService } from './services/mqttService.js';
import { AppDataSource } from './database.js';
import authService from './auth/index.js';

let isShuttingDown = false;

export async function initializeServices(io: SocketIOServer): Promise<void> {
  try {
    validateConfig();
  } catch (error) {
    logger.error('FATAL: Configuration validation failed', 'BOOTSTRAP', error);
    process.exit(1);
  }

  // --- Initialize Database ---
  await initializeDb();

  // --- Seed users if needed ---
  if (config.nodeEnv === 'production') {
    const missing: string[] = [];
    if (!process.env.SEED_ADMIN_PASSWORD) missing.push('SEED_ADMIN_PASSWORD');
    if (!process.env.SEED_USER_PASSWORD) missing.push('SEED_USER_PASSWORD');
    if (missing.length > 0) {
      logger.error(
        'FATAL: Required environment variables not set: ' +
          missing.join(', ') +
          '. Set these before starting in production.',
        'BOOTSTRAP',
      );
      process.exit(1);
    }
  }
  try {
    await authService.register({
      username: 'barun',
      email: 'barun@security.local',
      password: process.env.SEED_ADMIN_PASSWORD!,
      role: 'admin',
    });
    await authService.register({
      username: 'user',
      email: 'user@security.local',
      password: process.env.SEED_USER_PASSWORD!,
      role: 'user',
    });
  } catch (err) {
    logger.debug('Seed user registration failed (duplicates expected)', 'BOOTSTRAP', err);
  }

  // Auto-import disk detections on restart so events survive volume wipes.
  // Skip when the DB already has events (normal restart) to keep boot fast.
  try {
    const [{ count }] = await AppDataSource.query('SELECT COUNT(*) AS count FROM events');
    if (Number(count) > 0) {
      logger.info(`Skipping event re-import (${count} events already in DB)`, 'BOOTSTRAP');
    } else {
      const { exec } = await import('node:child_process');
      exec('python3 /app/import-events.py', (err) => {
        if (err) logger.warn('Background event re-import failed', 'BOOTSTRAP');
        else logger.info('Event re-import completed', 'BOOTSTRAP');
      });
    }
  } catch (err) {
    logger.debug('Background event re-import check failed', 'BOOTSTRAP', err);
  }

  // --- Initialize Services (including setting up serviceRegistry & PythonWsClient) ---
  await initAllServices(io);
  await inMemoryState.startPeriodicRefresh();

  // --- Initialize Cron Jobs ---
  await initializeCron(io);

  logger.info('All systems successfully bootstrapped.', 'BOOTSTRAP');
}

export async function gracefulShutdown(
  signal: string,
  server: http.Server,
  io: SocketIOServer,
): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}. Shutting down gracefully...`, 'BOOTSTRAP');
  const shutdownTimeout = setTimeout(() => {
    logger.error('Forced shutdown after 10s timeout', 'BOOTSTRAP');
    process.exit(1);
  }, 10000);

  try {
    const streamManager = serviceRegistry.getStreamManager();
    if (streamManager) streamManager.shutdown();

    const detectionService = serviceRegistry.getDetectionService();
    if (detectionService && typeof detectionService.cleanup === 'function') {
      await detectionService.cleanup();
    }

    const cleanupService = serviceRegistry.getAutomatedCleanupService();
    if (cleanupService && typeof cleanupService.shutdown === 'function') {
      await cleanupService.shutdown();
    }
    inMemoryState.stopPeriodicRefresh();

    try {
      const pythonWsClient = serviceRegistry.getPythonWsClient();
      if (pythonWsClient) {
        pythonWsClient.disconnect();
        logger.info('Python WebSocket client disconnected', 'BOOTSTRAP');
      }
    } catch (err) {
      logger.debug('Python WS client shutdown failed (may not be initialized)', 'BOOTSTRAP', err);
    }

    try {
      const timelapseService = serviceRegistry.getTimelapseService();
      if (timelapseService) timelapseService.shutdown();
      logger.info('Timelapse service shut down', 'BOOTSTRAP');
    } catch (err) {
      logger.debug('Timelapse service shutdown skipped (may not be initialized)', 'BOOTSTRAP', err);
    }

    try {
      shutdownMqttService();
      logger.info('MQTT service shut down', 'BOOTSTRAP');
    } catch (err) {
      logger.debug('MQTT shutdown skipped (may not be initialized)', 'BOOTSTRAP', err);
    }

    await serviceLogService.shutdown();

    io.disconnectSockets(true);
    io.close();

    await shutdownDb();

    server.close(() => {
      clearTimeout(shutdownTimeout);
      logger.info('Server closed', 'BOOTSTRAP');
      process.exit(0);
    });
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error('Error during shutdown', 'BOOTSTRAP', error);
    process.exit(1);
  }
}
