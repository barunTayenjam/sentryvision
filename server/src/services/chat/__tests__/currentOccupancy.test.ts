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

describe('current_occupancy tool for real-time vehicle/person counts', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockLlm.mockResolvedValue('{}');
  });

  it('routes current vehicle count questions to current_occupancy', async () => {
    mockLlm.mockResolvedValueOnce(
      JSON.stringify({
        tool: 'current_occupancy',
        params: { objectClass: 'vehicle', camera: null },
      }),
    );
    mockQuery.mockResolvedValue([
      { camera_id: 'cam1', class: 'car', track_id: 'v1', last_seen: new Date(), confidence: 90 },
      { camera_id: 'cam1', class: 'car', track_id: 'v2', last_seen: new Date(), confidence: 85 },
      { camera_id: 'cam2', class: 'car', track_id: 'v3', last_seen: new Date(), confidence: 75 },
    ]);

    const res = await runClassifiedChat('how many vehicles are there currently');

    expect(res.tool).toBe('current_occupancy');
    expect(res.answer.content).toMatch(/3 vehicles? currently/i);
  });

  it('handles zero current vehicles', async () => {
    mockLlm.mockResolvedValueOnce(
      JSON.stringify({
        tool: 'current_occupancy',
        params: { objectClass: 'vehicle', camera: null },
      }),
    );
    mockQuery.mockResolvedValue([]);

    const res = await runClassifiedChat('any cars right now');

    expect(res.answer.content).toMatch(/no vehicles? currently/i);
  });
});