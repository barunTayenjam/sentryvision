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

describe('person_visits identity + action filtering', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockLlm.mockResolvedValue('{}');
  });

  it('passes who param through to the query when a person is named', async () => {
    mockLlm.mockResolvedValueOnce(
      JSON.stringify({
        tool: 'person_visits',
        params: { range: 'today', camera: null, who: 'dad', action: 'left' },
      }),
    );
    mockQuery.mockResolvedValue([
      {
        track_id: 't9',
        camera_id: 'cam1',
        first_seen: new Date('2026-11-03T02:00:00Z'),
        last_seen: new Date('2026-11-03T02:10:00Z'),
        obs: 20,
        events: 4,
        first_x: 600,
        last_x: 30,
        identity: 'dad',
      },
    ]);
    // Second LLM call is the answer synthesis over the link table.
    mockLlm.mockResolvedValueOnce('dad — arrived 07:30 am, last seen 07:40 am on cam1');

    const res = await runClassifiedChat('when did dad left');

    expect(res.tool).toBe('person_visits');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/identity/i);
    expect(params).toContain('dad');
    expect(res.answer.content).toContain('dad');
  });

  it('says plainly when the named person has no visits', async () => {
    mockLlm.mockResolvedValueOnce(
      JSON.stringify({
        tool: 'person_visits',
        params: { range: 'today', camera: null, who: 'dad', action: null },
      }),
    );
    mockQuery.mockResolvedValue([]);

    const res = await runClassifiedChat('did dad come today');

    expect(res.answer.content).toContain('dad');
    expect(res.answer.content).toMatch(/no.*visit/i);
  });
});
