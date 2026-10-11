import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockSemanticSearch = jest.fn();

jest.unstable_mockModule('../../../services/eventSearchService.js', () => ({
  default: { semanticSearch: mockSemanticSearch },
  EventSearchService: class {},
}));

jest.unstable_mockModule('../../../database.js', () => ({
  AppDataSource: { query: jest.fn().mockResolvedValue([]) },
}));

const { semanticSearchParamsSchema, semanticSearchTool } = await import('../queryTools.js');

describe('semanticSearchParamsSchema', () => {
  it('requires a non-empty query', () => {
    expect(semanticSearchParamsSchema.safeParse({ query: '' }).success).toBe(false);
    expect(semanticSearchParamsSchema.safeParse({}).success).toBe(false);
  });

  it('accepts camera + limit and defaults limit to 5', () => {
    const parsed = semanticSearchParamsSchema.parse({ query: 'dog near gate', camera: 'cam1' });
    expect(parsed.camera).toBe('cam1');
    expect(parsed.limit).toBe(5);
  });

  it('rejects limit out of 1..10 bounds', () => {
    expect(semanticSearchParamsSchema.safeParse({ query: 'x', limit: 0 }).success).toBe(false);
    expect(semanticSearchParamsSchema.safeParse({ query: 'x', limit: 11 }).success).toBe(false);
  });
});

describe('semanticSearchTool', () => {
  const hits = [
    {
      id: 'evt-1',
      eventType: 'person',
      timestamp: '2026-10-10T14:30:00.000Z',
      cameraId: 'cam1',
      confidence: 0.9,
      personsDetected: 1,
      facesDetected: 0,
      objectDetections: [{ class: 'person', confidence: 90 }],
      imageUrl: '/api/events/image/x.jpg',
      similarity: 0.82,
      searchSource: 'semantic',
    },
    {
      id: 'evt-2',
      eventType: 'vehicle',
      timestamp: '2026-10-10T09:15:00.000Z',
      cameraId: 'cam2',
      confidence: 0.75,
      personsDetected: 0,
      facesDetected: 0,
      objectDetections: [{ class: 'car', confidence: 75 }],
      similarity: 0.64,
      searchSource: 'keyword',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockSemanticSearch.mockResolvedValue({
      events: hits,
      total: 2,
      semanticHits: 1,
      keywordHits: 1,
    });
  });

  it('calls eventSearchService with query + cameraId and default limit', async () => {
    await semanticSearchTool({ query: 'dog near gate', camera: null, limit: 5 });

    expect(mockSemanticSearch).toHaveBeenCalledWith('dog near gate', {
      cameraId: undefined,
      limit: 5,
    });
  });

  it('passes cameraId through when provided', async () => {
    await semanticSearchTool({ query: 'dog near gate', camera: 'cam2', limit: 3 });

    expect(mockSemanticSearch).toHaveBeenCalledWith('dog near gate', {
      cameraId: 'cam2',
      limit: 3,
    });
  });

  it('returns one row per hit with time, camera, objects and similarity', async () => {
    const { tables, evidence } = await semanticSearchTool({
      query: 'dog near gate',
      camera: null,
      limit: 5,
    });

    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(
      expect.arrayContaining(['When (IST)', 'Camera', 'Objects', 'Similarity']),
    );
    expect(tables[0].rows).toHaveLength(2);
    expect(tables[0].rows[0]).toEqual(
      expect.arrayContaining(['cam1', 'person', expect.any(String)]),
    );
    expect(evidence.events).toBe(2);
    expect(evidence.detections).toBe(2);
    expect(evidence.cameras).toEqual(['cam1', 'cam2']);
  });

  it('returns empty tables when nothing matches', async () => {
    mockSemanticSearch.mockResolvedValue({
      events: [],
      total: 0,
      semanticHits: 0,
      keywordHits: 0,
    });

    const { tables, evidence, images } = await semanticSearchTool({
      query: 'unicorn riding a bike',
      camera: null,
      limit: 5,
    });

    expect(tables).toHaveLength(0);
    expect(images).toHaveLength(0);
    expect(evidence.events).toBe(0);
    expect(evidence.window).toBe('no matches');
  });

  it('still returns base hits when relation/detection enrichment fails', async () => {
    const { AppDataSource } = await import('../../../database.js');
    (AppDataSource.query as jest.Mock).mockRejectedValue(new Error('db down'));

    const { tables } = await semanticSearchTool({ query: 'dog near gate', camera: null, limit: 5 });

    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(2);
  });

  it('sorts rows by similarity descending', async () => {
    const { tables } = await semanticSearchTool({ query: 'dog near gate', camera: null, limit: 5 });

    const sim0 = parseFloat(String(tables[0].rows[0][3]));
    const sim1 = parseFloat(String(tables[0].rows[1][3]));
    expect(sim0).toBeGreaterThanOrEqual(sim1);
  });
});
