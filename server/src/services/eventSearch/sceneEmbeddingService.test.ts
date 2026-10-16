import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockGetEmbedding = jest.fn();
const mockQuery = jest.fn();

jest.unstable_mockModule('../../services/opencvMicroserviceClient.js', () => ({
  getOpenCVClient: () => ({ getEmbedding: mockGetEmbedding }),
}));

jest.unstable_mockModule('../../database.js', () => ({
  AppDataSource: { query: mockQuery, isInitialized: true },
}));

const { embedEventScene } = await import('./sceneEmbeddingService.js');

const baseEvent = {
  id: 'e1',
  event_type: 'person',
  severity: 'alert',
  camera_id: 'cam1',
  timestamp: new Date('2026-10-16T14:30:00+05:30'),
  object_detections: [{ class: 'person' }],
} as Parameters<typeof embedEventScene>[0];

describe('sceneEmbeddingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    mockQuery.mockResolvedValue([{ id: 'e1' }]);
  });

  it('embeds the caption and writes vector + caption back', async () => {
    await embedEventScene(baseEvent);

    expect(mockGetEmbedding).toHaveBeenCalledWith(expect.stringContaining('person'));
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE events SET scene_embedding'),
      expect.arrayContaining(['e1']),
    );
  });

  it('does not write when the embedder returns nothing', async () => {
    mockGetEmbedding.mockResolvedValue(null);
    await embedEventScene({ ...baseEvent, id: 'e2' });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
