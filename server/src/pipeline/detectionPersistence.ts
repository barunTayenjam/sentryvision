import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Event } from '../models/Event.js';
import { EventDetection } from '../models/EventDetection.js';
import { HumanVerification } from '../models/HumanVerification.js';
import { AppDataSource } from '../database.js';
import { serviceRegistry } from '../services/serviceRegistry.js';
import { getEventPath } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import { TrackingEvent } from '../services/pythonWsClient.js';
import NotificationService from '../services/notificationService.js';
import { VEHICLE_CLASSES } from '../shared/constants.js';
import { isSceneMemoryEnabled, compareEventToBaseline } from '../services/sceneMemoryService.js';
import { enqueueRelationJob } from '../services/relationQueue.js';
import { getMqttService } from '../services/mqttService.js';

function emitMqttEvent(cameraId: string, eventId: string, eventType: string, score: number) {
  try {
    getMqttService()?.publishEvent(cameraId, {
      id: eventId,
      camera: cameraId,
      type: eventType,
      confidence: score,
      timestamp: new Date().toISOString(),
    });
    if (eventType === 'person') getMqttService()?.publishPersonState(cameraId, true);
  } catch (err) {
    logger.debug('MQTT publish failed (non-blocking)', 'PIPELINE', err);
  }
}

function envNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface SceneDetection {
  className: string;
  classId?: number;
  score: number;
  bbox: { x: number; y: number; width: number; height: number };
  trackId: number;
  trackState?: string;
  trackletLen?: number;
  identity?: string | null;
  identityConfidence?: number;
  humanVerification?: TrackingEvent['humanVerification'];
  lastSeen: number;
}

export async function persistDetectionEvent(
  ev: TrackingEvent,
  scene?: SceneDetection[],
): Promise<void> {
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

  const isPerson = className === 'person';
  const isFace = !!identity && identity !== 'unknown';
  const isVehicle = VEHICLE_CLASSES.includes(className);

  // --- Person persistence gate ---
  // HumanVerifier's `score_floor` tier approves a track on YOLO confidence
  // alone whenever neither uniface nor MediaPipe found anything, and neither
  // YOLO score nor bbox aspect ratio separates real people from ghosts in this
  // footage — their score distributions are near-identical. Persistence is what
  // separates them: an intermittent false positive is seen once and then gone
  // for minutes, so its tracklet never accumulates hits, while a person walking
  // through does.
  //
  // This gate did not exist. Python's PERSON_MIN_TRACK_HITS only decided which
  // process wrote the JPEG; when Python withheld it, the fallback below
  // synthesised an image from the live frame and the event was persisted
  // anyway — which is how an empty courtyard ended up in the events list as a
  // person.
  if (isPerson) {
    const minHits = envNumber(process.env.PERSON_MIN_TRACK_HITS, 3);
    const minConfidence = envNumber(process.env.PERSON_MIN_CONFIDENCE, 0.55);
    const hits = ev.trackletLen ?? 0;

    if (hits < minHits || score < minConfidence || ev.humanVerification?.verified === false) {
      logger.debug(
        `[DetectionPersistence] Dropped unconfirmed person track ${trackId} on ${cameraId} ` +
          `(hits=${hits}/${minHits}, score=${score.toFixed(2)}/${minConfidence}, ` +
          `tier=${ev.humanVerification?.tier ?? 'n/a'})`,
        'PIPELINE',
      );
      return;
    }
  }

  const eventTypeStr = isPerson ? 'person' : isVehicle ? 'vehicle' : isFace ? 'face' : 'motion';

  let filePath = ev.filePath ?? '';
  try {
    // Person/vehicle images: meta persists for every detection, snapshots only
    // for persisted classes. Prefer the full-res snapshot Python saved with the
    // event; fall back to the last live frame (640x360 preview) for persons in
    // legacy/edge cases.
    if (isPerson || isVehicle) {
      if (!filePath) {
        const streamManager = serviceRegistry.getStreamManager();
        const frame = streamManager?.getLastFrame(cameraId);
        if (frame) {
          const now = new Date();
          const ts = now.toISOString().replace(/[:.]/g, '-');
          const filename = `motion_${cameraId}_${ts}_t${trackId}.jpg`;
          const dir = getEventPath('motion', now);
          await fsp.mkdir(dir, { recursive: true });
          filePath = path.join(dir, filename);
          await fsp.writeFile(filePath, frame);
        }
      } else if (!path.isAbsolute(filePath)) {
        const now = new Date();
        const dir = getEventPath('motion', now);
        await fsp.mkdir(dir, { recursive: true });
        filePath = path.join(dir, path.basename(filePath));
      }
    }
  } catch (err) {
    logger.warn(
      `[DetectionPersistence] Failed to save snapshot for event on ${cameraId}`,
      'PIPELINE',
      err,
    );
  }

  const severity: 'alert' | 'detection' | 'info' = isPerson
    ? 'alert'
    : isVehicle
      ? 'detection'
      : 'info';

  // Scope scene detections to the primary event class so person events don't
  // contain car/animal tracks and vehicle events don't contain person tracks.
  const allSceneDets =
    scene && scene.length > 0
      ? scene
      : [
          {
            className,
            classId: ev.classId,
            score,
            bbox: { x: bbox[0] ?? 0, y: bbox[1] ?? 0, width: bbox[2] ?? 0, height: bbox[3] ?? 0 },
            trackId,
            trackState: ev.trackState,
            trackletLen: ev.trackletLen,
            identity,
            identityConfidence,
            humanVerification: ev.humanVerification,
            lastSeen: Date.now(),
          },
        ];
  // Helper: Intersection-over-union for two bbox rects
  const iou = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => {
    const ax2 = a.x + a.width, ay2 = a.y + a.height;
    const bx2 = b.x + b.width, by2 = b.y + b.height;
    const interArea =
      Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const aArea = a.width * a.height, bArea = b.width * b.height;
    return interArea / (aArea + bArea - interArea);
  };

  // Filter out lost tracks and dedupe overlapping person bboxes (same person → 1).
  // Never filter out the event's own track: the scene snapshot can be empty
  // (5s window expired) or the primary track can arrive already `lost`, and
  // dropping it persisted a person event with persons_detected=0 and
  // object_detections=[] — two such rows (15:27, 16:57 on Oct 5) were verified
  // humans carrying 33 pose keypoints while claiming zero people.
  const activePersonDets = allSceneDets.filter(
    (d) =>
      d.className === 'person' &&
      ((d.trackState ?? '') !== 'lost' || d.trackId === trackId),
  );
  const seen: typeof activePersonDets = [];
  const personDets = activePersonDets.filter((d) => {
    const overlaps = seen.some((s) => iou(d.bbox, s.bbox) > 0.3);
    if (!overlaps) { seen.push(d); return true; }
    return false;
  });

  const sceneDets = isPerson
    ? personDets
    : isVehicle
      ? allSceneDets.filter((d) => VEHICLE_CLASSES.includes(d.className))
      : allSceneDets;

  // Identified detections only from verified/active persons
  const identifiedDets = personDets.filter((d) => !!d.identity && d.identity !== 'unknown');
  const byClass: Record<string, number> = {};
  for (const d of personDets) byClass[d.className] = (byClass[d.className] ?? 0) + 1;

  const event = new Event();
  event.event_type = eventTypeStr;
  event.severity = severity;
  event.camera_id = cameraId;
  event.file_path = filePath || null;
  event.timestamp =
    typeof ev.timestamp === 'number' ? new Date(ev.timestamp * 1000) : new Date(ev.timestamp);
  event.confidence = score;

  let sceneChange: Awaited<ReturnType<typeof compareEventToBaseline>> = null;
  try {
    if (isSceneMemoryEnabled()) {
      sceneChange = await compareEventToBaseline(
        cameraId,
        event.timestamp,
        sceneDets.map((d) => ({ class: d.className })),
        filePath,
      );
    }
  } catch {
    /* scene memory must never block event persistence */
  }
  event.persons_detected = personDets.length;
  event.faces_detected = identifiedDets.length;
  event.known_faces_count = identifiedDets.length;
  event.unknown_faces_count = 0;
  event.object_detections = sceneDets.map((d) => ({
    class: d.className,
    confidence: Math.round(d.score * 100),
    bbox: d.bbox,
    trackId: d.trackId,
    trackState: d.trackState ?? null,
    trackletLen: d.trackletLen ?? null,
    classId: d.classId ?? null,
    identity: d.identity ?? null,
    identityConfidence: d.identityConfidence ?? null,
    humanVerified: d.humanVerification?.verified === true,
    verificationTier: d.humanVerification?.tier ?? null,
    personAttributes: d.trackId === trackId ? (ev.personAttributes ?? null) : null,
  }));
  event.face_detections = identifiedDets.map((d) => ({
    id: `track_${d.trackId}`,
    name: d.identity ?? 'unknown',
    isKnown: true,
    confidence: d.identityConfidence ?? 0,
    bbox: d.bbox,
  }));
  event.metadata = JSON.stringify({
    trackId,
    eventType,
    confidence: Math.round(score * 100),
    hasPersons: personDets.length > 0,
    hasFaces: identifiedDets.length > 0,
    personCount: personDets.length,
    faceCount: identifiedDets.length,
    scene: {
      total: sceneDets.length,
      byClass,
      distinctTracks: new Set(sceneDets.map((d) => d.trackId)).size,
    },
    // Python publishes each bbox in the pixels of the JPEG it names (640x360
    // when Node synthesised the preview itself). Stamping that fact lets the
    // backfill know which historical rows still carry detect-frame coords.
    bboxSpace: 'image',
    ...(ev.humanVerification
      ? {
          humanVerification: {
            verified: ev.humanVerification.verified,
            tier: ev.humanVerification.tier,
            keypoints: ev.humanVerification.keypoints,
            faceDetected: ev.humanVerification.face_detected,
            elapsedMs: ev.humanVerification.elapsed_ms,
            pose: ev.humanVerification.pose ?? null,
          },
        }
      : {}),
    ...(sceneChange ? { sceneChange } : {}),
  });

  event.scene_context = ev.sceneContext ?? null;
  event.threat_assessment = ev.threatAssessment ?? null;
  event.detection_summary = ev.detectionSummary ?? null;
  event.motion_stats = ev.motionStats ?? null;

  await AppDataSource.getRepository(Event).save(event);

  emitMqttEvent(cameraId, event.id, eventTypeStr, score);

  try {
    serviceRegistry
      .getReviewService()
      .upsertSegmentFromEvent({
        id: event.id,
        camera_id: event.camera_id,
        timestamp: event.timestamp,
        severity: severity === 'info' ? 'info' : severity,
        event_type: eventTypeStr,
        file_path: event.file_path,
        object_detections: sceneDets.map((d) => ({
          class: d.className,
          confidence: Math.round(d.score * 100),
          trackId: d.trackId,
        })),
      })
      .catch((err: unknown) => {
        logger.warn(
          `[DetectionPersistence] Review segment upsert failed for ${cameraId}`,
          'PIPELINE',
          err,
        );
      });
  } catch (err) {
    logger.debug('Review segment upsert skipped (service unavailable)', 'PIPELINE', err);
  }

  try {
    const detRepo = AppDataSource.getRepository(EventDetection);
    const detRows = sceneDets.map((d) => ({
      event_id: event.id,
      camera_id: cameraId,
      timestamp: event.timestamp,
      class: d.className,
      class_id: d.classId ?? null,
      confidence: d.score ?? null,
      bbox_x: d.bbox ? Math.round(d.bbox.x) : null,
      bbox_y: d.bbox ? Math.round(d.bbox.y) : null,
      bbox_w: d.bbox ? Math.round(d.bbox.width) : null,
      bbox_h: d.bbox ? Math.round(d.bbox.height) : null,
      track_id: d.trackId ?? null,
      track_state: d.trackState ?? null,
      tracklet_len: d.trackletLen ?? null,
      identity: d.identity ?? null,
      identity_confidence: d.identityConfidence ?? null,
      human_verified: d.humanVerification?.verified ?? null,
      verification_tier: d.humanVerification?.tier ?? null,
      person_attributes: d.trackId === trackId ? ev.personAttributes ?? null : null,
      face_embedding: d.trackId === trackId ? ev.faceEmbedding ?? null : null,
    }));
    if (detRows.length > 0)
      await detRepo.save(detRows as unknown as import('typeorm').DeepPartial<EventDetection>[]);
  } catch (err) {
    logger.warn(
      `[DetectionPersistence] Failed to save detection rows for ${cameraId}`,
      'PIPELINE',
      err,
    );
  }
  logger.info(
    `[DetectionPersistence] Persisted ${eventTypeStr} event for ${cameraId} (track=${trackId}, class=${className})`,
    'PIPELINE',
  );

  enqueueRelationJob(event.id).catch((err: unknown) => {
    logger.warn(
      `[DetectionPersistence] Failed to enqueue relation job for ${event.id}`,
      'PIPELINE',
      err,
    );
  });

  if (ev.humanVerification || personDets.length > 0) {
    try {
      const repo = AppDataSource.getRepository(HumanVerification);
      const rows = personDets
        .filter((d) => d.humanVerification)
        .map((d) => ({
          eventId: event.id,
          cameraId,
          trackId: String(d.trackId),
          verified: d.humanVerification!.verified,
          tier: d.humanVerification!.tier,
          keypoints: d.humanVerification!.keypoints ?? 0,
          faceDetected: d.humanVerification!.face_detected ?? false,
          yoloScore: d.humanVerification!.yolo_score ?? d.score,
          roiWidth: d.humanVerification!.roi_w ?? 0,
          roiHeight: d.humanVerification!.roi_h ?? 0,
          elapsedMs: d.humanVerification!.elapsed_ms ?? 0,
        }));
      if (ev.humanVerification && !rows.some((r) => r.trackId === String(trackId))) {
        const hv = ev.humanVerification;
        rows.push({
          eventId: event.id,
          cameraId,
          trackId: String(trackId),
          verified: hv.verified,
          tier: hv.tier,
          keypoints: hv.keypoints ?? 0,
          faceDetected: hv.face_detected ?? false,
          yoloScore: hv.yolo_score ?? 0,
          roiWidth: hv.roi_w ?? 0,
          roiHeight: hv.roi_h ?? 0,
          elapsedMs: hv.elapsed_ms ?? 0,
        });
      }
      if (rows.length > 0) await repo.insert(rows);
    } catch (err) {
      logger.warn(
        `[DetectionPersistence] Failed to save human verification for ${cameraId}`,
        'PIPELINE',
        err,
      );
    }
  }

  try {
    if (eventTypeStr === 'person') {
      NotificationService.notifyObjectDetected(event, [className]).catch((err: unknown) => {
        logger.error('Object detection notification failed', 'PIPELINE', err);
      });
    } else if (eventTypeStr === 'face') {
      NotificationService.notifyUnknownFace(event).catch((err: unknown) => {
        logger.error('Unknown face notification failed', 'PIPELINE', err);
      });
    } else if (eventTypeStr === 'vehicle') {
      NotificationService.notifyObjectDetected(event, [className]).catch((err: unknown) => {
        logger.error('Vehicle notification failed', 'PIPELINE', err);
      });
    } else {
      NotificationService.notifyMotionEvent(event).catch((err: unknown) => {
        logger.error('Motion notification failed', 'PIPELINE', err);
      });
    }
  } catch (err) {
    logger.debug('Notification dispatch failed (non-blocking)', 'PIPELINE', err);
  }
}
