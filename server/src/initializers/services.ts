import { Server as SocketIOServer } from 'socket.io';
import { logger } from '../utils/logger.js';
import { AppDataSource } from '../database.js';
import { applyPendingMigrations } from '../database/applyMigrations.js';
import { setCameras, loadCamerasFromFile } from '../config/cameraLoader.js';
import { config, type CameraConfig } from '../config/index.js';
import { setupRTSPStreams } from '../streams/rtspManager.js';
import { consolidatedDetectionService } from '../detection/consolidatedDetectionService.js';
import { TimelineService } from '../services/timeline/timelineService.js';
import { DetectionService } from '../services/detection/detectionService.js';
import { TimelapseService } from '../services/timelapse/timelapseService.js';
import { setTimelapseService } from '../routes/timelapse.js';
import { retentionPolicyService } from '../services/retentionPolicyService.js';
import { automatedCleanupService } from '../services/automatedCleanupService.js';
import NotificationService from '../services/notificationService.js';
import { serviceRegistry } from '../services/serviceRegistry.js';
import { serviceLogService } from '../services/serviceLogService.js';
import { inMemoryState } from '../services/inMemoryStateService.js';
import { PythonWsClient, TrackingEvent } from '../services/pythonWsClient.js';
import { persistDetectionEvent } from '../pipeline/detectionPersistence.js';
import { SceneTracker } from '../pipeline/sceneTracker.js';
import { BroadcastGate } from '../pipeline/broadcastGate.js';
import { initMqttService } from '../services/mqttService.js';
import { TrackDeduplicator } from '../pipeline/trackDeduplicator.js';
import { Timeline } from '../models/Timeline.js';
import { AdaptiveRegion } from '../models/AdaptiveRegion.js';
import { DetectionConfig } from '../models/DetectionConfig.js';
import { startRelationQueueWorker } from '../services/relationQueue.js';
import { HumanVerification } from '../models/HumanVerification.js';

async function recordFailedVerification(ev: TrackingEvent): Promise<void> {
  const hv = ev.humanVerification!;
  const repo = AppDataSource.getRepository(HumanVerification);
  await repo.insert({
    cameraId: ev.cameraId!,
    trackId: String(ev.trackId),
    verified: false,
    tier: hv.tier,
    keypoints: hv.keypoints ?? 0,
    faceDetected: hv.face_detected ?? false,
    yoloScore: hv.yolo_score ?? ev.score ?? 0,
    roiWidth: hv.roi_w ?? 0,
    roiHeight: hv.roi_h ?? 0,
    elapsedMs: hv.elapsed_ms ?? 0,
  });
}

export async function initializeServices(io: SocketIOServer): Promise<void> {
  serviceRegistry.setAppDataSource(AppDataSource);
  serviceRegistry.setDetectionService(consolidatedDetectionService);

  // initdb scripts only run on an EMPTY volume — an existing deployment
  // never sees new migrations unless they are applied here, at boot.
  try {
    const { applied } = await applyPendingMigrations(AppDataSource);
    if (applied.length > 0) {
      logger.info(`Applied ${applied.length} pending migrations at boot: ${applied.join(', ')}`, 'INIT');
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Boot migrations failed — schema may be behind: ${msg}`, 'INIT');
  }

  try {
    await consolidatedDetectionService.loadSettingsFromDb();
    logger.info('Detection settings loaded from database', 'INIT');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not load detection settings from DB: ${msg}`, 'INIT');
  }

  try {
    await inMemoryState.loadAlertsFromDb();
    logger.info('Alerts loaded from database', 'INIT');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not load alerts from DB: ${msg}`, 'INIT');
  }

  try {
    logger.info('Initializing Python WebSocket client...', 'INIT');
    const pythonWsClient = new PythonWsClient(config.pipeline.pythonWsUrl);
    pythonWsClient.connect();
    serviceRegistry.setPythonWsClient(pythonWsClient);

    const sceneTracker = new SceneTracker();
    const broadcastGate = new BroadcastGate();
    const trackDeduplicator = new TrackDeduplicator();

    pythonWsClient.on(
      'logEvent',
      (ev: {
        level: string;
        module?: string;
        message?: string;
        cameraId?: string;
        metadata?: Record<string, unknown>;
      }) => {
        const level = ev.level === 'error' ? 'error' : ev.level === 'info' ? 'info' : 'warn';
        serviceLogService.recordLog({
          service: 'opencv',
          level,
          module: ev.module,
          cameraId: ev.cameraId ?? undefined,
          message: ev.message ?? '',
          metadata: ev.metadata,
        });
      },
    );

    pythonWsClient.on('trackingEvent', (ev: TrackingEvent) => {
      const {
        cameraId,
        event: eventType,
        trackId,
        class: className,
        score,
        bbox,
        identity,
        identityConfidence,
      } = ev;
      if (!cameraId) return;

      if (eventType === 'track_ended') {
        sceneTracker.clearTrack(cameraId, trackId);
        return;
      }

      sceneTracker.track(ev);

      if (broadcastGate.shouldBroadcast(ev)) {
        const detection = broadcastGate.createDetection(ev);

        if (className === 'person') {
          io.emit('personDetected', {
            cameraId,
            timestamp: new Date(ev.timestamp).toISOString(),
            persons: [detection],
            trackId,
          });
        }

        if (identity && identity !== 'unknown') {
          io.emit('faceDetected', {
            cameraId,
            timestamp: new Date(ev.timestamp).toISOString(),
            faces: [
              {
                id: `track_${trackId}`,
                name: identity,
                confidence: identityConfidence ?? 0,
                bbox: detection.bbox,
              },
            ],
          });
        }

        io.to(`camera-${cameraId}-live`).emit('detection', {
          cameraId,
          detections: [detection],
          timestamp: new Date(ev.timestamp).toISOString(),
        });
      }

      // HumanVerifier fails never reach persistence (no event row, and the
      // deduplicator drops filePath-less persons before persistence), so they
      // left no audit trail at all — all-time human_verifications rows were
      // 100% verified=true. Record the fail here instead: the row is what makes
      // the verifier tunable.
      if (className === 'person' && ev.humanVerification?.verified === false) {
        recordFailedVerification(ev).catch((err: unknown) => {
          logger.warn(
            `Failed to record verification failure for ${cameraId}`,
            'INIT',
            err,
          );
        });
      }

      if (trackDeduplicator.shouldPersist(ev)) {
        trackDeduplicator.markPersisted(ev);
        persistDetectionEvent(ev, sceneTracker.snapshot(cameraId)).catch((err: unknown) => {
          logger.error(`Failed to persist detection event for ${cameraId}`, 'INIT', err);
        });
      }

      if (eventType === 'track_started' && broadcastGate.isBroadcastWorthy(score)) {
        io.emit('motionDetected', {
          id: `track_${trackId}_${Date.now()}`,
          cameraId,
          timestamp: new Date(ev.timestamp).toISOString(),
          confidence: Math.round((score ?? 0) * 100),
          labels: [className],
          detections: [
            {
              class: className,
              confidence: Math.round((score ?? 0) * 100),
              bbox: { x: bbox[0] ?? 0, y: bbox[1] ?? 0, width: bbox[2] ?? 0, height: bbox[3] ?? 0 },
              trackId,
            },
          ],
          trackId,
        });
      }
    });

    pythonWsClient.on('connected', () => {
      logger.info('Python WebSocket client connected', 'PythonWsClient');
      config.cameras.forEach((cam: CameraConfig) => pythonWsClient.subscribe(cam.id));
    });

    pythonWsClient.on('disconnected', () => {
      logger.warn('Disconnected from Python WebSocket server', 'PythonWsClient');
    });

    logger.info('Python WebSocket client initialized successfully', 'INIT');
  } catch (error) {
    logger.error('FATAL: Python WebSocket client initialization failed', 'INIT', error);
    process.exit(1);
  }

  let cameras: CameraConfig[] = [];

  try {
    const dbRows = await AppDataSource.query(
      'SELECT id, name, config, enabled FROM cameras ORDER BY created_at',
    );
    if (dbRows.length > 0) {
      cameras = dbRows.map((row: any) => {
        const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
        return { ...cfg, enabled: row.enabled };
      });
      logger.info(`Loaded ${cameras.length} cameras from database`, 'INIT');
    }
  } catch (error) {
    logger.warn(`Failed to load cameras from database: ${error}`, 'INIT');
  }

  if (cameras.length === 0) {
    cameras = loadCamerasFromFile();
    if (cameras.length > 0) {
      logger.info(
        `Loaded ${cameras.length} cameras from cameras.json (first-time bootstrap)`,
        'INIT',
      );
      try {
        for (const cam of cameras) {
          await AppDataSource.query(
            'INSERT INTO cameras (id, name, config, enabled) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (id) DO UPDATE SET name = $2, config = $3::jsonb, enabled = $4',
            [cam.id, cam.name, JSON.stringify(cam), cam.enabled !== false],
          );
        }
        logger.info('Bootstrapped cameras.json cameras into database', 'INIT');
      } catch (error) {
        logger.warn(`Failed to seed cameras to database: ${error}`, 'INIT');
      }
    }
  }

  setCameras(cameras);

  try {
    logger.info('Initializing stream manager...', 'INIT');
    const streamManagerInstance = await setupRTSPStreams(io, cameras);
    serviceRegistry.setStreamManager(streamManagerInstance);
    NotificationService.loadCameraNames(streamManagerInstance);
    logger.info('Stream manager initialized successfully', 'INIT');
  } catch (error) {
    logger.error('FATAL: Stream manager initialization failed', 'INIT', error);
    process.exit(1);
  }

  try {
    logger.info('Initializing timeline and detection services...', 'INIT');
    const timelineRepo = AppDataSource.getRepository(Timeline);
    const regionRepo = AppDataSource.getRepository(AdaptiveRegion);

    const timelineServiceInstance = new TimelineService(timelineRepo, regionRepo);
    const timelapseServiceInstance = new TimelapseService();
    setTimelapseService(timelapseServiceInstance);
    const detectionServiceInstance = new DetectionService();

    serviceRegistry.setTimelineService(timelineServiceInstance);
    serviceRegistry.setTimelapseService(timelapseServiceInstance);
    serviceRegistry.setDetectionConfigService(detectionServiceInstance);
    logger.info(
      'Timeline, timelapse and detection services initialized successfully',
      'INIT',
    );
  } catch (error) {
    logger.error('Timeline/detection services failed (non-critical)', 'INIT', error);
  }

  try {
    logger.info('Initializing notification service...', 'INIT');
    await NotificationService.initialize();
    serviceRegistry.setNotificationService(NotificationService);
    logger.info('Notification service initialized successfully', 'INIT');
  } catch (error) {
    logger.error('Notification service failed (non-critical)', 'INIT', error);
  }

  try {
    logger.info('Initializing cleanup services...', 'INIT');
    await retentionPolicyService.initialize();
    await automatedCleanupService.initialize();
    serviceRegistry.setRetentionPolicyService(retentionPolicyService);
    serviceRegistry.setAutomatedCleanupService(automatedCleanupService);
    logger.info('Cleanup services initialized successfully', 'INIT');
  } catch (error) {
    logger.error('Cleanup services failed (non-critical)', 'INIT', error);
  }

  try {
    startRelationQueueWorker();
    logger.info('Relation queue worker started', 'INIT');
  } catch (error) {
    logger.error('Relation queue worker failed to start (non-critical)', 'INIT', error);
  }

  if (config.mqtt.enabled) {
    try {
      const mqttService = initMqttService({
        enabled: Boolean(config.mqtt.enabled),
        host: config.mqtt.host,
        port: config.mqtt.port ?? 1883,
        topicPrefix: config.mqtt.topicPrefix ?? 'sentryvision',
        user: config.mqtt.user,
        password: config.mqtt.password,
        qos: (config.mqtt.qos ?? 0) as 0 | 1 | 2,
      });
      const cameraIds = config.cameras.map((c: CameraConfig) => c.id);
      mqttService.publishHADiscovery(cameraIds);
      for (const cam of config.cameras) {
        mqttService.publishPersonState(cam.id, false);
        mqttService.publishCameraStatus(cam.id, 'online');
      }
      logger.info(`MQTT publisher started (${cameraIds.length} cameras discovered)`, 'INIT');
    } catch (error) {
      logger.error('MQTT publisher failed to start (non-critical)', 'INIT', error);
    }
  }
}
