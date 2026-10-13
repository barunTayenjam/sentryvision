import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockLlm = jest.fn();

jest.unstable_mockModule('../chatLlm.js', () => ({
  chatLlm: mockLlm,
  extractJsonObject: (s: string) => JSON.parse(s),
}));

const mockSemanticSearch = jest.fn();

jest.unstable_mockModule('../../../services/eventSearchService.js', () => ({
  default: { semanticSearch: mockSemanticSearch },
  EventSearchService: class {},
}));

jest.unstable_mockModule('../../../database.js', () => ({
  AppDataSource: { query: jest.fn().mockResolvedValue([]) },
}));

const { runClassifiedChat } = await import('../chatService.js');

describe('chatService semantic_search routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlm.mockResolvedValue(
      JSON.stringify({ tool: 'semantic_search', params: { query: 'dog near gate', camera: null } }),
    );
    mockSemanticSearch.mockResolvedValue({
      events: [
        {
          id: 'e1',
          eventType: 'motion',
          timestamp: '2026-10-10T14:30:00.000Z',
          cameraId: 'cam1',
          confidence: 0.8,
          personsDetected: 0,
          facesDetected: 0,
          objectDetections: [{ class: 'dog', confidence: 80 }],
          faceDetections: [],
          imageUrl: '/api/events/image/a.jpg',
          similarity: 0.71,
          searchSource: 'semantic',
        },
      ],
      total: 1,
      semanticHits: 1,
      keywordHits: 0,
    });
  });

  it('routes scene-description questions to semantic_search and returns matched event', async () => {
    const res = await runClassifiedChat('show me when the dog was near the gate');

    expect(res.tool).toBe('semantic_search');
    expect(mockSemanticSearch).toHaveBeenCalledWith('dog near gate', {
      cameraId: undefined,
      limit: 5,
    });
    expect(res.answer.content).toContain('dog near gate');
    expect(res.answer.content).toContain('cam1');
    expect(res.tables[0].rows).toHaveLength(1);
    expect(res.images).toHaveLength(1);
  });

  it('answers honestly when nothing matches', async () => {
    mockSemanticSearch.mockResolvedValue({
      events: [],
      total: 0,
      semanticHits: 0,
      keywordHits: 0,
    });

    const res = await runClassifiedChat('unicorn riding a bicycle');

    expect(res.tool).toBe('semantic_search');
    expect(res.tables).toHaveLength(0);
    expect(res.answer.content).toContain('Nothing in the archive matches');
  });

  it('rejects when LLM returns invalid params for semantic_search', async () => {
    mockLlm.mockResolvedValue(JSON.stringify({ tool: 'semantic_search', params: {} }));

    await expect(runClassifiedChat('find something')).rejects.toThrow('semantic search params');
  });
});
