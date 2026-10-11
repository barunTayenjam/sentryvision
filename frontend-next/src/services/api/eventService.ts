// Event-related API methods extracted from ApiService.ts
import { MotionEvent, EventRelation, RelationBox, RelationThreat } from '@/types/security';
import { fetchWithRetry, ApiError, API_URL } from './baseClient';

// ==================== TYPES ====================

interface DetectionData {
  confidence: number;
  class?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  boundingBox?: number[];
  trackId?: number;
  trackState?: string | null;
  trackletLen?: number | null;
  classId?: number | null;
  identity?: string | null;
  identityConfidence?: number | null;
  humanVerified?: boolean;
  verificationTier?: string | null;
  personAttributes?: Record<string, unknown> | null;
}

interface FaceDetectionData {
  confidence: number;
  boundingBox?: number[];
  personId?: string;
  personName?: string;
  isKnown?: boolean;
}

interface BackendMotionEvent {
  id: string;
  cameraId: string;
  timestamp: string;
  imagePath: string;
  confidence: number;
  duration: number;
  cameraName?: string;
  labels?: string[];
  location?: string;
  archived?: boolean;
  metadata?: Record<string, unknown>;
  filename?: string;
  event_type?: string;
  imageUrl?: string;
}

export interface EnhancedEvent {
  id: string;
  event_type: string;
  filename: string;
  timestamp: string;
  cameraId: string;
  cameraName?: string;
  confidence: number;
  metadata: Record<string, unknown>;
  imageUrl: string;
  labels?: string[];
  severity?: 'alert' | 'detection' | 'info';
  persons_detected: number;
  faces_detected: number;
  known_faces_count: number;
  unknown_faces_count: number;
  object_detections: DetectionData[] | null;
  face_detections: FaceDetectionData[] | null;
  analysis?: {
    sceneDescription?: string;
    threatAssessment?: { level: string; factors: string[]; confidence: number };
    detectedEntities?: {
      people: string[];
      vehicles: string[];
      objects: string[];
      animals: string[];
    };
    recommendedActions?: string[];
    modelUsed?: string;
    processingTime?: number;
    analyzedAt?: string;
  } | null;
}

interface EnhancedEventsResponse {
  success: boolean;
  events: EnhancedEvent[];
  pagination?: { totalEvents: number; totalPages: number; currentPage: number; pageSize: number };
}

// ==================== EVENT SERVICE ====================

export const eventService = {
  async getDailyStats(): Promise<number> {
    try {
      const response = await fetchWithRetry(`${API_URL}/events/stats/today`);
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || 'Failed to fetch daily stats',
          response.status,
          'GET_DAILY_STATS_ERROR',
          data,
        );
      }
      return data.count;
    } catch (error) {
      console.error('Error fetching daily stats:', error);
      // Never fake a zero — callers must know the difference between a quiet
      // day and a failed request.
      throw error;
    }
  },

  async getMotionEvents(limit = 100): Promise<MotionEvent[]> {
    try {
      const response = await fetchWithRetry(`${API_URL}/motion/events?limit=${limit}`);
      const data = await response.json();
      if (!data.success || !data.events) {
        throw new ApiError(
          data.error || 'Failed to fetch motion events',
          response.status,
          'GET_MOTION_EVENTS_ERROR',
          data,
        );
      }
      return data.events.map((event: BackendMotionEvent) => ({
        ...event,
        timestamp: new Date(event.timestamp),
        cameraName: event.cameraName || event.cameraId || 'Unknown Camera',
        location: event.location || 'Unknown',
        labels: event.labels || ['motion'],
      }));
    } catch (error) {
      console.error('Error fetching motion events:', error);
      if (error instanceof ApiError) throw error;
      throw new ApiError('Failed to fetch motion events', 500, 'GET_MOTION_EVENTS_ERROR', {
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async getCameraMotionEvents(cameraId: string, limit = 20): Promise<MotionEvent[]> {
    try {
      const response = await fetchWithRetry(`${API_URL}/motion/${cameraId}/events?limit=${limit}`);
      const data = await response.json();
      if (!data.success || !data.events) {
        throw new ApiError(
          data.error || `Failed to fetch motion events for camera ${cameraId}`,
          response.status,
          'GET_CAMERA_MOTION_EVENTS_ERROR',
          data,
        );
      }
      return data.events.map((event: BackendMotionEvent) => ({
        ...event,
        timestamp: new Date(event.timestamp),
        cameraName: event.cameraName || event.cameraId || 'Unknown Camera',
        location: event.location || 'Unknown',
        labels: event.labels || ['motion'],
      }));
    } catch (error) {
      console.error(`Error fetching motion events for camera ${cameraId}:`, error);
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        `Failed to fetch motion events for camera ${cameraId}`,
        500,
        'GET_CAMERA_MOTION_EVENTS_ERROR',
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }
  },

  async getSnapshots(): Promise<string[]> {
    try {
      const response = await fetchWithRetry(`${API_URL}/snapshots/list`);
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || 'Failed to fetch snapshots',
          response.status,
          'GET_SNAPSHOTS_ERROR',
          data,
        );
      }
      return data.files || [];
    } catch (error) {
      console.error('Error fetching snapshots:', error);
      if (error instanceof ApiError) throw error;
      throw new ApiError('Failed to fetch snapshots', 500, 'GET_SNAPSHOTS_ERROR', {
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async getEventsList(): Promise<string[]> {
    try {
      const response = await fetchWithRetry(`${API_URL}/events/list`);
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || 'Failed to fetch events list',
          response.status,
          'GET_EVENTS_ERROR',
          data,
        );
      }
      return data.files || [];
    } catch (error) {
      console.error('Error fetching events list:', error);
      if (error instanceof ApiError) throw error;
      throw new ApiError('Failed to fetch events list', 500, 'GET_EVENTS_ERROR', {
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  getEventImageUrl(filename: string): string {
    if (!filename) {
      throw new ApiError('Filename is required', 400, 'INVALID_FILENAME', { filename });
    }
    return `/api/events/image/${filename}`;
  },

  getSnapshotImageUrl(filename: string): string {
    if (!filename) {
      throw new ApiError('Filename is required', 400, 'INVALID_FILENAME', { filename });
    }
    return `/snapshots/${filename}`;
  },

  async archiveEvent(id: string): Promise<void> {
    try {
      const response = await fetchWithRetry(`${API_URL}/events/${id}/archive`, { method: 'POST' });
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || `Failed to archive event ${id}`,
          response.status,
          'ARCHIVE_EVENT_ERROR',
          data,
        );
      }
    } catch (error) {
      console.error(`Error archiving event ${id}:`, error);
      if (error instanceof ApiError) throw error;
      throw new ApiError(`Failed to archive event ${id}`, 500, 'ARCHIVE_EVENT_ERROR', {
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async getEnhancedEventsList(options?: {
    limit?: number;
    page?: number;
    pageSize?: number;
    event_type?: string;
    camera_id?: string;
    start_date?: string;
    end_date?: string;
    searchQuery?: string;
    sortBy?: string;
    min_confidence?: number;
    confidence?: 'all' | 'high' | 'medium' | 'low';
    faceStatus?: 'all' | 'has_faces' | 'known_faces' | 'unknown_faces' | 'no_faces';
  }): Promise<EnhancedEventsResponse> {
    try {
      const params = new URLSearchParams();
      if (options) {
        if (options.limit) params.append('limit', options.limit.toString());
        if (options.page) params.append('page', options.page.toString());
        if (options.pageSize) params.append('pageSize', options.pageSize.toString());
        if (options.event_type) params.append('event_type', options.event_type);
        if (options.camera_id) params.append('camera_id', options.camera_id);
        if (options.start_date) params.append('start_date', options.start_date);
        if (options.end_date) params.append('end_date', options.end_date);
        if (options.searchQuery) params.append('searchQuery', options.searchQuery);
        if (options.sortBy) params.append('sortBy', options.sortBy);
        if (options.min_confidence !== undefined)
          params.append('min_confidence', options.min_confidence.toString());

        // Map confidence level to min/max confidence (DB stores 0-1 range)
        if (options.confidence && options.confidence !== 'all') {
          switch (options.confidence) {
            case 'high':
              params.append('min_confidence', '0.8');
              break;
            case 'medium':
              params.append('min_confidence', '0.5');
              params.append('max_confidence', '0.8');
              break;
            case 'low':
              params.append('max_confidence', '0.5');
              break;
          }
        }

        if (options.faceStatus && options.faceStatus !== 'all') {
          params.append('face_status', options.faceStatus);
        }
      }

      const response = await fetchWithRetry(`${API_URL}/events/list-enhanced?${params.toString()}`);
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || 'Failed to get enhanced events',
          response.status,
          'GET_ENHANCED_EVENTS_ERROR',
          data,
        );
      }
      return data as EnhancedEventsResponse;
    } catch (error) {
      console.error('Error fetching enhanced events list:', error);
      if (error instanceof ApiError) throw error;
      throw new ApiError('Failed to fetch enhanced events list', 500, 'GET_ENHANCED_EVENTS_ERROR', {
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async getCalendarStats(
    year: number,
    month: number,
    cameraId?: string,
  ): Promise<{
    data: Record<
      string,
      { count: number; motion: number; face: number; persons: number; avgConfidence: number }
    >;
    summary: { totalEvents: number; totalPersons: number; avgConfidence: number };
  }> {
    try {
      const params = new URLSearchParams({ year: String(year), month: String(month) });
      if (cameraId && cameraId !== 'all') params.append('camera_id', cameraId);
      const response = await fetchWithRetry(
        `${API_URL}/events/stats/calendar?${params.toString()}`,
      );
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || 'Failed to fetch calendar stats',
          response.status,
          'GET_CALENDAR_STATS_ERROR',
          data,
        );
      }
      return { data: data.data, summary: data.summary };
    } catch (error) {
      console.error('Error fetching calendar stats:', error);
      throw error;
    }
  },

  async semanticSearch(
    query: string,
    options?: {
      cameraId?: string;
      eventType?: string;
      limit?: number;
    },
  ): Promise<{
    events: Array<
      EnhancedEvent & {
        similarity?: number;
        searchSource?: 'semantic' | 'keyword';
      }
    >;
    total: number;
    semanticHits: number;
    keywordHits: number;
  }> {
    try {
      const params = new URLSearchParams({ q: query });
      if (options?.cameraId) params.append('cameraId', options.cameraId);
      if (options?.eventType) params.append('eventType', options.eventType);
      if (options?.limit) params.append('limit', String(options.limit));
      const response = await fetchWithRetry(
        `${API_URL}/events/semantic?${params.toString()}`,
      );
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || 'Failed to run semantic search',
          response.status,
          'SEMANTIC_SEARCH_ERROR',
          data,
        );
      }
      return data;
    } catch (error) {
      console.error('Error running semantic search:', error);
      if (error instanceof ApiError) throw error;
      throw new ApiError('Failed to run semantic search', 500, 'SEMANTIC_SEARCH_ERROR', {
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async getRangeStats(
    startDate: Date,
    endDate: Date,
    cameraId?: string,
  ): Promise<{
    totalEvents: number;
    motionEvents: number;
    faceEvents: number;
    totalPersons: number;
    totalFaces: number;
    knownFaces: number;
    unknownFaces: number;
    avgConfidence: number;
  }> {
    try {
      const params = new URLSearchParams({
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
      });
      if (cameraId && cameraId !== 'all') params.append('camera_id', cameraId);
      const response = await fetchWithRetry(`${API_URL}/events/stats/range?${params.toString()}`);
      const data = await response.json();
      if (!data.success) {
        throw new ApiError(
          data.error || 'Failed to fetch range stats',
          response.status,
          'GET_RANGE_STATS_ERROR',
          data,
        );
      }
      return data.stats;
    } catch (error) {
      console.error('Error fetching range stats:', error);
      throw error;
    }
  },

  async getEventRelations(eventId: string): Promise<{
    eventId: string;
    source: 'cache' | 'computed' | 'unavailable';
    reason?: string;
    relations: EventRelation[];
    boxes?: RelationBox[];
  }> {
    try {
      const response = await fetchWithRetry(`${API_URL}/events/${eventId}/relations`);
      const data = await response.json();
      if (!data.success && !data.relations) {
        throw new ApiError(
          data.error || 'Failed to fetch event relations',
          response.status,
          'GET_EVENT_RELATIONS_ERROR',
          data,
        );
      }
      return {
        eventId: data.eventId ?? eventId,
        source: data.source ?? 'unavailable',
        reason: data.reason,
        relations: Array.isArray(data.relations) ? data.relations : [],
        boxes: Array.isArray(data.boxes) ? data.boxes : undefined,
      };
    } catch (error) {
      console.error('Error fetching event relations:', error);
      throw error;
    }
  },

  async getEventRelationThreat(eventId: string): Promise<{
    eventId: string;
    source: 'cache' | 'computed' | 'skipped';
    reason?: string;
    threat: RelationThreat | null;
  }> {
    try {
      const response = await fetchWithRetry(`${API_URL}/events/${eventId}/relation-threat`);
      const data = await response.json();
      if (!data.success && !data.eventId) {
        throw new ApiError(
          data.error || 'Failed to fetch relation threat',
          response.status,
          'GET_RELATION_THREAT_ERROR',
          data,
        );
      }
      return {
        eventId: data.eventId ?? eventId,
        source: data.source ?? 'skipped',
        reason: data.reason,
        threat: data.threat ?? null,
      };
    } catch (error) {
      console.error('Error fetching relation threat:', error);
      throw error;
    }
  },
};
