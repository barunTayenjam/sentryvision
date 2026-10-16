import type { EventRelation } from '../../types/event.js';

export interface CaptionEvent {
  id: string;
  event_type: string;
  severity?: string;
  camera_id?: string | null;
  timestamp: Date | string;
  persons_detected?: number;
  faces_detected?: number;
  known_faces_count?: number;
  unknown_faces_count?: number;
  object_detections?: Array<{ class?: string }>;
  scene_context?: Record<string, unknown> | null;
  motion_stats?: Record<string, unknown> | null;
  relations?: EventRelation[] | null;
}

function timeOfDay(date: Date): string {
  const h = date.getHours();
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 20) return 'evening';
  return 'night';
}

export function buildCaption(ev: CaptionEvent): string {
  const date = typeof ev.timestamp === 'string' ? new Date(ev.timestamp) : ev.timestamp;
  const parts: string[] = [];

  parts.push(`${ev.event_type} event`);
  parts.push(timeOfDay(date));
  if (ev.camera_id) parts.push(`camera ${ev.camera_id}`);

  const counts = new Map<string, number>();
  const detections = Array.isArray(ev.object_detections) ? ev.object_detections : [];
  for (const d of detections) {
    const cls = d.class;
    if (cls) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  const classList = [...counts.entries()].map(([cls, n]) => `${n} ${cls}`);
  if (classList.length) parts.push(classList.join(', '));

  const known = ev.known_faces_count ?? 0;
  const unknown = ev.unknown_faces_count ?? 0;
  if (known > 0) parts.push(known === 1 ? 'known person' : `${known} known people`);
  if (unknown > 0) parts.push(unknown === 1 ? 'unknown person' : `${unknown} unknown people`);

  const scene = ev.scene_context ?? {};
  const env = typeof scene.environment === 'string' ? scene.environment : '';
  const lighting = typeof scene.lighting === 'string' ? scene.lighting : '';
  if (env) parts.push(env);
  if (lighting) parts.push(lighting);

  const relations = Array.isArray(ev.relations) ? ev.relations : [];
  for (const r of relations) {
    if (r.subject && r.predicate && r.object) parts.push(`${r.subject} ${r.predicate} ${r.object}`);
  }

  return parts.join(', ').replace(/\s+/g, ' ').trim();
}
