import { logger } from '../utils/logger.js';
import { AppDataSource } from '../database.js';
import { chatCompletion } from './nvidia/nvidiaClient.js';
import type { EventRelation } from '../types/event.js';

export interface RelationThreat {
  level: 'low' | 'medium' | 'high';
  confidence: number;
  reasoning: string;
  factors: string[];
  recommendedActions: string[];
  model?: string;
  assessedAt?: string;
}

export interface RelationThreatResponse {
  eventId: string;
  source: 'cache' | 'computed' | 'skipped';
  reason?: string;
  threat: RelationThreat | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_LEVELS = new Set(['low', 'medium', 'high']);

interface ThreatEventRow {
  id: string;
  camera_id: string | null;
  timestamp: Date;
  event_type: string;
  persons_detected: number;
  faces_detected: number;
  known_faces_count: number;
  unknown_faces_count: number;
  object_detections: unknown;
  motion_stats: unknown;
  relations: unknown;
}

interface RelationBoxDoc {
  x: number;
  y: number;
  width: number;
  height: number;
  class: string;
  color?: string;
}

function spatialDescriptor(box: RelationBoxDoc, imgW?: number, imgH?: number): string {
  const bits: string[] = [];
  if (imgW && imgH && imgW > 0 && imgH > 0) {
    const cx = (box.x + box.width / 2) / imgW;
    const cy = (box.y + box.height / 2) / imgH;
    bits.push(cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'center');
    bits.push(cy > 0.66 ? 'foreground' : cy < 0.33 ? 'background' : 'midground');
    const areaFrac = (box.width * box.height) / (imgW * imgH);
    bits.push(areaFrac > 0.15 ? 'large' : areaFrac < 0.01 ? 'small' : 'medium');
  }
  return bits.length ? ` (${bits.join(', ')})` : '';
}

function timeBucket(date: Date): string {
  const hour = date.getHours();
  if (hour >= 20 || hour < 5) return 'night';
  if (hour >= 18) return 'evening';
  if (hour < 8) return 'early morning';
  return 'daytime';
}

function describePersons(objectDetections: unknown): string[] {
  if (!Array.isArray(objectDetections)) return [];
  const out: string[] = [];
  for (const det of objectDetections) {
    if (!det || typeof det !== 'object') continue;
    const d = det as Record<string, unknown>;
    if (String(d.class ?? '') !== 'person') continue;
    const attrs = (d.personAttributes ?? null) as Record<string, unknown> | null;
    const bits: string[] = [];
    const identity = d.identity;
    if (typeof identity === 'string' && identity && identity !== 'unknown') {
      bits.push(`known: ${identity}`);
    } else if (d.humanVerified === true) {
      bits.push('identity unknown');
    }
    if (d.verificationTier) bits.push(`verified via ${d.verificationTier}`);
    const colors = attrs?.clothing_colors;
    if (Array.isArray(colors) && colors.length > 0) {
      bits.push(`${colors.join('/')} clothing`);
    } else if (attrs?.clothing) {
      bits.push(String(attrs.clothing));
    }
    if (attrs?.carryingItem && attrs.carryingItem !== 'none') {
      bits.push(`carrying ${attrs.carryingItem}`);
    }
    if (attrs?.armsRaised === true) bits.push('arms raised');
    if (attrs?.bodyLanguage && attrs.bodyLanguage !== 'neutral') {
      bits.push(`${attrs.bodyLanguage} body language`);
    }
    if (bits.length > 0) out.push(`- ${bits.join(', ')}`);
  }
  return out;
}

export function extractJson(raw: string): unknown {
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM response contained no JSON object');
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

export function normalizeThreat(parsed: unknown, model: string): RelationThreat {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM threat response is not an object');
  }
  const p = parsed as Record<string, unknown>;
  const level = String(p.level ?? '').toLowerCase();
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`LLM returned invalid threat level "${level}"`);
  }
  const confidenceRaw = Number(p.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
    : 50;
  const factors = Array.isArray(p.factors)
    ? p.factors.map((f) => String(f)).filter(Boolean).slice(0, 8)
    : [];
  const actions = Array.isArray(p.recommendedActions)
    ? p.recommendedActions.map((a) => String(a)).filter(Boolean).slice(0, 5)
    : [];
  return {
    level: level as RelationThreat['level'],
    confidence,
    reasoning: String(p.reasoning ?? '').slice(0, 600),
    factors,
    recommendedActions: actions,
    model,
    assessedAt: new Date().toISOString(),
  };
}

function buildPrompt(
  row: ThreatEventRow,
  relations: EventRelation[],
  boxes: RelationBoxDoc[],
  imgW?: number,
  imgH?: number,
): string {
  const time = new Date(row.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const relationLines = relations
    .map((r) => `${r.subject} -> ${r.predicate} -> ${r.object} (score ${r.score})`)
    .join('; ');
  const objectLines = boxes
    .map((b) => `- ${b.color ? `${b.color} ${b.class}` : b.class}${spatialDescriptor(b, imgW, imgH)}`)
    .join('\n');
  const personLines = describePersons(row.object_detections);
  const motion = (row.motion_stats ?? null) as Record<string, unknown> | null;
  const motionPct =
    motion && Number.isFinite(Number(motion.motion_percentage))
      ? `Motion coverage: ${Number(motion.motion_percentage).toFixed(1)}% of frame.`
      : '';

  return [
    `Camera: ${row.camera_id ?? 'unknown'}`,
    `Time: ${time} IST (${timeBucket(new Date(row.timestamp))})`,
    `Event type: ${row.event_type}`,
    `Persons detected: ${row.persons_detected}, faces: ${row.faces_detected} (known ${row.known_faces_count}, unknown ${row.unknown_faces_count})`,
    ...(personLines.length > 0 ? ['Person details:', ...personLines] : []),
    'Objects in frame:',
    objectLines,
    '',
    `Grounded scene relations: ${relationLines}`,
    motionPct,
    '',
    'Assess the security threat of this event using ONLY the facts above. Do not invent objects or people.',
    'Reply with strict JSON only, no markdown:',
    '{"level":"low|medium|high","confidence":0-100,"reasoning":"at most two sentences","factors":["short factual factors"],"recommendedActions":["short actions"]}',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export class RelationThreatService {
  async assessEventThreat(eventId: string): Promise<RelationThreatResponse | null> {
    if (!UUID_PATTERN.test(eventId)) {
      throw new Error('Invalid event id');
    }

    const rows = (await AppDataSource.query(
      `SELECT id, camera_id, timestamp, event_type, persons_detected, faces_detected,
              known_faces_count, unknown_faces_count, object_detections, motion_stats, relations
       FROM events WHERE id = $1 LIMIT 1`,
      [eventId],
    )) as ThreatEventRow[];
    const event = rows[0];
    if (!event) return null;

    if (event.relations && typeof event.relations === 'object' && !Array.isArray(event.relations)) {
      const doc = event.relations as { threat?: unknown; relations?: unknown };
      if (doc.threat && typeof doc.threat === 'object') {
        return { eventId, source: 'cache', threat: doc.threat as RelationThreat };
      }
      if (!Array.isArray(doc.relations) || doc.relations.length === 0) {
        return {
          eventId,
          source: 'skipped',
          reason: 'event has no scene relations to ground an assessment',
          threat: null,
        };
      }
      const docBoxes = (event.relations as { boxes?: RelationBoxDoc[] }).boxes ?? [];
      const imgW = (event.relations as { imageWidth?: number }).imageWidth;
      const imgH = (event.relations as { imageHeight?: number }).imageHeight;
      return this.compute(
        eventId,
        event,
        doc.relations as EventRelation[],
        docBoxes,
        imgW,
        imgH,
      );
    }

    return {
      eventId,
      source: 'skipped',
      reason: 'event has no stored relations document',
      threat: null,
    };
  }

  private async compute(
    eventId: string,
    event: ThreatEventRow,
    relations: EventRelation[],
    boxes: RelationBoxDoc[],
    imgW?: number,
    imgH?: number,
  ): Promise<RelationThreatResponse> {
    const prompt = buildPrompt(event, relations, boxes, imgW, imgH);
    const raw = await chatCompletion(
      'You are a home-security analyst. You assess camera events using ONLY the grounded facts provided — never invent objects or people. Respond with strict JSON, no markdown.',
      prompt,
      { temperature: 0, maxTokens: 500 },
    );
    const model = process.env.NVIDIA_MODEL || 'unknown';
    const threat = normalizeThreat(extractJson(raw), model);

    await AppDataSource.query(
      `UPDATE events SET relations = jsonb_set(relations, '{threat}', $1::jsonb, true)
       WHERE id = $2 AND jsonb_typeof(relations) = 'object'`,
      [JSON.stringify(threat), eventId],
    );
    logger.info(
      `RelationThreat: event ${eventId} -> ${threat.level} (${threat.confidence}%)`,
      'RelationThreat',
    );
    return { eventId, source: 'computed', threat };
  }
}

export const relationThreatService = new RelationThreatService();
