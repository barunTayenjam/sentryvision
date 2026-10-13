import { logger } from '../../utils/logger.js';
import { Repository } from 'typeorm';
import { ReviewSegment } from '../../models/ReviewSegment.js';
import { UserReviewStatus } from '../../models/UserReviewStatus.js';
import { cacheService } from '../cacheService.js';

interface ReviewQuery {
  camera?: string;
  after?: Date;
  before?: Date;
  severity?: 'alert' | 'detection';
  labels?: string[];
  reviewed?: boolean;
  userId?: string;
  limit?: number;
  offset?: number;
}

export interface ReviewSegmentEventInput {
  id: string;
  camera_id: string;
  timestamp: Date;
  severity: 'alert' | 'detection' | 'info';
  event_type: string;
  file_path?: string | null;
  object_detections?: Array<{ class: string; confidence?: number; trackId?: number }> | null;
}

interface SegmentBundle {
  objects: Map<string, { label: string; lastSeen: Date; score: number }>;
  startTime: Date;
  endTime: Date;
}

const ALERT_LABELS = ['person', 'car', 'vehicle', 'truck'];
const BUNDLE_THRESHOLD_MS = 30000;
const CACHE_TTL = 300;

export class ReviewService {
  constructor(
    private readonly reviewSegmentRepo: Repository<ReviewSegment>,
    private readonly reviewStatusRepo: Repository<UserReviewStatus>,
    private readonly timelineService: {
      getActiveObjects: (
        camera: string,
      ) => Promise<Map<string, { label: string; lastSeen: Date; score: number }>>;
    },
    private readonly previewService: {
      generatePreview: (segmentId: string, camera: string) => Promise<string>;
    },
  ) {}

  async getReviewSegments(query: ReviewQuery): Promise<{
    segments: ReviewSegment[];
    total: number;
    hasMore: boolean;
  }> {
    const cacheKey = `review:segments:${this.hashQuery(query)}`;
    const cached = await cacheService.getJSON(cacheKey);
    if (cached) return cached;

    const { camera, after, before, severity, labels, reviewed, userId, limit = 100, offset = 0 } =
      query;

    const queryBuilder = this.reviewSegmentRepo
      .createQueryBuilder('segment')
      .where('segment.start_time >= :after', { after: after || new Date(0) })
      .andWhere('segment.start_time <= :before', { before: before || new Date() });

    if (reviewed !== undefined && userId) {
      queryBuilder.leftJoin(
        'user_review_status',
        'urs',
        'urs.review_segment_id = segment.id AND urs.user_id = :userId AND urs.has_been_reviewed = true',
        { userId },
      );
      queryBuilder.andWhere(
        reviewed ? 'urs.review_segment_id IS NOT NULL' : 'urs.review_segment_id IS NULL',
        { userId },
      );
    }

    if (camera) {
      queryBuilder.andWhere('segment.camera = :camera', { camera });
    }

    if (severity) {
      queryBuilder.andWhere('segment.severity = :severity', { severity });
    }

    if (labels && labels.length > 0) {
      queryBuilder.andWhere('segment.labels @> :labels', { labels: JSON.stringify(labels) });
    }

    const [segments, total] = await queryBuilder
      .orderBy('segment.start_time', 'DESC')
      .skip(offset)
      .take(limit + 1)
      .getManyAndCount();

    const result = {
      segments: segments.slice(0, limit),
      total,
      hasMore: segments.length > limit,
    };

    await cacheService.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  async getReviewSegment(id: string): Promise<ReviewSegment | null> {
    return this.reviewSegmentRepo.findOne({ where: { id } });
  }

  async getSegmentReviewStatus(segmentId: string, userId: string): Promise<boolean> {
    const status = await this.reviewStatusRepo.findOne({
      where: { user_id: userId, review_segment_id: segmentId },
    });
    return status?.has_been_reviewed ?? false;
  }

  async acknowledgeSegment(
    segmentId: string,
    userId: string,
    action?: 'dismiss' | 'confirm',
  ): Promise<void> {
    const existing = await this.reviewStatusRepo.findOne({
      where: { user_id: userId, review_segment_id: segmentId },
    });

    if (existing) {
      await this.reviewStatusRepo.update(
        { user_id: userId, review_segment_id: segmentId },
        { has_been_reviewed: true, reviewed_at: new Date(), review_action: action || null },
      );
    } else {
      await this.reviewStatusRepo.save({
        user_id: userId,
        review_segment_id: segmentId,
        has_been_reviewed: true,
        reviewed_at: new Date(),
        review_action: action || null,
      });
    }

    await this.invalidateCache();
  }

  async generateReviewSegments(camera: string): Promise<void> {
    const activeObjects = await this.timelineService.getActiveObjects(camera);
    if (activeObjects.size === 0) return;

    const bundles = this.bundleObjects(activeObjects);

    for (const bundle of bundles) {
      const severity = this.calculateSeverity(bundle.objects);
      const labels = Array.from(new Set([...bundle.objects.values()].map((o) => o.label)));

      const segmentId = this.generateSegmentId(bundle.startTime, camera);

      const segment = this.reviewSegmentRepo.create({
        id: segmentId,
        camera,
        start_time: bundle.startTime,
        end_time: bundle.endTime,
        severity,
        labels,
        data: {
          object_count: bundle.objects.size,
          objects: Array.from(bundle.objects.entries()).map(([id, obj]) => ({
            id,
            label: obj.label,
            last_seen: obj.lastSeen.toISOString(),
            score: obj.score,
          })),
        },
      });

      await this.reviewSegmentRepo.save(segment);

      this.previewService.generatePreview(segmentId, camera).catch((err) => {
        logger.error(
          `Failed to generate preview for ${segmentId}: ${err.message}`,
          'ReviewService',
        );
      });
    }

    await this.invalidateCache();
  }

  // ── Event-driven segment upsert (used by detectionPersistence write path) ──

  static readonly BUNDLE_BUCKET_MS = 30000;

  segmentIdForEvent(cameraId: string, timestamp: Date): string {
    const bucket = Math.floor(timestamp.getTime() / ReviewService.BUNDLE_BUCKET_MS) * 30;
    return `rev_${cameraId}_${bucket}`;
  }

  async upsertSegmentFromEvent(event: ReviewSegmentEventInput): Promise<void> {
    try {
      if (!event.camera_id) return;
      if (event.severity !== 'alert' && event.severity !== 'detection') return;

      const segmentId = this.segmentIdForEvent(event.camera_id, event.timestamp);
      const bucketStart = new Date(
        Math.floor(event.timestamp.getTime() / ReviewService.BUNDLE_BUCKET_MS) *
          ReviewService.BUNDLE_BUCKET_MS,
      );
      const bucketEnd = new Date(
        bucketStart.getTime() + ReviewService.BUNDLE_BUCKET_MS - 1,
      );

      const classes = (event.object_detections ?? [])
        .map((d) => d.class)
        .filter((c) => typeof c === 'string' && c.length > 0);
      const labelSet = new Set<string>([...classes, event.event_type].filter(Boolean));
      const labels = Array.from(labelSet);

      const thumbnail = event.file_path ?? null;

      await this.reviewSegmentRepo.query(
        `INSERT INTO review_segments
           (id, camera, start_time, end_time, severity, labels, thumbnail_path, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7,
           jsonb_build_object('event_id', $8::text, 'event_type', $9::text))
         ON CONFLICT (id) DO UPDATE SET
           end_time = GREATEST(review_segments.end_time, EXCLUDED.end_time),
           severity = CASE WHEN EXCLUDED.severity = 'alert' THEN 'alert' ELSE review_segments.severity END,
           labels = (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements_text(
             review_segments.labels || EXCLUDED.labels) v),
           thumbnail_path = COALESCE(review_segments.thumbnail_path, EXCLUDED.thumbnail_path)`,
        [
          segmentId,
          event.camera_id,
          bucketStart.toISOString(),
          bucketEnd.toISOString(),
          event.severity,
          JSON.stringify(labels),
          thumbnail,
          event.id,
          event.event_type,
        ],
      );

      await cacheService.del('review:segments:*');
    } catch (err) {
      logger.error(
        `upsertSegmentFromEvent failed: ${err instanceof Error ? err.message : String(err)}`,
        'ReviewService',
      );
    }
  }

  async getUnreviewedCounts(userId: string): Promise<{ alert: number; detection: number }> {
    const rows: Array<{ severity: string; count: string }> = await this.reviewSegmentRepo.query(
      `SELECT s.severity AS severity, COUNT(*) AS count
       FROM review_segments s
       LEFT JOIN user_review_status urs
         ON urs.review_segment_id = s.id
        AND urs.user_id = $1
        AND urs.has_been_reviewed = true
       WHERE urs.review_segment_id IS NULL
       GROUP BY s.severity`,
      [userId],
    );
    const counts = { alert: 0, detection: 0 };
    for (const row of rows) {
      if (row.severity === 'alert') counts.alert = Number(row.count);
      else if (row.severity === 'detection') counts.detection = Number(row.count);
    }
    return counts;
  }

  async batchAcknowledge(
    segmentIds: string[],
    userId: string,
    action?: 'dismiss' | 'confirm',
  ): Promise<void> {
    if (segmentIds.length === 0) return;
    await this.reviewStatusRepo.query(
      `INSERT INTO user_review_status
         (user_id, review_segment_id, has_been_reviewed, reviewed_at, review_action)
       SELECT $1::text, seg_id, true, NOW(), $3::text
       FROM unnest($2::text[]) AS seg_id
       ON CONFLICT (user_id, review_segment_id) DO UPDATE SET
         has_been_reviewed = true,
         reviewed_at = NOW(),
         review_action = EXCLUDED.review_action`,
      [userId, segmentIds, action ?? null],
    );
    await this.invalidateCache();
  }

  private bundleObjects(
    activeObjects: Map<string, { label: string; lastSeen: Date; score: number }>,
  ): SegmentBundle[] {
    const bundles: SegmentBundle[] = [];
    const sortedObjects = Array.from(activeObjects.entries()).sort(
      (a, b) => a[1].lastSeen.getTime() - b[1].lastSeen.getTime(),
    );

    if (sortedObjects.length === 0) return bundles;

    const firstEntry = sortedObjects[0];
    let currentBundle: SegmentBundle = {
      objects: new Map<string, { label: string; lastSeen: Date; score: number }>().set(
        firstEntry[0],
        firstEntry[1],
      ),
      startTime: firstEntry[1].lastSeen,
      endTime: firstEntry[1].lastSeen,
    };

    for (let i = 1; i < sortedObjects.length; i++) {
      const [id, obj] = sortedObjects[i];
      const objectValues = Array.from(currentBundle.objects.values());
      const lastObjectTime =
        objectValues.length > 0 ? objectValues[objectValues.length - 1]?.lastSeen : null;

      if (
        lastObjectTime &&
        obj.lastSeen.getTime() - lastObjectTime.getTime() > BUNDLE_THRESHOLD_MS
      ) {
        bundles.push(currentBundle);
        currentBundle = {
          objects: new Map<string, { label: string; lastSeen: Date; score: number }>().set(id, obj),
          startTime: obj.lastSeen,
          endTime: obj.lastSeen,
        };
      } else {
        currentBundle.objects.set(id, obj);
        currentBundle.endTime = obj.lastSeen;
      }
    }

    bundles.push(currentBundle);
    return bundles;
  }

  private calculateSeverity(objects: Map<string, { label: string }>): 'alert' | 'detection' {
    const labels = Array.from(objects.values()).map((o) => o.label);
    return labels.some((l) => ALERT_LABELS.includes(l)) ? 'alert' : 'detection';
  }

  private generateSegmentId(startTime: Date, camera: string): string {
    const timestamp = startTime.getTime().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `segment_${camera}_${timestamp}_${random}`;
  }

  private hashQuery(query: ReviewQuery): string {
    return Buffer.from(JSON.stringify(query)).toString('base64').substring(0, 32);
  }

  private async invalidateCache(): Promise<void> {
    await cacheService.del('review:segments:*');
  }
}
