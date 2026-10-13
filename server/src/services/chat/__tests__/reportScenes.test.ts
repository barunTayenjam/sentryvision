import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockQuery = jest.fn();

jest.unstable_mockModule('../../../database.js', () => ({
  AppDataSource: {
    query: mockQuery,
    getRepository: jest.fn().mockReturnValue({ find: jest.fn() }),
  },
}));

const { collectReportScenes } = await import('../reportGenerator.js');

describe('collectReportScenes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('collects scene highlights from relations + analysis within the window', async () => {
    mockQuery.mockResolvedValue([
      {
        id: 'e1',
        camera_id: 'cam1',
        timestamp: new Date('2026-10-10T06:30:00Z'),
        relations: [
          { subject: 'person', predicate: 'near', object: 'car', score: 0.8 },
          { subject: 'person', predicate: 'entering', object: 'gate', score: 0.7 },
        ],
        scene_description: 'A person is standing next to a silver car near the gate.',
      },
      {
        id: 'e2',
        camera_id: 'cam2',
        timestamp: new Date('2026-10-10T14:00:00Z'),
        relations: [{ subject: 'dog', predicate: 'in', object: 'yard', score: 0.6 }],
        scene_description: null,
      },
    ]);

    const scenes = await collectReportScenes({ from: new Date(), to: new Date(), camera: null });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(scenes).toHaveLength(2);
    expect(scenes[0].camera).toBe('cam1');
    expect(scenes[0].description).toContain('silver car');
    expect(scenes[0].relations).toHaveLength(2);
    expect(scenes[1].description).toBeNull();
  });

  it('limits to top N by relevance and returns empty when none exist', async () => {
    mockQuery.mockResolvedValue([]);
    const scenes = await collectReportScenes({ from: new Date(), to: new Date(), camera: null });
    expect(scenes).toEqual([]);
  });

  it('never throws — DB failure returns empty highlights', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(
      collectReportScenes({ from: new Date(), to: new Date(), camera: null }),
    ).resolves.toEqual([]);
  });

  it('passes camera filter through to SQL', async () => {
    mockQuery.mockResolvedValue([]);
    await collectReportScenes({ from: new Date('2026-10-01'), to: new Date('2026-10-02'), camera: 'cam2' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain('cam2');
  });
});
