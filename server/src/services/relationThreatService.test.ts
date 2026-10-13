import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../database.js', () => ({
  AppDataSource: { query: jest.fn() },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const chatCompletionMock = jest.fn();
jest.unstable_mockModule('./nvidia/nvidiaClient.js', () => ({
  chatCompletion: chatCompletionMock,
}));

const EVENT_ROW = {
  id: 'evt-1',
  camera_id: 'cam1',
  timestamp: new Date('2026-10-06T14:26:31Z'),
  event_type: 'person',
  persons_detected: 2,
  faces_detected: 1,
  known_faces_count: 0,
  unknown_faces_count: 1,
  object_detections: [
    {
      class: 'person',
      identity: 'unknown',
      humanVerified: true,
      verificationTier: 'face',
      personAttributes: {
        clothing_colors: ['white'],
        carryingItem: 'none',
        bodyLanguage: 'neutral',
      },
    },
  ],
  motion_stats: { motion_percentage: 46.9 },
  relations: {
    v: 1,
    imageWidth: 2304,
    imageHeight: 1296,
    boxes: [
      { class: 'motorcycle', color: 'blue', x: 0, y: 500, width: 220, height: 400 },
      { class: 'person', x: 976, y: 623, width: 233, height: 488 },
    ],
    relations: [
      { subject: 'person', predicate: 'walking toward', object: 'motorcycle', score: 0.57, subjectIndex: 0, objectIndex: 1 },
    ],
  },
};

const LLM_JSON =
  '{"level":"medium","confidence":72,"reasoning":"An unknown person is walking toward a motorcycle at night.","factors":["unknown face","approaching vehicle"],"recommendedActions":["monitor live view"]}';

describe('relationThreatService', () => {
  let AppDataSource: { query: jest.Mock };
  let service: { assessEventThreat(id: string): Promise<unknown> };
  let mod: typeof import('./relationThreatService.js');

  beforeAll(async () => {
    const dbMod = await import('../database.js');
    AppDataSource = dbMod.AppDataSource;
    mod = await import('./relationThreatService.js');
    service = mod.relationThreatService;
  });

  beforeEach(() => {
    AppDataSource.query.mockReset();
    chatCompletionMock.mockReset();
    chatCompletionMock.mockResolvedValue(LLM_JSON);
  });

  it('rejects ids that are not uuids', async () => {
    await expect(service.assessEventThreat('nope')).rejects.toThrow('Invalid event id');
  });

  it('returns null when the event does not exist', async () => {
    AppDataSource.query.mockResolvedValue([]);
    await expect(service.assessEventThreat('11111111-1111-4111-8111-111111111111')).resolves.toBeNull();
  });

  it('serves a cached threat without calling the LLM', async () => {
    AppDataSource.query.mockResolvedValue([
      { ...EVENT_ROW, relations: { ...EVENT_ROW.relations, threat: { level: 'low', confidence: 40 } } },
    ]);

    const result = (await service.assessEventThreat('11111111-1111-4111-8111-111111111111')) as {
      source: string;
      threat: { level: string };
    };

    expect(result.source).toBe('cache');
    expect(result.threat.level).toBe('low');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('skips events whose relations document has no triplets', async () => {
    AppDataSource.query.mockResolvedValue([
      { ...EVENT_ROW, relations: { v: 1, boxes: [], relations: [] } },
    ]);

    const result = (await service.assessEventThreat('22222222-2222-4222-8222-222222222222')) as {
      source: string;
      reason?: string;
    };

    expect(result.source).toBe('skipped');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('computes a grounded assessment and persists it into the relations doc', async () => {
    AppDataSource.query.mockResolvedValue([EVENT_ROW]);

    const result = (await service.assessEventThreat('33333333-3333-4333-8333-333333333333')) as {
      source: string;
      threat: import('./relationThreatService.js').RelationThreat;
    };

    expect(result.source).toBe('computed');
    expect(result.threat.level).toBe('medium');
    expect(result.threat.confidence).toBe(72);
    expect(result.threat.factors).toEqual(['unknown face', 'approaching vehicle']);

    const prompt = chatCompletionMock.mock.calls[0][1] as string;
    expect(prompt).toContain('person -> walking toward -> motorcycle');
    expect(prompt).toContain('blue motorcycle (left');
    expect(prompt).toContain('Person details:');
    expect(prompt).toContain('identity unknown');
    expect(prompt).toContain('white clothing');
    expect(prompt).toContain('Motion coverage: 46.9%');

    const update = AppDataSource.query.mock.calls.find((c) =>
      String(c[0]).includes('jsonb_set'),
    );
    expect(update).toBeDefined();
    const persisted = JSON.parse(update![1][0]);
    expect(persisted.level).toBe('medium');
    expect(persisted.assessedAt).toBeDefined();
  });

  it('parses fenced markdown JSON and clamps out-of-range values', () => {
    const parsed = mod.extractJson('Sure!\n```json\n{"level":"high","confidence":250}\n```');
    const threat = mod.normalizeThreat(parsed, 'test-model');

    expect(threat.level).toBe('high');
    expect(threat.confidence).toBe(100);
    expect(threat.model).toBe('test-model');
  });

  it('rejects LLM output with an invalid level', () => {
    expect(() => mod.normalizeThreat({ level: 'extreme' }, 'm')).toThrow('invalid threat level');
  });

  it('throws cleanly when the LLM returns no JSON', () => {
    AppDataSource.query.mockResolvedValue([EVENT_ROW]);
    chatCompletionMock.mockResolvedValue('I cannot assess that.');

    return expect(
      service.assessEventThreat('44444444-4444-4444-8444-444444444444'),
    ).rejects.toThrow('no JSON object');
  });
});
