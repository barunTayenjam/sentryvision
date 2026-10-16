import { describe, it, expect } from '@jest/globals';
import { buildCaption } from './sceneCaptionService.js';

const baseEvent = {
  id: 'evt-1',
  event_type: 'person',
  severity: 'alert' as const,
  camera_id: 'cam1',
  timestamp: new Date('2026-10-16T14:30:00+05:30'),
  persons_detected: 1,
  faces_detected: 0,
  known_faces_count: 1,
  unknown_faces_count: 0,
  object_detections: [
    { class: 'person', confidence: 0.9 },
    { class: 'person', confidence: 0.8 },
    { class: 'car', confidence: 0.7 },
  ],
  scene_context: { environment: 'outdoor', lighting: 'daylight' } as Record<string, unknown>,
  motion_stats: { motion_percentage: 4.2 } as Record<string, unknown>,
  relations: [
    { subject: 'person', predicate: 'near', object: 'car', score: 0.8, subjectIndex: 0, objectIndex: 2 },
  ] as Array<{ subject: string; predicate: string; object: string; score: number }>,
};

describe('buildCaption', () => {
  it('describes the core event: type, camera, time of day', () => {
    const c = buildCaption(baseEvent);
    expect(c).toContain('person');
    expect(c).toContain('cam1');
    expect(c).toContain('afternoon');
  });

  it('lists detected object classes with counts', () => {
    const c = buildCaption(baseEvent);
    expect(c).toContain('2 person');
    expect(c).toContain('1 car');
  });

  it('renders relations as subject-predicate-object phrases', () => {
    const c = buildCaption(baseEvent);
    expect(c).toContain('person near car');
  });

  it('mentions scene context environment and lighting', () => {
    const c = buildCaption(baseEvent);
    expect(c).toContain('outdoor');
    expect(c).toContain('daylight');
  });

  it('mentions known vs unknown faces when present', () => {
    const c = buildCaption(baseEvent);
    expect(c).toContain('known person');
    expect(c).not.toContain('unknown person');

    const unknown = buildCaption({ ...baseEvent, known_faces_count: 0, unknown_faces_count: 2 });
    expect(unknown).toContain('2 unknown people');
  });

  it('survives missing optional fields', () => {
    const c = buildCaption({
      id: 'evt-2',
      event_type: 'motion',
      severity: 'info',
      camera_id: null,
      timestamp: new Date('2026-10-16T03:00:00+05:30'),
    } as Parameters<typeof buildCaption>[0]);
    expect(c).toContain('motion');
    expect(c).toContain('night');
    expect(c.length).toBeGreaterThan(5);
  });

  it('is deterministic for identical input', () => {
    expect(buildCaption(baseEvent)).toBe(buildCaption(baseEvent));
  });

  it('tolerates non-array relations and scene_context from raw DB rows', () => {
    const c = buildCaption({
      ...baseEvent,
      relations: {} as never,
      scene_context: null,
      object_detections: null as never,
    });
    expect(c).toContain('person event');
    expect(c).toContain('cam1');
  });
});
