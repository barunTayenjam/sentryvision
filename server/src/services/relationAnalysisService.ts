import { logger } from '../utils/logger.js';
import { AppDataSource } from '../database.js';
import { relationsServiceClient } from './relationsServiceClient.js';
import { getOpenCVClient } from './opencvMicroserviceClient.js';
import type { EventRelation, RelationBox, RelationInputDetection } from '../types/event.js';

export interface EventRelationsResponse {
  eventId: string;
  source: 'cache' | 'computed' | 'unavailable';
  reason?: string;
  relations: EventRelation[];
  boxes?: RelationBox[];
}

interface StoredRelationsDoc {
  v: 1;
  imageWidth?: number;
  imageHeight?: number;
  boxes: RelationBox[];
  relations: EventRelation[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BOXES = 10;
const SCENE_NMS_IOU = 0.5;
const SAME_CLASS_NMS_IOU = 0.35;
const MIN_RELATION_SCORE = 0.35;
const MAX_RELATIONS = 3;

const DEFAULT_SCENE_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck',
  'dog', 'cat', 'bird', 'backpack', 'handbag', 'umbrella',
  'chair', 'couch', 'potted plant', 'dining table', 'bowl', 'bottle',
  'cup', 'wine glass', 'cell phone', 'laptop', 'tv', 'book',
  'clock', 'vase', 'sports ball', 'teddy bear', 'suitcase',
];
const SCENE_CLASSES = new Set(
  (process.env.RELATION_SCENE_CLASSES || DEFAULT_SCENE_CLASSES.join(','))
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean),
);

function numericBbox(bbox: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!bbox || typeof bbox !== 'object') return null;
  const b = bbox as Record<string, unknown>;
  const x = Number(b.x);
  const y = Number(b.y);
  const width = Number(b.width);
  const height = Number(b.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function countStrictlyValidDetections(detections: unknown): number {
  if (!Array.isArray(detections)) return 0;
  let count = 0;
  for (const det of detections) {
    if (!det || typeof det !== 'object') continue;
    const box = numericBbox((det as Record<string, unknown>).bbox);
    if (box && box.width > 0 && box.height > 0) count++;
  }
  return count;
}

function trackedBoxes(detections: unknown): RelationBox[] {
  if (!Array.isArray(detections)) return [];
  const out: RelationBox[] = [];
  for (const det of detections) {
    if (!det || typeof det !== 'object') continue;
    const record = det as Record<string, unknown>;
    const bbox = numericBbox(record.bbox);
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) continue;
    out.push({ ...bbox, class: String(record.class ?? 'object') });
  }
  return out;
}

function iou(a: RelationBox, b: RelationBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function mergeWithSceneBoxes(
  tracked: RelationBox[],
  scene: Array<RelationBox & { confidence: number }>,
): RelationBox[] {
  const kept = tracked.slice(0, MAX_BOXES);
  const sorted = [...scene].sort((a, b) => b.confidence - a.confidence);
  for (const s of sorted) {
    if (kept.length >= MAX_BOXES) break;
    if (s.width <= 0 || s.height <= 0) continue;
    const duplicate = kept.some((m) => {
      const overlap = iou(m, s);
      return overlap > SCENE_NMS_IOU || (m.class === s.class && overlap > SAME_CLASS_NMS_IOU);
    });
    if (!duplicate) kept.push({ x: s.x, y: s.y, width: s.width, height: s.height, class: s.class });
  }
  return kept;
}

function deduplicateRelations(relations: EventRelation[]): EventRelation[] {
  const bestPerPair = new Map<string, EventRelation>();
  for (const rel of relations) {
    if (rel.score < MIN_RELATION_SCORE) continue;
    const key = `${Math.min(rel.subjectIndex, rel.objectIndex)}-${Math.max(rel.subjectIndex, rel.objectIndex)}`;
    const existing = bestPerPair.get(key);
    if (!existing || rel.score > existing.score) bestPerPair.set(key, rel);
  }
  return [...bestPerPair.values()].sort((a, b) => b.score - a.score).slice(0, MAX_RELATIONS);
}

function toRelationPayload(boxes: RelationBox[]): RelationInputDetection[] {
  return boxes.map((b) => ({ bbox: { x: b.x, y: b.y, width: b.width, height: b.height }, class: b.class }));
}

export class RelationAnalysisService {
  async getEventRelations(eventId: string): Promise<EventRelationsResponse | null> {
    if (!UUID_PATTERN.test(eventId)) {
      throw new Error('Invalid event id');
    }

    const rows = (await AppDataSource.query(
      'SELECT id, file_path, object_detections, relations FROM events WHERE id = $1 LIMIT 1',
      [eventId],
    )) as Array<{ id: string; file_path: string | null; object_detections: unknown; relations: unknown }>;
    const event = rows[0];
    if (!event) return null;

    if (Array.isArray(event.relations)) {
      return { eventId, source: 'cache', relations: event.relations as EventRelation[] };
    }
    if (event.relations && typeof event.relations === 'object') {
      const doc = event.relations as Partial<StoredRelationsDoc>;
      if (Array.isArray(doc.relations)) {
        return {
          eventId,
          source: 'cache',
          relations: doc.relations,
          ...(Array.isArray(doc.boxes) ? { boxes: doc.boxes } : {}),
        };
      }
    }

    if (!event.file_path) {
      await this.persistRelations(eventId, []);
      return {
        eventId,
        source: 'unavailable',
        reason: 'no snapshot stored for this event',
        relations: [],
      };
    }

    const tracked = trackedBoxes(event.object_detections);
    const trackedValid = countStrictlyValidDetections(event.object_detections);
    let boxes: RelationBox[];
    let result;
    if (trackedValid >= 2) {
      boxes = tracked;
      result = await relationsServiceClient.analyzeRelations(event.file_path, toRelationPayload(boxes));
    } else {
      try {
        result = await relationsServiceClient.analyzeRelationsWithScene(
          event.file_path,
          toRelationPayload(tracked),
        );
        boxes = result.boxes ?? [];
      } catch (sceneError) {
        logger.warn(
          `RelationAnalysis: world scene detector failed for ${event.file_path}, using opencv fallback: ${sceneError instanceof Error ? sceneError.message : sceneError}`,
          'RelationAnalysis',
        );
        const scene = await this.detectSceneBoxes(event.file_path);
        boxes = mergeWithSceneBoxes(tracked, scene);
        if (boxes.length < 2) {
          await this.persistRelations(eventId, []);
          return {
            eventId,
            source: 'unavailable',
            reason: 'fewer than two detectable objects in snapshot',
            relations: [],
          };
        }
        result = await relationsServiceClient.analyzeRelations(event.file_path, toRelationPayload(boxes));
      }
    }
    if (boxes.length < 2) {
      await this.persistRelations(eventId, []);
      return {
        eventId,
        source: 'unavailable',
        reason: 'fewer than two detectable objects in snapshot',
        relations: [],
      };
    }
    const relations = deduplicateRelations(result.relations ?? []);
    await this.persistDoc(eventId, {
      v: 1,
      imageWidth: result.imageWidth,
      imageHeight: result.imageHeight,
      boxes,
      relations,
    });
    logger.info(
      `RelationAnalysis: event ${eventId} -> ${relations.length} relations over ${boxes.length} boxes (${result.processingTimeMs}ms)`,
      'RelationAnalysis',
    );
    return { eventId, source: 'computed', relations, boxes };
  }

  private async detectSceneBoxes(filePath: string): Promise<Array<RelationBox & { confidence: number }>> {
    try {
      const result = await getOpenCVClient().detectObjects(filePath);
      const detections = Array.isArray(result.detections) ? result.detections : [];
      const out: Array<RelationBox & { confidence: number }> = [];
      for (const d of detections) {
        const cls = String(d.class ?? 'object').toLowerCase();
        if (!SCENE_CLASSES.has(cls)) continue;
        const bbox = numericBbox(d.bbox);
        if (!bbox) continue;
        out.push({ ...bbox, class: cls, confidence: Number(d.confidence) || 0 });
      }
      return out;
    } catch (error) {
      logger.warn(
        `RelationAnalysis: scene detection unavailable for ${filePath}: ${error instanceof Error ? error.message : error}`,
        'RelationAnalysis',
      );
      return [];
    }
  }

  private async persistRelations(eventId: string, relations: EventRelation[]): Promise<void> {
    await AppDataSource.query('UPDATE events SET relations = $1::jsonb WHERE id = $2', [
      JSON.stringify(relations),
      eventId,
    ]);
  }

  private async persistDoc(eventId: string, doc: StoredRelationsDoc): Promise<void> {
    await AppDataSource.query('UPDATE events SET relations = $1::jsonb WHERE id = $2', [
      JSON.stringify(doc),
      eventId,
    ]);
  }
}

export const relationAnalysisService = new RelationAnalysisService();
