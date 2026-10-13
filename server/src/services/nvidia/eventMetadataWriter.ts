import { logger } from '../../utils/logger.js';
import type { NormalizedAnalysisResult } from './aiResultNormalizer.js';

export interface EventMetadata {
  eventId: string;
  filename: string;
  cameraId: string | null;
}

export class EventMetadataWriter {
  private appDataSource: any;

  constructor(appDataSource: any) {
    this.appDataSource = appDataSource;
  }

  async writeAnalysisResult(
    metadata: EventMetadata,
    result: NormalizedAnalysisResult,
    processingTimeMs: number,
  ): Promise<void> {
    try {
      const entities = result.detectedEntities || {};
      const threatLevel = result.threatAssessment?.level || 'low';
      const threatConfidence = result.threatAssessment?.confidence || 0;

      await this.appDataSource.query(
        `INSERT INTO ai_analysis_results (event_id, event_filename, camera_id, scene_description, scene_context, threat_level, threat_confidence, detected_people, detected_vehicles, detected_objects, detected_animals, bounding_boxes, recommended_actions, additional_observations, model_used, processing_time_ms, analyzed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
         ON CONFLICT (event_id) DO UPDATE SET scene_description = EXCLUDED.scene_description, scene_context = EXCLUDED.scene_context, threat_level = EXCLUDED.threat_level, detected_people = EXCLUDED.detected_people, detected_vehicles = EXCLUDED.detected_vehicles, detected_objects = EXCLUDED.detected_objects, detected_animals = EXCLUDED.detected_animals, bounding_boxes = EXCLUDED.bounding_boxes, recommended_actions = EXCLUDED.recommended_actions, model_used = EXCLUDED.model_used, processing_time_ms = EXCLUDED.processing_time_ms, analyzed_at = NOW()`,
        [
          metadata.eventId,
          metadata.filename,
          metadata.cameraId,
          result.overall_summary || result.sceneDescription || '',
          JSON.stringify(result.sceneContext || null),
          threatLevel,
          threatConfidence,
          JSON.stringify(entities.people || result.persons || []),
          JSON.stringify(entities.vehicles || result.vehicles || []),
          JSON.stringify(entities.objects || []),
          JSON.stringify(entities.animals || []),
          JSON.stringify(result.boundingBoxes || []),
          JSON.stringify(result.recommendedActions || []),
          result.additionalObservations || null,
          result.model || 'unknown',
          processingTimeMs,
        ],
      );
    } catch (error) {
      logger.error('[EventMetadataWriter] Failed to persist analysis result', 'NVIDIA', error);
    }
  }

  async overwriteEventMetadata(
    eventRepository: any,
    event: any,
    result: NormalizedAnalysisResult,
  ): Promise<void> {
    try {
      const threatLevel = result.threatAssessment?.level || 'low';
      const severity =
        threatLevel === 'high' || threatLevel === 'critical'
          ? 'alert'
          : threatLevel === 'medium'
            ? 'alert'
            : 'detection';

      const entities = result.detectedEntities || {};
      const aiPeople = entities.people || result.persons || [];
      const threatConfidence = Number(result.threatAssessment?.confidence) || 0;
      const aiConfidence01 = threatConfidence > 1 ? threatConfidence / 100 : threatConfidence;

      // The AI enumerates people from prose, not measurements — on the two
      // rows that exposed this it found 0 on images with a verified human
      // pose (33 keypoints). It must only ever raise the detector count,
      // never zero it: a 0 here hid both rows from the events list.
      const aiCount = Array.isArray(aiPeople) ? aiPeople.length : 0;
      const pipelineCount = Number(event.persons_detected) || 0;

      await eventRepository.update(
        { id: event.id },
        {
          scene_context: (result.sceneContext as Record<string, unknown>) || null,
          threat_assessment: {
            level: threatLevel,
            confidence: threatConfidence,
            factors: result.threatAssessment?.factors || [],
            source: 'nvidia',
            model: result.model || 'unknown',
          } as Record<string, unknown>,
          detection_summary: {
            description: result.sceneDescription || '',
            people: aiPeople,
            vehicles: entities.vehicles || result.vehicles || [],
            animals: entities.animals || [],
            objects: entities.objects || [],
            source: 'nvidia',
            model: result.model || 'unknown',
            analyzedAt: new Date().toISOString(),
          } as Record<string, unknown>,
          severity,
          persons_detected: Math.max(pipelineCount, aiCount),
          confidence: aiConfidence01,
        } as any,
      );
    } catch (error) {
      logger.error('[EventMetadataWriter] Failed to overwrite event metadata', 'NVIDIA', error);
    }
  }

  async writeBboxResult(
    metadata: EventMetadata,
    boxes: unknown[],
    modelUsed: string,
  ): Promise<void> {
    try {
      await this.appDataSource.query(
        `INSERT INTO ai_analysis_results (event_id, event_filename, camera_id, bounding_boxes, model_used, analyzed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (event_id) DO UPDATE SET bounding_boxes = EXCLUDED.bounding_boxes, analyzed_at = NOW()`,
        [metadata.eventId, metadata.filename, metadata.cameraId, JSON.stringify(boxes), modelUsed],
      );
    } catch (error) {
      logger.error('[EventMetadataWriter] Failed to persist bounding boxes', 'NVIDIA', error);
    }
  }

  async getCachedAnalysis(eventId: string): Promise<any | null> {
    try {
      const rows = await this.appDataSource.query(
        `SELECT * FROM ai_analysis_results WHERE event_id = $1 LIMIT 1`,
        [eventId],
      );
      return rows && rows.length > 0 ? rows[0] : null;
    } catch {
      return null;
    }
  }
}
