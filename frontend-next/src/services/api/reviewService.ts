import { apiClient } from './baseClient';

export interface ReviewSegmentDTO {
  id: string;
  camera: string;
  start_time: string;
  end_time: string;
  severity: 'alert' | 'detection';
  labels: string[];
  thumbnail_path: string | null;
  preview_path: string | null;
  data?: Record<string, unknown>;
}

export interface ReviewSegmentsResponse {
  success: boolean;
  segments: ReviewSegmentDTO[];
  total: number;
  hasMore: boolean;
}

export interface ReviewFilters {
  camera?: string;
  severity?: 'alert' | 'detection';
  labels?: string;
  reviewed?: boolean;
  after?: string;
  before?: string;
  limit?: number | string;
  offset?: number | string;
  [key: string]: unknown;
}

export const reviewService = {
  async getSegments(filters: ReviewFilters = {}): Promise<ReviewSegmentsResponse> {
    return apiClient.get<ReviewSegmentsResponse>('/review/segments', filters);
  },

  async getCounts(): Promise<{ alert: number; detection: number }> {
    const res = await apiClient.get<{ success: boolean; counts: { alert: number; detection: number } }>(
      '/review/counts',
    );
    return res.counts;
  },

  async acknowledge(id: string, action?: 'dismiss' | 'confirm'): Promise<void> {
    await apiClient.post(`/review/segments/${encodeURIComponent(id)}/acknowledge`, { action });
  },

  async batchAcknowledge(ids: string[], action?: 'dismiss' | 'confirm'): Promise<void> {
    await apiClient.post('/review/segments/batch-acknowledge', { ids, action });
  },
};
