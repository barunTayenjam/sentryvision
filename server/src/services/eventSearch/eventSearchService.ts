import { logger } from '../../utils/logger.js';
import { AppDataSource } from '../../database.js';
import { Event } from '../../models/Event.js';
import { DetectionDataNormalizer } from '../../utils/detectionDataNormalizer.js';
import { serviceRegistry } from '../serviceRegistry.js';
import { getOpenCVClient } from '../opencvMicroserviceClient.js';
import type {
  EventSearchFilters,
  EventSearchResponse,
  ListEnhancedFilters,
  DetectionEventFilters,
} from './types.js';

export class EventSearchService {
  private eventRepository = AppDataSource.getRepository(Event);

  private getConfidenceThreshold(level: string): number {
    switch (level) {
      case 'low':
        return 0;
      case 'medium':
        return 0.5;
      case 'high':
        return 0.8;
      default:
        return 0;
    }
  }

  private extractConfidence(metadata: any): number {
    let confidence = 0.75;
    if (metadata && typeof metadata === 'object') {
      if (metadata.confidence !== undefined) confidence = metadata.confidence;
      else if (metadata.persons?.length > 0) confidence = metadata.persons[0].confidence || 0.75;
      else if (metadata.faces?.length > 0) confidence = metadata.faces[0].confidence || 0.75;
    }
    if (confidence > 1) confidence /= 100;
    return confidence;
  }

  async searchEvents(filters: EventSearchFilters): Promise<EventSearchResponse> {
    const query = this.eventRepository.createQueryBuilder('event');

    if (filters.startDate)
      query.andWhere('event.timestamp >= :startDate', { startDate: filters.startDate });
    if (filters.endDate)
      query.andWhere('event.timestamp <= :endDate', { endDate: filters.endDate });
    if (filters.cameraId)
      query.andWhere('event.camera_id = :cameraId', { cameraId: filters.cameraId });
    if (filters.eventType)
      query.andWhere('event.event_type = :eventType', { eventType: filters.eventType });

    if (filters.confidence) {
      query.andWhere('event.confidence >= :minConfidence', {
        minConfidence: this.getConfidenceThreshold(filters.confidence),
      });
    }

    if (filters.faceStatus === 'recognized') query.andWhere('event.known_faces_count > 0');
    else if (filters.faceStatus === 'unknown')
      query.andWhere('event.faces_detected > 0').andWhere('event.known_faces_count = 0');
    else if (filters.faceStatus === 'none') query.andWhere('event.faces_detected = 0');

    const page = filters.page || 1;
    const pageSize = Math.min(filters.pageSize || 20, 100);
    const sortBy = filters.sortBy || 'timestamp';
    const sortOrder = filters.sortOrder || 'DESC';
    const validSortFields = ['timestamp', 'confidence', 'camera_id'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'timestamp';

    query.orderBy(`event.${sortField}`, sortOrder);

    const [events, totalEvents] = await query
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      events: events.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        timestamp: event.timestamp,
        cameraId: event.camera_id,
        confidence: event.confidence,
        personsDetected: event.persons_detected,
        facesDetected: event.faces_detected,
        knownFacesCount: event.known_faces_count,
        unknownFacesCount: event.unknown_faces_count,
        objectDetections: event.object_detections || [],
        faceDetections: event.face_detections || [],
        imageUrl: event.file_path ? `/api/events/image/${event.file_path.split('/').pop()}` : null,
        metadata: event.metadata ? JSON.parse(event.metadata) : null,
      })),
      pagination: {
        page,
        pageSize,
        totalEvents,
        totalPages: Math.ceil(totalEvents / pageSize),
        hasNext: page < Math.ceil(totalEvents / pageSize),
        hasPrevious: page > 1,
      },
    };
  }

  async listEnhanced(filters: ListEnhancedFilters): Promise<{
    events: Record<string, unknown>[];
    pagination: { totalEvents: number; currentPage: number; pageSize: number; totalPages: number };
  }> {
    const {
      page = '1',
      pageSize = '100',
      event_type,
      camera_id,
      start_date,
      end_date,
      searchQuery,
      sortBy = 'newest',
      min_confidence,
      max_confidence,
      face_status,
    } = filters;

    const currentPage = Math.max(1, parseInt(page));
    const size = Math.min(500, Math.max(1, parseInt(pageSize)));
    const offset = (currentPage - 1) * size;

    const conditions: string[] = [
      "e.event_type IN ('motion', 'face', 'person', 'visitor', 'recognition', 'event_motion', 'event_face')",
      // persons_detected>0 is NOT a global condition: it hid 223 vehicle and
      // motion events per 2 days (persons=0) that the UI had already shown
      // live — the "event tracked then disappears on reload" symptom. The
      // person filter applies only when the user asks for persons.
      // Image is mandatory for person/face (the crop IS the evidence) but
      // motion rows legitimately carry no snapshot — hiding them also hid
      // every event the live feed had announced.
      "(e.event_type NOT IN ('person', 'visitor', 'recognition', 'face', 'event_face') OR (e.file_path IS NOT NULL AND e.file_path != ''))",
    ];
    const queryParams: unknown[] = [];
    let paramIndex = 1;

    if (camera_id && camera_id !== 'all') {
      conditions.push(`e.camera_id = $${paramIndex++}`);
      queryParams.push(camera_id);
    }
    if (start_date) {
      conditions.push(`e.timestamp >= $${paramIndex++}::timestamptz`);
      queryParams.push(start_date.replace(' 00:00:00', ''));
    }
    if (end_date) {
      conditions.push(`e.timestamp <= $${paramIndex++}::timestamptz`);
      queryParams.push(end_date.replace(' 23:59:59', ''));
    }
    if (searchQuery?.trim()) {
      conditions.push(`(e.camera_id ILIKE $${paramIndex} OR e.file_path ILIKE $${paramIndex})`);
      queryParams.push(`%${searchQuery.toLowerCase().trim()}%`);
      paramIndex++;
    }
    if (event_type && event_type !== 'all') {
      if (event_type === 'face') conditions.push(`COALESCE(e.faces_detected, 0) > 0`);
      else if (event_type === 'person') conditions.push(`COALESCE(e.persons_detected, 0) > 0`);
      else if (event_type === 'vehicle')
        conditions.push(
          `(e.event_type = 'vehicle' OR (e.object_detections IS NOT NULL AND e.object_detections::jsonb @> ANY(ARRAY['[{"class":"car"}]','[{"class":"truck"}]','[{"class":"motorcycle"}]','[{"class":"bicycle"}]','[{"class":"bus"}]','[{"class":"van"}]','[{"class":"suv"}]']::jsonb[])))`,
        );
      else if (event_type === 'motion')
        conditions.push(`e.event_type IN ('motion', 'event_motion')`);
    }
    if (min_confidence) {
      conditions.push(`(COALESCE(e.confidence, 0) >= $${paramIndex++})`);
      queryParams.push(parseFloat(min_confidence));
    }
    if (max_confidence) {
      conditions.push(`(COALESCE(e.confidence, 0) <= $${paramIndex++})`);
      queryParams.push(parseFloat(max_confidence));
    }
    if (face_status && face_status !== 'all') {
      switch (face_status) {
        case 'has_faces':
          conditions.push(`COALESCE(e.faces_detected, 0) > 0`);
          break;
        case 'known_faces':
          conditions.push(`COALESCE(e.known_faces_count, 0) > 0`);
          break;
        case 'unknown_faces':
          conditions.push(
            `COALESCE(e.faces_detected, 0) > 0 AND COALESCE(e.known_faces_count, 0) = 0`,
          );
          break;
        case 'no_faces':
          conditions.push(`(COALESCE(e.faces_detected, 0) = 0 OR e.faces_detected IS NULL)`);
          break;
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const orderClause =
      sortBy === 'oldest'
        ? 'ORDER BY e.timestamp ASC'
        : sortBy === 'confidence'
          ? 'ORDER BY e.confidence DESC, e.timestamp DESC'
          : 'ORDER BY e.timestamp DESC';

    const countResult = await AppDataSource.query(
      `SELECT COUNT(*) as total FROM events e ${whereClause}`,
      queryParams,
    );
    const totalEvents = parseInt(countResult[0]?.total || '0');

    const events = await AppDataSource.query(
      `SELECT e.id, e.event_type, e.timestamp, e.camera_id, e.confidence,
        e.file_path, e.metadata, e.persons_detected, e.faces_detected,
        e.known_faces_count, e.object_detections, e.face_detections,
        e.unknown_faces_count,
        a.scene_description, a.scene_context, a.threat_level, a.threat_confidence,
        a.detected_people, a.detected_vehicles, a.detected_objects,
        a.detected_animals, a.recommended_actions, a.additional_observations,
        a.model_used, a.processing_time_ms, a.analyzed_at
      FROM events e
      LEFT JOIN ai_analysis_results a ON e.id::text = a.event_id
      ${whereClause} ${orderClause} LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...queryParams, size, offset],
    );

    const safeJson = (val: any) => {
      if (!val) return [];
      try {
        return typeof val === 'object' ? val : JSON.parse(val);
      } catch {
        return [];
      }
    };

    const safeObject = (val: any): Record<string, unknown> | null => {
      if (!val) return null;
      if (typeof val === 'object' && !Array.isArray(val)) return val;
      try {
        const parsed = typeof val === 'string' ? JSON.parse(val) : val;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };

    const mapped = events.map((row: Record<string, unknown>) => ({
      id: row.id,
      event_type: row.event_type,
      cameraId: row.camera_id || 'unknown',
      timestamp: row.timestamp,
      imageUrl: row.file_path
        ? `/api/events/image/${String(row.file_path).split('/').pop()}`
        : null,
      confidence: row.confidence || 0,
      persons_detected: row.persons_detected || 0,
      faces_detected: row.faces_detected || 0,
      known_faces_count: row.known_faces_count || 0,
      metadata: safeObject(row.metadata),
      label: row.label,
      is_read: row.is_read,
      object_detections:
        typeof row.object_detections === 'string'
          ? JSON.parse(row.object_detections as string)
          : row.object_detections,
      face_detections:
        typeof row.face_detections === 'string'
          ? JSON.parse(row.face_detections as string)
          : row.face_detections,
      analysis: row.scene_description
        ? (() => {
            const rawDesc = row.scene_description || '';
            const plainDesc =
              typeof rawDesc === 'string' && rawDesc.trim().startsWith('{')
                ? (() => {
                    try {
                      const p = JSON.parse(rawDesc.trim());
                      return (
                        p.scene_description ||
                        p.sceneDescription ||
                        p.description ||
                        p.summary ||
                        p.overall_summary ||
                        rawDesc
                      );
                    } catch {
                      try {
                        const match = rawDesc
                          .trim()
                          .match(/"scene_description"\s*:\s*"((?:[^\n"\\]|\\.)*)"/);
                        if (match) return match[1];
                      } catch {
                        /* regex failure, fall through */
                      }
                      return rawDesc;
                    }
                  })()
                : rawDesc;
            return {
              sceneDescription: plainDesc,
              sceneContext: row.scene_context
                ? typeof row.scene_context === 'string'
                  ? JSON.parse(row.scene_context)
                  : row.scene_context
                : { environment: 'unknown' },
              threatAssessment: {
                level: row.threat_level || 'low',
                factors: [] as string[],
                confidence: row.threat_confidence || 0,
              },
              detectedEntities: {
                people: safeJson(row.detected_people),
                vehicles: safeJson(row.detected_vehicles),
                objects: safeJson(row.detected_objects),
                animals: safeJson(row.detected_animals),
              },
              recommendedActions: safeJson(row.recommended_actions),
              modelUsed: row.model_used,
              processingTime: row.processing_time_ms,
              analyzedAt: row.analyzed_at,
            };
          })()
        : null,
    }));

    let streamManager: ReturnType<typeof serviceRegistry.getStreamManager> | null = null;
    try {
      streamManager = serviceRegistry.getStreamManager();
    } catch (err) {
      logger.warn('Failed to get stream manager', 'EventSearch', err);
      streamManager = null;
    }

    const eventsWithCameraName = mapped.map((evt: Record<string, unknown>) => ({
      ...evt,
      cameraName:
        streamManager?.getCamera(evt.cameraId as string)?.name || `Camera ${evt.cameraId}`,
    }));

    return {
      events: eventsWithCameraName,
      pagination: {
        totalEvents,
        currentPage,
        pageSize: size,
        totalPages: Math.ceil(totalEvents / size),
      },
    };
  }

  async getMotionEvents(limit: number): Promise<any[]> {
    const results = await AppDataSource.query(
      `SELECT COALESCE(df.file_uuid::text, e.id::text) as id,
        COALESCE(df.camera_id, e.camera_id) as cameraId,
        COALESCE(df.capture_timestamp, e.timestamp) as timestamp,
        COALESCE(df.storage_path, e.file_path) as imagePath,
        COALESCE(df.metadata, e.metadata) as metadata
      FROM events e
      LEFT JOIN detection_files df ON e.file_path = df.storage_path OR e.file_path LIKE '%' || df.original_filename
      WHERE COALESCE(df.file_type, e.event_type) IN ('event_motion', 'event_face')
      ORDER BY COALESCE(df.capture_timestamp, e.timestamp) DESC LIMIT $1`,
      [limit],
    );
    return results.map((row: any) => {
      const confidence = this.extractConfidence(row.metadata);
      return {
        id: row.file_uuid,
        cameraId: row.camera_id || 'unknown',
        timestamp: row.capture_timestamp
          ? new Date(row.capture_timestamp).toISOString()
          : new Date().toISOString(),
        imagePath: row.storage_path,
        confidence,
        duration: 0,
        cameraName: row.camera_id,
        labels: [] as string[],
        location: 'Unknown',
      };
    });
  }

  async getCameraMotionEvents(cameraId: string, limit: number): Promise<any[]> {
    const results = await AppDataSource.query(
      `SELECT COALESCE(df.file_uuid::text, e.id::text) as id,
        COALESCE(df.camera_id, e.camera_id) as cameraId,
        COALESCE(df.capture_timestamp, e.timestamp) as timestamp,
        COALESCE(df.storage_path, e.file_path) as imagePath,
        COALESCE(df.metadata, e.metadata) as metadata
      FROM events e
      LEFT JOIN detection_files df ON e.file_path = df.storage_path OR e.file_path LIKE '%' || df.original_filename
      WHERE COALESCE(df.file_type, e.event_type) IN ('event_motion', 'event_face')
        AND COALESCE(df.camera_id, e.camera_id) = $1
      ORDER BY COALESCE(df.capture_timestamp, e.timestamp) DESC LIMIT $2`,
      [cameraId, limit],
    );
    return results.map((row: any) => {
      const confidence = this.extractConfidence(row.metadata);
      let labels = ['motion'];
      if (row.file_type === 'event_face') labels = ['face'];
      return {
        id: row.id,
        cameraId: row.cameraId || 'unknown',
        timestamp: new Date(row.timestamp).toISOString(),
        imagePath: `/events/${row.imagePath?.split('/').pop() || ''}`,
        confidence,
        duration: 0,
        cameraName: `Camera ${row.cameraId || 'unknown'}`,
        labels,
        location: `Camera ${row.cameraId || 'unknown'}`,
        imageUrl: `/events/${row.imagePath?.split('/').pop() || ''}`,
      };
    });
  }

  async getTodayEventCount(): Promise<number> {
    const result = await AppDataSource.query(
      `SELECT COUNT(*) as count FROM events e WHERE e.timestamp >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AND e.event_type IN ('motion', 'face', 'person', 'visitor', 'recognition', 'event_motion', 'event_face')`,
    );
    return parseInt(result[0].count);
  }

  async getCalendarStats(
    year: number,
    month: number,
    cameraId?: string,
  ): Promise<{
    data: Record<string, unknown>;
    summary: { totalEvents: number; totalPersons: number; avgConfidence: number };
  }> {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    const conditions = [
      'e.timestamp >= $1',
      'e.timestamp <= $2',
      "e.event_type IN ('motion', 'face', 'person', 'visitor', 'recognition', 'event_motion', 'event_face')",
    ];
    const params: any[] = [startDate.toISOString(), endDate.toISOString()];
    if (cameraId && cameraId !== 'all') {
      conditions.push(`e.camera_id = $${params.length + 1}`);
      params.push(cameraId);
    }

    const results = await AppDataSource.query(
      `SELECT DATE(e.timestamp) as date, COUNT(*) as count,
        COUNT(CASE WHEN e.event_type = 'motion' OR e.event_type = 'event_motion' THEN 1 END) as motion_count,
        COUNT(CASE WHEN e.event_type = 'face' OR e.event_type = 'event_face' THEN 1 END) as face_count,
        COUNT(CASE WHEN e.persons_detected > 0 THEN 1 END) as person_count,
        SUM(e.persons_detected) as total_persons,
        AVG(e.confidence) as avg_confidence
      FROM events e WHERE ${conditions.join(' AND ')} GROUP BY DATE(e.timestamp) ORDER BY date`,
      params,
    );

    const data: Record<string, unknown> = {};
    results.forEach((row: any) => {
      const dateKey =
        row.date instanceof Date
          ? row.date.toISOString().split('T')[0]
          : String(row.date).split('T')[0];
      data[dateKey] = {
        count: parseInt(row.count),
        motion: parseInt(row.motion_count) || 0,
        face: parseInt(row.face_count) || 0,
        persons: parseInt(row.total_persons) || 0,
        avgConfidence: parseFloat(row.avg_confidence) || 0,
      };
    });

    return {
      data,
      summary: {
        totalEvents: results.reduce((acc: number, r: any) => acc + parseInt(r.count), 0),
        totalPersons: results.reduce(
          (acc: number, r: any) => acc + (parseInt(r.total_persons) || 0),
          0,
        ),
        avgConfidence:
          results.length > 0
            ? results.reduce((acc: number, r: any) => acc + parseFloat(r.avg_confidence || 0), 0) /
              results.length
            : 0,
      },
    };
  }

  async getRangeStats(startDate: string, endDate: string, cameraId?: string): Promise<any> {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const conditions = [
      'e.timestamp >= $1',
      'e.timestamp <= $2',
      "e.event_type IN ('motion', 'face', 'person', 'visitor', 'recognition', 'event_motion', 'event_face')",
    ];
    const params: any[] = [start.toISOString(), end.toISOString()];
    if (cameraId && cameraId !== 'all') {
      conditions.push(`e.camera_id = $${params.length + 1}`);
      params.push(cameraId);
    }

    const result = await AppDataSource.query(
      `SELECT COUNT(*) as total_count,
        COUNT(CASE WHEN e.event_type = 'motion' OR e.event_type = 'event_motion' THEN 1 END) as motion_count,
        COUNT(CASE WHEN e.event_type = 'face' OR e.event_type = 'event_face' THEN 1 END) as face_count,
        SUM(e.persons_detected) as total_persons, SUM(e.faces_detected) as total_faces,
        SUM(e.known_faces_count) as known_faces, SUM(e.unknown_faces_count) as unknown_faces,
        AVG(e.confidence) as avg_confidence
      FROM events e WHERE ${conditions.join(' AND ')}`,
      params,
    );
    const row = result[0];
    return {
      totalEvents: parseInt(row.total_count) || 0,
      motionEvents: parseInt(row.motion_count) || 0,
      faceEvents: parseInt(row.face_count) || 0,
      totalPersons: parseInt(row.total_persons) || 0,
      totalFaces: parseInt(row.total_faces) || 0,
      knownFaces: parseInt(row.known_faces) || 0,
      unknownFaces: parseInt(row.unknown_faces) || 0,
      avgConfidence: parseFloat(row.avg_confidence) || 0,
    };
  }

  async listEventFiles(): Promise<string[]> {
    const results = await AppDataSource.query(
      `SELECT e.file_path FROM events e WHERE e.event_type IN ('motion', 'face', 'person', 'visitor', 'recognition', 'event_motion', 'event_face') ORDER BY e.timestamp DESC LIMIT 1000`,
    );
    return results.map((row: any) => {
      const p = row.file_path.split('/');
      return p[p.length - 1];
    });
  }

  async getEventDetails(id: string): Promise<any> {
    const event = await this.eventRepository.findOne({ where: { id } });
    if (!event) return null;

    const filename = event.file_path?.split('/').pop() ?? null;
    let persons_detected = event.persons_detected || 0;
    let faces_detected = event.faces_detected || 0;
    let known_faces_count = event.known_faces_count || 0;
    let unknown_faces_count = event.unknown_faces_count || 0;
    let object_detections = event.object_detections;
    let face_detections = event.face_detections;

    if (persons_detected === 0 && faces_detected === 0 && filename) {
      try {
        const processedResults = await AppDataSource.query(
          `SELECT person_count, face_count, known_face_count, unknown_face_count, detection_json
           FROM processed_images WHERE filename = $1 AND status = 'success' ORDER BY processed_at DESC LIMIT 1`,
          [filename],
        );
        if (processedResults.length > 0) {
          const p = processedResults[0];
          persons_detected = p.person_count || 0;
          faces_detected = p.face_count || 0;
          known_faces_count = p.known_face_count || 0;
          unknown_faces_count = p.unknown_face_count || 0;
          const detectionData =
            typeof p.detection_json === 'string' ? JSON.parse(p.detection_json) : p.detection_json;
          object_detections = detectionData.persons || [];
          face_detections = detectionData.faces || [];
        }
      } catch (err) {
        logger.warn('Failed to parse detection data JSON', 'EventSearch', err);
        object_detections = [];
        face_detections = [];
      }
    }

    const normalizedData = DetectionDataNormalizer.createDetectionStorageFormat(
      object_detections || [],
      face_detections || [],
    );

    return {
      id: event.id,
      event_type: event.event_type,
      filename,
      timestamp: event.timestamp,
      cameraId: event.camera_id,
      confidence: event.confidence || 0,
      metadata: event.metadata ? JSON.parse(event.metadata) : null,
      persons_detected: normalizedData.persons_detected,
      faces_detected: normalizedData.faces_detected,
      known_faces_count: normalizedData.known_faces_count,
      unknown_faces_count: normalizedData.unknown_faces_count,
      object_detections: normalizedData.object_detections,
      face_detections: normalizedData.face_detections,
    };
  }

  async lookupEventImagePath(filename: string): Promise<string | null> {
    let results = await AppDataSource.query(
      `SELECT file_path as storage_path FROM events WHERE file_path LIKE '%' || $1 LIMIT 1`,
      [filename],
    );
    if (results.length === 0) {
      results = await AppDataSource.query(
        `SELECT file_path as storage_path FROM events WHERE file_path = $1 LIMIT 1`,
        [filename],
      );
    }
    return results.length > 0 ? results[0].storage_path : null;
  }

  async getDetectionEvents(
    filters: DetectionEventFilters,
  ): Promise<{ events: any[]; count: number }> {
    const { limit = 50, type, cameraId, startDate, endDate } = filters;
    const conditions: string[] = ['timestamp IS NOT NULL'];
    const values: any[] = [];
    let paramIndex = 1;

    if (type) {
      if (type === 'person') {
        conditions.push(
          `(event_type IN ('person', 'visitor', 'recognition') OR COALESCE(persons_detected, 0) > 0)`,
        );
      } else if (type === 'face') {
        conditions.push(
          `(event_type IN ('face', 'event_face', 'recognition') OR COALESCE(faces_detected, 0) > 0)`,
        );
      } else if (type === 'motion') {
        conditions.push(`event_type IN ('motion', 'event_motion')`);
      } else {
        conditions.push(`event_type = $${paramIndex++}`);
        values.push(type);
      }
    } else {
      conditions.push(
        `event_type IN ('motion', 'face', 'person', 'visitor', 'recognition', 'event_motion', 'event_face')`,
      );
    }
    if (cameraId) {
      conditions.push(`camera_id = $${paramIndex++}`);
      values.push(cameraId);
    }
    if (startDate) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      values.push(new Date(startDate));
    }
    if (endDate) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      values.push(new Date(endDate));
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    values.push(limit);

    const results = await AppDataSource.query(
      `SELECT COALESCE(df.file_uuid::text, e.id::text) as file_uuid,
        COALESCE(df.file_type, e.event_type) as file_type,
        COALESCE(df.camera_id, e.camera_id) as camera_id,
        COALESCE(df.storage_path, e.file_path) as storage_path,
        COALESCE(df.capture_timestamp, e.timestamp) as capture_timestamp,
        COALESCE(df.metadata, e.metadata) as metadata,
        df.original_filename
      FROM events e
      LEFT JOIN detection_files df ON e.file_path = df.storage_path OR e.file_path LIKE '%' || df.original_filename
      ${whereClause}
      ORDER BY COALESCE(df.capture_timestamp, e.timestamp) DESC LIMIT $${paramIndex}`,
      values,
    );

    const events = results.map((row: any) => {
      let confidence = 0;
      if (row.metadata && typeof row.metadata === 'object') {
        if (row.metadata.confidence !== undefined) confidence = row.metadata.confidence;
        else if (row.metadata.persons?.length > 0)
          confidence = row.metadata.persons[0].confidence || 0;
        else if (row.metadata.faces?.length > 0) confidence = row.metadata.faces[0].confidence || 0;
      }
      const metadata = row.metadata
        ? typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : row.metadata
        : {};
      const persons_detected = metadata.personCount || metadata.persons?.length || 0;
      const faces_detected = metadata.faceCount || metadata.faces?.length || 0;
      const known_faces_count = metadata.knownFaces || 0;
      const unknown_faces_count = metadata.unknownFaces || 0;
      const object_detections = metadata.detections || metadata.persons || [];
      const face_detections = metadata.faces || [];
      const filename =
        row.original_filename || (row.storage_path ? row.storage_path.split('/').pop() || '' : '');
      return {
        id: filename,
        event_type: row.file_type === 'event_face' ? 'face' : 'motion',
        filename,
        timestamp: row.capture_timestamp
          ? new Date(row.capture_timestamp).toISOString()
          : new Date().toISOString(),
        cameraId: row.camera_id,
        confidence,
        metadata,
        imageUrl: `/api/events/image/${filename}`,
        persons_detected,
        faces_detected,
        known_faces_count,
        unknown_faces_count,
        object_detections: object_detections || [],
        face_detections: face_detections || [],
      };
    });

    return { events, count: events.length };
  }

  /**
   * Semantic search over events using pgvector embeddings.
   * Returns hybrid results: semantic candidates ∪ keyword matches, merged and ranked.
   */
  async semanticSearch(
    query: string,
    filters: {
      cameraId?: string;
      eventType?: string;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    } = {},
  ): Promise<{
    events: any[];
    total: number;
    semanticHits: number;
    keywordHits: number;
  }> {
    const embedding = await this.getEmbedding(query);
    if (!embedding || embedding.length === 0) {
      return { events: [], total: 0, semanticHits: 0, keywordHits: 0 };
    }

    const conditions: string[] = ['scene_embedding IS NOT NULL'];
    const keywordConditions: string[] = ['scene_embedding IS NOT NULL'];
    const keywordValues: unknown[] = [];
    let paramIndex = 1;

    if (filters.cameraId) {
      conditions.push(`camera_id = '${filters.cameraId.replace(/[^a-zA-Z0-9_-]/g, '')}'`);
      keywordConditions.push(`camera_id = $${paramIndex++}`);
      keywordValues.push(filters.cameraId);
    }
    if (filters.eventType) {
      conditions.push(`event_type = '${filters.eventType.replace(/[^a-zA-Z0-9_-]/g, '')}'`);
      keywordConditions.push(`event_type = $${paramIndex++}`);
      keywordValues.push(filters.eventType);
    }
    if (filters.startDate) {
      conditions.push(`timestamp >= '${filters.startDate.toISOString()}'`);
      keywordConditions.push(`timestamp >= $${paramIndex++}`);
      keywordValues.push(filters.startDate.toISOString());
    }
    if (filters.endDate) {
      conditions.push(`timestamp <= '${filters.endDate.toISOString()}'`);
      keywordConditions.push(`timestamp <= $${paramIndex++}`);
      keywordValues.push(filters.endDate.toISOString());
    }

    const limit = filters.limit || 20;

    // Inline the vector literal (validated finite floats only — no injection
    // surface) because the pg driver cannot infer param type inside <=> casts.
    const vecLiteral = `[${embedding.map((n) => Number(n.toFixed(6))).join(',')}]`;

    // 1. Semantic cosine distance search (top 50 candidates)
    const semanticQuery = `
      SELECT
        e.*,
        (scene_embedding <=> '${vecLiteral}') as distance,
        1 - (scene_embedding <=> '${vecLiteral}') as similarity
      FROM events e
      WHERE ${conditions.join(' AND ')}
      ORDER BY distance ASC
      LIMIT 50
    `;

    // 2. Keyword fallback (top 50)
    const keywordQuery = `
      SELECT e.*, 1 as distance, 1 as similarity
      FROM events e
      WHERE ${keywordConditions.join(' AND ')}
        AND (
          e.camera_id ILIKE $${paramIndex}
          OR e.file_path ILIKE $${paramIndex}
          OR e.metadata::text ILIKE $${paramIndex}
        )
      ORDER BY e.timestamp DESC
      LIMIT $${paramIndex + 1}
    `;
    keywordValues.push(`%${query}%`);
    keywordValues.push(50);

    const [semanticRows, keywordRows] = await Promise.all([
      AppDataSource.query(semanticQuery),
      AppDataSource.query(keywordQuery, keywordValues),
    ]);

    // Merge by id, prefer semantic rank
    const merged = new Map<string, any>();
    for (const row of semanticRows) {
      merged.set(row.id, { ...row, source: 'semantic' });
    }
    for (const row of keywordRows) {
      if (!merged.has(row.id)) {
        merged.set(row.id, { ...row, source: 'keyword' });
      }
    }

    const events = Array.from(merged.values())
      .sort((a, b) => (a.distance || 0) - (b.distance || 0))
      .slice(0, limit);

    return {
      events: events.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        timestamp: row.timestamp,
        cameraId: row.camera_id,
        confidence: row.confidence,
        personsDetected: row.persons_detected,
        facesDetected: row.faces_detected,
        knownFacesCount: row.known_faces_count,
        unknownFacesCount: row.unknown_faces_count,
        objectDetections: row.object_detections || [],
        faceDetections: row.face_detections || [],
        imageUrl: row.file_path ? `/api/events/image/${row.file_path.split('/').pop()}` : null,
        similarity: row.similarity,
        searchSource: row.source,
      })),
      total: merged.size,
      semanticHits: semanticRows.length,
      keywordHits: keywordRows.length,
    };
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    return getOpenCVClient().getEmbedding(text);
  }
}
