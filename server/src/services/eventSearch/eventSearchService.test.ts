import { describe, it, expect, jest, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../../database.js', () => ({
  AppDataSource: {
    query: jest.fn(),
    getRepository: () => ({}),
  },
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));


describe('eventSearchService.getCameraMotionEvents', () => {
  let AppDataSource;
  let service;

  beforeAll(async () => {
    const dbMod = await import('../../database.js');
    AppDataSource = dbMod.AppDataSource;
    const mod = await import('./eventSearchService.js');
    service = mod.EventSearchService ? new mod.EventSearchService() : mod.default;
  });

  it('maps SQL aliases cameraId/imagePath into the returned event', async () => {
    AppDataSource.query.mockResolvedValue([
      {
        id: 'evt-abc',
        cameraId: 'cam1',
        timestamp: '2026-01-02T10:00:00.000Z',
        imagePath: '/data/detections/cam1_motion.jpg',
        metadata: JSON.stringify({ confidence: 0.9 }),
      },
    ]);

    const events = await service.getCameraMotionEvents('cam1', 20);
    expect(events).toHaveLength(1);
    expect(events[0].cameraId).toBe('cam1');
    expect(events[0].imagePath).toBe('/events/cam1_motion.jpg');
    expect(events[0].imageUrl).toBe('/events/cam1_motion.jpg');
  });

  it('falls back to "unknown" only when the row truly has no camera', async () => {
    AppDataSource.query.mockResolvedValue([
      {
        id: 'evt-def',
        cameraId: null,
        timestamp: '2026-01-02T10:00:00.000Z',
        imagePath: null,
        metadata: null,
      },
    ]);

    const events = await service.getCameraMotionEvents('cam1', 20);
    expect(events).toHaveLength(1);
    expect(events[0].cameraId).toBe('unknown');
    expect(events[0].cameraName).toBe('Camera unknown');
  });
});

describe('eventSearchService.listEnhanced', () => {
  let AppDataSource;
  let service;

  const baseRow = {
    id: 'evt-meta',
    event_type: 'person',
    timestamp: '2026-10-05T09:00:00.000Z',
    camera_id: 'cam1',
    confidence: 0.87,
    file_path: '/app/data/detections/2026-10/events/person.jpg',
    persons_detected: 1,
    faces_detected: 0,
    known_faces_count: 0,
    unknown_faces_count: 1,
    object_detections: [{ bbox: { x: 44, y: 60, width: 75, height: 120 }, class: 'person', trackId: 7 }],
    face_detections: [],
    metadata: JSON.stringify({
      bboxSpace: 'image',
      humanVerification: {
        verified: true,
        tier: 'pose',
        keypoints: 33,
        elapsedMs: 61,
        pose: { stance: 'standing', facing: 'side', arms_raised: false },
      },
    }),
  };

  beforeAll(async () => {
    const dbMod = await import('../../database.js');
    AppDataSource = dbMod.AppDataSource;
    const mod = await import('./eventSearchService.js');
    service = mod.EventSearchService ? new mod.EventSearchService() : mod.default;
  });

  it('passes the parsed metadata through so verification and pose reach the UI', async () => {
    AppDataSource.query
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([baseRow]);

    const { events } = await service.listEnhanced({ page: '1', pageSize: '10' });

    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      bboxSpace: 'image',
      humanVerification: {
        verified: true,
        tier: 'pose',
        keypoints: 33,
        pose: { stance: 'standing', facing: 'side' },
      },
    });
  });

  it('does not hide motion/vehicle events that carry no persons', async () => {
    AppDataSource.query.mockReset();
    AppDataSource.query
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([
        {
          ...baseRow,
          id: 'evt-vehicle',
          event_type: 'vehicle',
          persons_detected: 0,
          object_detections: [{ bbox: { x: 43, y: 164, width: 132, height: 87 }, class: 'truck', trackId: 3 }],
        },
      ]);

    const { events } = await service.listEnhanced({ page: '1', pageSize: '10' });

    expect(events).toHaveLength(1);
    const sql: string = AppDataSource.query.mock.calls[0][0];
    expect(sql).not.toMatch(/COALESCE\(e\.persons_detected, 0\) > 0/);
  });

  it('still applies the persons filter when the user asks for persons', async () => {
    AppDataSource.query.mockReset();
    AppDataSource.query
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([baseRow]);

    await service.listEnhanced({ page: '1', pageSize: '10', event_type: 'person' });

    const sql: string = AppDataSource.query.mock.calls[0][0];
    expect(sql).toMatch(/COALESCE\(e\.persons_detected, 0\) > 0/);
  });

  it('returns null metadata instead of a bare [] when the column is empty or malformed', async () => {
    AppDataSource.query
      .mockResolvedValueOnce([{ total: '2' }])
      .mockResolvedValueOnce([
        { ...baseRow, id: 'evt-null', metadata: null },
        { ...baseRow, id: 'evt-bad', metadata: 'not-json' },
      ]);

    const { events } = await service.listEnhanced({ page: '1', pageSize: '10' });

    expect(events[0].metadata).toBeNull();
    expect(events[1].metadata).toBeNull();
  });
});

