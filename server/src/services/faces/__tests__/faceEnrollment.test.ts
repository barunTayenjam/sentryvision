import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockPost = jest.fn();

jest.unstable_mockModule('../../opencvMicroserviceClient.js', () => ({
  getOpenCVClient: () => ({ post: mockPost }),
}));

const { enrollFace, listKnownFaces } = await import('../faceEnrollmentService.js');

describe('faceEnrollmentService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPost.mockResolvedValue({ data: { success: true } });
  });

  it('enrolls a face image with a name', async () => {
    await expect(enrollFace(Buffer.from([1, 2, 3]), 'barun')).resolves.toEqual({ success: true });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, form, opts] = mockPost.mock.calls[0];
    expect(path).toBe('/train-face');
    expect(typeof form.append).toBe('function');
    const ct = opts.headers?.['content-type'] ?? '';
    expect(ct).toMatch(/multipart\/form-data/);
  });

  it('lists known faces', async () => {
    mockPost.mockResolvedValue({
      data: { success: true, faces: [{ id: '0', name: 'barun', count: 2 }], count: 1 },
    });
    const res = await listKnownFaces();
    expect(mockPost).toHaveBeenCalledWith('/known-faces', {}, {});
    expect(res.faces).toHaveLength(1);
  });
});
