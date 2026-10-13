import { apiClient } from './baseClient';

export interface DailyDigest {
  id: string;
  digest_date: string;
  title: string;
  body: string;
  url: string;
  event_count: number;
  detection_count: number;
  created_at: string;
}

export const digestService = {
  async list(limit = 30, offset = 0): Promise<DailyDigest[]> {
    const res = await apiClient.get<{ success: boolean; digests: DailyDigest[] }>(
      '/digests',
      { limit, offset },
    );
    return res.digests ?? [];
  },

  async latest(): Promise<DailyDigest | null> {
    const rows = await this.list(1, 0);
    return rows[0] ?? null;
  },

  async get(date: string): Promise<DailyDigest | null> {
    const res = await apiClient.get<{ success: boolean; digest: DailyDigest | null }>(
      `/digests/${encodeURIComponent(date)}`,
    );
    return res.digest ?? null;
  },

  async generate(): Promise<DailyDigest | null> {
    const res = await apiClient.post<{ success: boolean; digest: DailyDigest | null }>(
      '/digests/generate',
    );
    return res.digest ?? null;
  },
};
