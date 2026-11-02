import { logger } from '../utils/logger.js';
import { Request, Response } from 'express';
import { BaseController } from './BaseController.js';
import {
  analyzeImage,
  checkApiHealth,
  analyzeWithBoundingBoxes,
  analyzePersons,
} from '../services/nvidia/index.js';
import { imageResolver } from '../services/nvidia/imageResolver.js';
import { getEffectiveModel, getModelFallbackChain } from '../services/nvidia/nvidiaClient.js';
import { aiResultNormalizer } from '../services/nvidia/aiResultNormalizer.js';
import { EventMetadataWriter } from '../services/nvidia/eventMetadataWriter.js';
import { serviceRegistry } from '../services/serviceRegistry.js';
import { assessThreat, buildEventState, mapToThreatAssessment } from '../services/jevThreatService.js';

function safeJson(val: unknown): unknown[] {
  if (!val) return [];
  try {
    return typeof val === 'object' ? (val as unknown[]) : JSON.parse(val as string);
  } catch {
    return [];
  }
}

function resolveCameraName(cameraId?: string | null): string | undefined {
  if (!cameraId) return undefined;
  try {
    const sm = serviceRegistry.getStreamManager();
    const cam = sm.getCamera(cameraId);
    return cam?.name || cameraId;
  } catch {
    return cameraId;
  }
}

export class NvidiaController extends BaseController {
  private metadataWriter: EventMetadataWriter | null = null;

  private async getMetadataWriter(): Promise<EventMetadataWriter> {
    if (!this.metadataWriter) {
      const { AppDataSource } = await import('../database.js');
      this.metadataWriter = new EventMetadataWriter(AppDataSource);
    }
    return this.metadataWriter;
  }

  async analyze(req: Request, res: Response): Promise<void> {
    try {
      const startTime = Date.now();
      const {
        image,
        imagePath: imgPath,
        cameraId,
        cameraName,
        triggerReason,
        eventType,
        detectedObjects,
        confidence,
        timestamp,
        yoloDetections,
      } = req.body;

      if (!image && !imgPath) {
        this.badRequest(res, 'Either "image" (base64) or "imagePath" (file path) is required');
        return;
      }

      const imageInput = image
        ? image
        : imageResolver.resolveFromPath(imgPath!)?.imagePath;

      if (!imageInput) {
        this.badRequest(res, `Image file not found: ${imgPath}`);
        return;
      }

      const context = {
        cameraId,
        cameraName,
        triggerReason,
        eventType,
        detectedObjects,
        confidence,
        timestamp: timestamp || new Date().toISOString(),
        yoloDetections,
      };

      const result = await analyzeImage(imageInput, context);
      const totalTime = Date.now() - startTime;

      const writer = await this.getMetadataWriter();
      const eventIdentifier =
        imgPath?.split('/').pop()?.replace('.jpg', '') || `analysis_${Date.now()}`;
      await writer.writeAnalysisResult(
        {
          eventId: eventIdentifier,
          filename: imgPath?.split('/').pop() || '',
          cameraId: cameraName || cameraId || null,
        },
        aiResultNormalizer.normalizeNvidiaResult(result),
        totalTime,
      );

      res.json({
        success: true,
        analysis: result,
        metadata: {
          processingTime: totalTime,
          timestamp: new Date().toISOString(),
          cameraId,
          cameraName,
          sceneContext: result.sceneContext,
        },
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'nvidia analyze');
    }
  }

  async analyzeEvent(req: Request, res: Response): Promise<void> {
    try {
      const { eventId, useStoredImage = true } = req.body;
      if (!eventId) {
        this.badRequest(res, 'eventId is required');
        return;
      }

      const { AppDataSource } = await import('../database.js');
      const { Event } = await import('../models/index.js');
      const eventRepository = AppDataSource.getRepository(Event);
      const event = await eventRepository.findOne({ where: { id: eventId } });
      if (!event) {
        this.notFound(res, 'Event not found');
        return;
      }

      const writer = await this.getMetadataWriter();

      if (useStoredImage !== false) {
        const cached = await writer.getCachedAnalysis(eventId);
        if (cached) {
          const cachedSceneDesc = aiResultNormalizer.normalizeSceneDescriptionFromDb(
            cached.scene_description || '',
          );
          res.json({
            success: true,
            analysis: {
              sceneDescription: cachedSceneDesc,
              summary: cachedSceneDesc,
              persons: safeJson(cached.detected_people),
              vehicles: safeJson(cached.detected_vehicles),
              activities: [],
              overall_summary: cachedSceneDesc,
              threatAssessment: {
                level: cached.threat_level || 'low',
                factors: [],
                confidence: cached.threat_confidence || 0,
              },
              detectedEntities: {
                people: safeJson(cached.detected_people),
                vehicles: safeJson(cached.detected_vehicles),
                animals: safeJson(cached.detected_animals),
                objects: safeJson(cached.detected_objects),
                actions: [],
              },
              recommendedActions: safeJson(cached.recommended_actions),
              additionalObservations: cached.additional_observations || [],
              boundingBoxes: safeJson(cached.bounding_boxes),
              processing_time_ms: cached.processing_time_ms || 0,
              model: cached.model_used || 'cached',
              cached: true,
            },
            event: {
              id: event.id,
              eventType: event.event_type,
              cameraId: event.camera_id,
              timestamp: event.timestamp,
            },
          });
          return;
        }
      }

      const resolution = imageResolver.resolveFromEvent(event);
      if (!resolution) {
        this.badRequest(res, 'Event image file not found');
        return;
      }

      const { EventDetection } = await import('../models/index.js');
      let sensorMetadata: import('../services/nvidia/types.js').SensorMetadata | undefined;
      try {
        const detRows = await AppDataSource.getRepository(EventDetection).find({
          where: { event_id: event.id },
          order: { id: 'ASC' },
        });
        if (detRows.length > 0) {
          sensorMetadata = {
            tracks: detRows.map((d) => {
              const attrs = d.person_attributes as Record<string, unknown> | null;
              const pos = attrs?.position as
                | { x: number; y: number; width: number; height: number }
                | undefined;
              return {
                class: d.class,
                confidence: d.confidence,
                trackId: d.track_id,
                trackState: d.track_state,
                trackletLen: d.tracklet_len,
                identity: d.identity,
                identityConfidence: d.identity_confidence,
                humanVerified: d.human_verified,
                verificationTier: d.verification_tier,
                personAttributes: attrs
                  ? {
                      clothing: (attrs.clothing as string) ?? null,
                      clothingColors: (attrs.clothing_colors as string[]) ?? undefined,
                      facing: (attrs.facing as string) ?? null,
                      distance: (attrs.distance as string) ?? null,
                      carryingItem: (attrs.carryingItem as string) ?? null,
                      bodyLanguage: (attrs.bodyLanguage as string) ?? null,
                      actions: (attrs.actions as string[]) ?? undefined,
                      positionPct: pos ?? null,
                    }
                  : null,
              };
            }),
            localThreat: (event.threat_assessment as { level?: string; factors?: string[] }) ?? null,
            sceneContext: event.scene_context ?? null,
            motionStats:
              (event.motion_stats as {
                motion_pixels?: number;
                motion_percentage?: number;
                confidence?: number;
              }) ?? null,
          };
        }
      } catch (metaError) {
        // metadata is optional enrichment — proceed without it
      }

      const context = {
        cameraId: event.camera_id ?? undefined,
        cameraName: resolveCameraName(event.camera_id),
        triggerReason: 'event analysis',
        eventType: event.event_type,
        detectedObjects: event.object_detections.map((d) => d.class),
        confidence: event.confidence ?? undefined,
        timestamp: event.timestamp.toString(),
        yoloDetections: event.object_detections,
        sensorMetadata,
      };

      let result: any;
      const startTime = Date.now();
      try {
        result = await analyzeImage(resolution.imagePath, context);
        if (result.sceneDescription?.startsWith('Analysis failed:')) {
          throw new Error(result.sceneDescription.replace('Analysis failed: ', ''));
        }
      } catch (nvidiaError: unknown) {
        this.serverError(
          res,
          `Analysis failed: ${nvidiaError instanceof Error ? nvidiaError.message : String(nvidiaError)}`,
        );
        return;
      }

      const normalizedResult = aiResultNormalizer.normalizeNvidiaResult(result);

      await writer.writeAnalysisResult(
        {
          eventId,
          filename: resolution.filename,
          cameraId: event.camera_id,
        },
        normalizedResult,
        Date.now() - startTime,
      );

      await writer.overwriteEventMetadata(eventRepository, event, normalizedResult);

      res.json({
        success: true,
        analysis: normalizedResult,
        event: {
          id: event.id,
          eventType: event.event_type,
          cameraId: event.camera_id,
          timestamp: event.timestamp,
        },
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'analyzeEvent');
    }
  }

  async getEventAnalysis(req: Request, res: Response): Promise<void> {
    try {
      const { eventId } = req.params;
      if (!eventId) {
        this.badRequest(res, 'eventId is required');
        return;
      }

      const { AppDataSource } = await import('../database.js');
      const { Event } = await import('../models/index.js');
      const event = await AppDataSource.getRepository(Event).findOne({ where: { id: eventId } });
      if (!event) {
        this.notFound(res, 'Event not found');
        return;
      }

      const writer = await this.getMetadataWriter();
      const cached = await writer.getCachedAnalysis(eventId);

      if (!cached) {
        res.json({ success: true, analysis: null, boxes: [] });
        return;
      }

      const sceneDesc = aiResultNormalizer.normalizeSceneDescriptionFromDb(cached.scene_description || '');

      res.json({
        success: true,
        analysis: {
          sceneDescription: sceneDesc,
          summary: sceneDesc,
          persons: safeJson(cached.detected_people),
          vehicles: safeJson(cached.detected_vehicles),
          overall_summary: sceneDesc,
          threatAssessment: {
            level: cached.threat_level || 'low',
            factors: [],
            confidence: cached.threat_confidence || 0,
          },
          detectedEntities: {
            people: safeJson(cached.detected_people),
            vehicles: safeJson(cached.detected_vehicles),
            animals: safeJson(cached.detected_animals),
            objects: safeJson(cached.detected_objects),
            actions: [],
          },
          recommendedActions: safeJson(cached.recommended_actions),
          additionalObservations: cached.additional_observations || [],
          processing_time_ms: cached.processing_time_ms || 0,
          model: cached.model_used || 'cached',
          cached: true,
        },
        boxes: safeJson(cached.bounding_boxes),
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'getEventAnalysis');
    }
  }

  async health(req: Request, res: Response): Promise<void> {
    try {
      const healthResult = await checkApiHealth();
      res.json({
        success: true,
        available: healthResult.available,
        model: healthResult.model,
        error: healthResult.error || null,
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'nvidia health');
    }
  }

  /**
   * Assess urgency/threat via jev model from raw state text or event data.
   * POST /api/nvidia/assess-threat { state } or { eventId }
   */
  async assessThreatHandler(req: Request, res: Response): Promise<void> {
    try {
      const { state, eventId } = req.body;

      if (!state && !eventId) {
        this.badRequest(res, 'Either "state" (text) or "eventId" is required');
        return;
      }

      if (eventId) {
        const { AppDataSource } = await import('../database.js');
        const { Event } = await import('../models/index.js');
        const event = await AppDataSource.getRepository(Event).findOne({
          where: { id: eventId },
        });
        if (!event) {
          this.notFound(res, 'Event not found');
          return;
        }

        const objectDetections = safeJson(event.object_detections as unknown);
        const persons = objectDetections.filter(
          (d: any) => typeof d === 'object' && d?.class === 'person',
        ).length;
        const faces = safeJson(event.face_detections as unknown);

        const builtState = buildEventState({
          cameraId: event.camera_id ?? undefined,
          eventType: event.event_type ?? undefined,
          personsDetected: persons,
          faceDetected: faces.length > 0,
          timestamp: event.timestamp.toString(),
        });

        const result = await assessThreat(builtState);
        const threatJson = mapToThreatAssessment(result);

        event.threat_assessment = {
          ...(event.threat_assessment as Record<string, unknown> | null),
          ...threatJson,
        };
        await AppDataSource.getRepository(Event).save(event);

        res.json({
          success: true,
          eventId,
          assessment: result,
          threatAssessment: threatJson,
          stateUsed: builtState,
        });
        return;
      }

      const result = await assessThreat(state);
      res.json({
        success: true,
        assessment: result,
        threatAssessment: mapToThreatAssessment(result),
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'assess-threat');
    }
  }

  async getResults(req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const results = await AppDataSource.query(
        `SELECT id, event_id, event_filename, camera_id, scene_description, threat_level, threat_confidence, detected_people, detected_vehicles, detected_objects, bounding_boxes, recommended_actions, additional_observations, model_used, processing_time_ms, analyzed_at FROM ai_analysis_results ORDER BY analyzed_at DESC LIMIT 100`,
      );

      res.json({
        success: true,
        count: results.length,
        results: results.map((r: any) => ({
          id: r.id,
          eventId: r.event_id,
          eventFilename: r.event_filename,
          cameraId: r.camera_id,
          sceneDescription: r.scene_description || '',
          threatLevel: r.threat_level || 'low',
          detectedPeople: safeJson(r.detected_people),
          detectedVehicles: safeJson(r.detected_vehicles),
          detectedObjects: safeJson(r.detected_objects),
          boundingBoxes: safeJson(r.bounding_boxes),
          recommendedActions: safeJson(r.recommended_actions),
          additionalObservations: r.additional_observations,
          modelUsed: r.model_used,
          processingTimeMs: r.processing_time_ms,
          analyzedAt: r.analyzed_at,
        })),
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'nvidia getResults');
    }
  }

  getModels(req: Request, res: Response): void {
    const configuredModel = getEffectiveModel();
    const apiKey = process.env.NVIDIA_API_KEY ? 'configured' : 'not set';
    res.json({
      success: true,
      configured: { model: configuredModel, apiKeyStatus: apiKey },
      available: getModelFallbackChain().map((id) => ({
        id,
        name: id,
        description: 'Vision model for AI event analysis',
        recommended: id === configuredModel,
      })),
    });
  }

  updateConfig(req: Request, res: Response): void {
    try {
      const { model } = req.body;
      if (!getModelFallbackChain().includes(model)) {
        this.badRequest(res, `Model must be one of: ${getModelFallbackChain().join(', ')}`);
        return;
      }
      process.env.NVIDIA_MODEL = model;
      this.ok(res, {
        message: `Model updated to: ${model}`,
        note: 'This change is temporary for the current session',
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'nvidia updateConfig');
    }
  }

  async analyzeWithBboxes(req: Request, res: Response): Promise<void> {
    try {
      const startTime = Date.now();
      const {
        image,
        imagePath: imgPath,
        cameraId,
        cameraName,
        triggerReason,
        eventType,
        detectedObjects,
        confidence,
        timestamp,
        yoloDetections,
      } = req.body;

      if (!image && !imgPath) {
        this.badRequest(res, 'Either "image" (base64) or "imagePath" (file path) is required');
        return;
      }

      const imageInput = image
        ? image
        : imageResolver.resolveFromPath(imgPath!)?.imagePath;

      if (!imageInput) {
        this.badRequest(res, `Image file not found: ${imgPath}`);
        return;
      }

      const context = {
        cameraId,
        cameraName,
        triggerReason,
        eventType,
        detectedObjects,
        confidence,
        timestamp: timestamp || new Date().toISOString(),
        yoloDetections,
      };
      const result = await analyzeWithBoundingBoxes(imageInput, context);
      const totalTime = Date.now() - startTime;

      res.json({
        success: true,
        boxes: result.boxes,
        sceneDescription: result.sceneDescription,
        annotatedImage: result.annotatedImage
          ? `data:image/jpeg;base64,${result.annotatedImage}`
          : null,
        rawAnalysis: result.rawAnalysis,
        sceneContext: result.sceneContext,
        metadata: {
          processingTime: totalTime,
          modelUsed: result.modelUsed,
          timestamp: new Date().toISOString(),
          cameraId,
          cameraName,
        },
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'analyzeWithBboxes');
    }
  }

  async analyzePersons(req: Request, res: Response): Promise<void> {
    try {
      const startTime = Date.now();
      const {
        image,
        imagePath: imgPath,
        cameraId,
        cameraName,
        triggerReason,
        eventType,
        onlyOnMotion,
        timestamp,
        eventId,
      } = req.body;

      if (!image && !imgPath) {
        this.badRequest(res, 'Either "image" (base64) or "imagePath" (file path) is required');
        return;
      }

      const eventIdentifier =
        eventId || imgPath?.split('/').pop()?.replace('.jpg', '') || `analysis_${Date.now()}`;

      const writer = await this.getMetadataWriter();
      const cached = await writer.getCachedAnalysis(eventIdentifier);
      if (cached) {
        res.json({
          success: true,
          count: cached.detected_people ? JSON.parse(cached.detected_people).length : 0,
          people: cached.detected_people ? JSON.parse(cached.detected_people) : [],
          sceneDescription: cached.scene_description,
          threatAssessment: { level: cached.threat_level },
          metadata: {
            processingTime: cached.processing_time_ms,
            modelUsed: cached.model_used,
            timestamp: cached.analyzed_at,
            cameraId: cached.camera_id,
            cameraName: cached.camera_id,
            cached: true,
          },
        });
        return;
      }

      const imageInput = image
        ? image
        : imageResolver.resolveFromPath(imgPath!)?.imagePath;

      if (!imageInput) {
        this.badRequest(res, `Image file not found: ${imgPath}`);
        return;
      }

      const context = {
        cameraId,
        cameraName,
        triggerReason,
        eventType,
        timestamp: timestamp || new Date().toISOString(),
      };
      const result = await analyzePersons(imageInput, context);
      const totalTime = Date.now() - startTime;

      await writer.writeAnalysisResult(
        {
          eventId: eventIdentifier,
          filename: imgPath?.split('/').pop() || '',
          cameraId: cameraId || cameraName || null,
        },
        {
          sceneDescription: result.sceneDescription || '',
          sceneContext: result.sceneContext || null,
          summary: result.sceneDescription || '',
          persons: result.people || [],
          vehicles: [],
          activities: [],
          overall_summary: result.sceneDescription || '',
          threatAssessment: {
            level: 'low',
            factors: [],
            confidence: result.people?.length > 0 ? 70 : 30,
          },
          detectedEntities: {
            people: result.people || [],
            vehicles: [],
            animals: [],
            objects: [],
            actions: [],
          },
          recommendedActions: ['Review if person detected'],
          additionalObservations: [],
          boundingBoxes: (result.people || []).map((p) => p.position),
          processing_time_ms: totalTime,
          model: result.modelUsed || 'unknown',
        },
        totalTime,
      );

      res.json({
        success: true,
        count: result.count,
        people: result.people,
        sceneDescription: result.sceneDescription,
        metadata: {
          processingTime: totalTime,
          modelUsed: result.modelUsed,
          timestamp: new Date().toISOString(),
          cameraId,
          cameraName,
          triggeredOnMotion: onlyOnMotion || false,
        },
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'analyzePersons');
    }
  }

  async analyzeEventWithBboxes(req: Request, res: Response): Promise<void> {
    try {
      const { eventId, includeAnnotatedImage = true } = req.body;
      if (!eventId) {
        this.badRequest(res, 'eventId is required');
        return;
      }

      const { AppDataSource } = await import('../database.js');
      const { Event } = await import('../models/index.js');
      const eventRepository = AppDataSource.getRepository(Event);
      const event = await eventRepository.findOne({ where: { id: eventId } });
      if (!event) {
        this.notFound(res, 'Event not found');
        return;
      }

      const resolution = imageResolver.resolveFromEvent(event);
      if (!resolution) {
        this.badRequest(res, 'Event image file not found');
        return;
      }

      const context = {
        cameraId: event.camera_id ?? undefined,
        cameraName: resolveCameraName(event.camera_id),
        triggerReason: 'event bbox analysis',
        eventType: event.event_type,
        detectedObjects: event.object_detections.map((d) => d.class),
        confidence: event.confidence ?? undefined,
        timestamp: event.timestamp.toString(),
        yoloDetections: event.object_detections,
      };

      const result = await analyzeWithBoundingBoxes(resolution.imagePath, context);

      const writer = await this.getMetadataWriter();
      await writer.writeBboxResult(
        {
          eventId,
          filename: resolution.filename,
          cameraId: event.camera_id,
        },
        result.boxes || [],
        result.modelUsed || 'unknown',
      );

      res.json({
        success: true,
        boxes: result.boxes,
        sceneDescription: result.sceneDescription,
        annotatedImage:
          includeAnnotatedImage && result.annotatedImage
            ? `data:image/jpeg;base64,${result.annotatedImage}`
            : null,
        rawAnalysis: result.rawAnalysis,
        event: {
          id: event.id,
          eventType: event.event_type,
          cameraId: event.camera_id,
          timestamp: event.timestamp,
        },
        metadata: { processingTime: result.processingTime, modelUsed: result.modelUsed },
      });
    } catch (error: unknown) {
      this.serverError(res, error, 'analyzeEventWithBboxes');
    }
  }
}

export const nvidiaController = new NvidiaController();
