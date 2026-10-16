import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockLlm = jest.fn();
const mockQuery = jest.fn();

jest.unstable_mockModule('../chatLlm.js', () => ({
  chatLlm: mockLlm,
  extractJsonObject: (s: string) => JSON.parse(s),
}));

jest.unstable_mockModule('../../../services/eventSearchService.js', () => ({
  default: { semanticSearch: jest.fn() },
  EventSearchService: class {},
}));

jest.unstable_mockModule('../../../database.js', () => ({
  AppDataSource: {
    query: mockQuery,
    getRepository: jest.fn().mockReturnValue({ find: jest.fn(), save: jest.fn() }),
    isInitialized: true,
  },
}));

const { runClassifiedChat } = await import('../chatService.js');

const classifyJson = JSON.stringify({
  tool: 'person_visits',
  params: { range: 'today', camera: null },
});

describe('chatService person_visits routing', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Call 1 = classification (returns classifyJson), call 2 = synthesis (returns link table text).
    mockLlm
      .mockResolvedValueOnce(classifyJson)
      .mockResolvedValue(
        '## 1 person visit (today)\n\n- unknown person — arrived 04:30, last seen 04:32 on cam1 (left-to-right)\n\nVisits = person tracks merged by 5-min gaps. Identity shows only after face enrollment.'
      );
  });

  it('routes who-came questions to person_visits and returns visit lines', async () => {
    mockQuery.mockResolvedValue([
      {
        track_id: 't1',
        camera_id: 'cam1',
        first_seen: new Date('2026-10-16T04:30:00Z'),
        last_seen: new Date('2026-10-16T04:32:00Z'),
        obs: 6,
        events: 2,
        first_x: 100,
        last_x: 420,
        identity: null,
      },
    ]);

    const res = await runClassifiedChat('who came today');

    expect(res.tool).toBe('person_visits');
    expect(res.answer.content).toContain('1 person visit');
    expect(res.answer.content).toContain('unknown person');
    expect(res.tables[0].rows).toHaveLength(1);
  });

  it('handles no visits honestly', async () => {
    mockQuery.mockResolvedValue([]);

    const res = await runClassifiedChat('did anyone come today');

    expect(res.tool).toBe('person_visits');
    expect(res.answer.content).toContain('No person visits');
  });
});
