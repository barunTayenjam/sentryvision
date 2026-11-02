import { logger } from '../utils/logger.js';
import { Request, Response } from 'express';
import { BaseController } from './BaseController.js';

export class AnalyticsController extends BaseController {
  async getStorageStats(req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const dbResult = await AppDataSource.query(
        `SELECT COALESCE(SUM(file_size), 0) as total_bytes FROM detection_files WHERE is_deleted = FALSE`,
      );
      const storageUsed = parseInt(dbResult[0]?.total_bytes) || 0;

      const { config } = await import('../config/index.js');
      let storageTotal = 0;
      try {
        const fs = await import('node:fs');
        const detectionsPath = config.storage.detectionsDir;
        if (fs.existsSync(detectionsPath)) {
          const stat = fs.statfsSync(detectionsPath);
          storageTotal = stat.blocks * stat.bsize;
        }
      } catch (err) {
        logger.warn('Failed to get filesystem storage stats', 'Analytics', err);
      }

      this.ok(res, { storageUsed, storageTotal });
    } catch (error) {
      this.serverError(res, error, 'getStorageStats');
    }
  }

  async getHourly(req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const startDate = (req.query.startDate as string) || new Date().toISOString().split('T')[0];
      const endDate = (req.query.endDate as string) || new Date().toISOString();

      const result = await AppDataSource.query(
        `SELECT EXTRACT(HOUR FROM timestamp) as hour, COUNT(*) as count
         FROM events
         WHERE timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
         GROUP BY hour
         ORDER BY hour`,
        [startDate, endDate],
      );

      const hourlyData = Array(24)
        .fill(null)
        .map((_, hour) => ({ hour, count: 0 }));
      result.forEach((row: { hour: number; count: number }) => {
        const h = parseInt(String(row.hour));
        if (h >= 0 && h < 24) {
          hourlyData[h].count = parseInt(String(row.count));
        }
      });

      this.ok(res, { hourlyData });
    } catch (error) {
      this.serverError(res, error, 'getHourly');
    }
  }

  async getWeekly(req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const weekAgoStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

      const rows: Array<{ d: string; count: number }> = await AppDataSource.query(
        `SELECT TO_CHAR(DATE(timestamp), 'YYYY-MM-DD') AS d, COUNT(*)::int AS count
         FROM events
         WHERE timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
         GROUP BY DATE(timestamp)`,
        [weekAgoStart, new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)],
      );
      const counts = new Map(rows.map((r) => [r.d, parseInt(String(r.count))]));

      const dailyBreakdown = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(weekAgoStart.getTime() + i * 24 * 60 * 60 * 1000);
        const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return { date: d, count: counts.get(d) ?? 0 };
      });

      this.ok(res, {
        weeklyData: {
          totalEvents: dailyBreakdown.reduce((s, day) => s + day.count, 0),
          dailyBreakdown,
        },
      });
    } catch (error) {
      this.serverError(res, error, 'getWeekly');
    }
  }

  async getMonthly(req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const monthAgoStart = new Date(todayStart.getTime() - 27 * 24 * 60 * 60 * 1000);

      const rows: Array<{ d: string; count: number }> = await AppDataSource.query(
        `SELECT TO_CHAR(DATE(timestamp), 'YYYY-MM-DD') AS d, COUNT(*)::int AS count
         FROM events
         WHERE timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
         GROUP BY DATE(timestamp)`,
        [monthAgoStart, new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)],
      );
      const counts = new Map(rows.map((r) => [r.d, parseInt(String(r.count))]));

      const daily = Array.from({ length: 28 }, (_, i) => {
        const date = new Date(monthAgoStart.getTime() + i * 24 * 60 * 60 * 1000);
        const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return counts.get(d) ?? 0;
      });

      const weeklyBreakdown = Array.from({ length: 4 }, (_, weekIndex) => ({
        week: `Week ${weekIndex + 1}`,
        count: daily.slice(weekIndex * 7, weekIndex * 7 + 7).reduce((s, c) => s + c, 0),
      }));

      this.ok(res, {
        monthlyData: {
          totalEvents: daily.reduce((s, c) => s + c, 0),
          weeklyBreakdown,
        },
      });
    } catch (error) {
      this.serverError(res, error, 'getMonthly');
    }
  }
  async getDailyInsights(req: Request, res: Response): Promise<void> {
    try {
      const { AppDataSource } = await import('../database.js');
      const dateParam = req.params.date || new Date().toISOString().split('T')[0];

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        this.badRequest(res, 'Invalid date format, expected YYYY-MM-DD');
        return;
      }

      const dayStart = `${dateParam} 00:00:00`;
      const dayEnd = `${dateParam} 23:59:59.999`;

      // Run sequentially — 16 parallel queries exhaust the pg pool
      // (other live queries hold connections; DB_POOL_MAX=20).
      const run = async (sql: string): Promise<Record<string, unknown>[]> =>
        AppDataSource.query(sql, [dayStart, dayEnd]);

      const totals = await run(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(persons_detected),0)::int AS persons,
                COALESCE(SUM(faces_detected),0)::int AS faces,
                COALESCE(SUM(known_faces_count),0)::int AS known_faces,
                COALESCE(SUM(unknown_faces_count),0)::int AS unknown_faces,
                MIN(timestamp) AS first_event,
                MAX(timestamp) AS last_event,
                COALESCE(SUM(persons_detected),0)::int AS total_persons,
                MAX(persons_detected) AS max_persons_per_event
         FROM events WHERE timestamp >= $1 AND timestamp <= $2`,
      );
      const byType = await run(
        `SELECT event_type, COUNT(*)::int AS count, ROUND(AVG(confidence)::numeric,3)::float AS avg_conf
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY event_type ORDER BY count DESC`,
      );
      const byCamera = await run(
        `SELECT camera_id, COUNT(*)::int AS count,
                COALESCE(SUM(persons_detected),0)::int AS persons
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY camera_id ORDER BY count DESC`,
      );
      const hourlyByType = await run(
        `SELECT EXTRACT(HOUR FROM timestamp)::int AS hour, event_type, COUNT(*)::int AS count
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY hour, event_type ORDER BY hour`,
      );
      const hourlyByThreat = await run(
        `SELECT EXTRACT(HOUR FROM timestamp)::int AS hour,
                threat_assessment->>'level' AS level, COUNT(*)::int AS count
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY hour, level ORDER BY hour`,
      );
      const objectClasses = await run(
        `SELECT det->>'class' AS obj_class, COUNT(*)::int AS count,
                ROUND(AVG((det->>'confidence')::numeric),1)::float AS avg_conf
         FROM events, jsonb_array_elements(object_detections) det
         WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY obj_class ORDER BY count DESC`,
      );
      const trackStates = await run(
        `SELECT det->>'trackState' AS state, COUNT(*)::int AS count
         FROM events, jsonb_array_elements(object_detections) det
         WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY state ORDER BY count DESC`,
      );
      const severityVsThreat = await run(
        `SELECT severity, threat_assessment->>'level' AS threat_level, COUNT(*)::int AS count
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY severity, threat_level`,
      );
      const bursts = await run(
        `SELECT TO_CHAR(TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM timestamp) / 300) * 300), 'HH24:MI') AS bucket,
                COUNT(*)::int AS count
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY FLOOR(EXTRACT(EPOCH FROM timestamp) / 300)
         ORDER BY FLOOR(EXTRACT(EPOCH FROM timestamp) / 300)`,
      );
      const confidence = await run(
        `SELECT event_type,
                ROUND(AVG(confidence)::numeric,3)::float AS avg,
                ROUND(MIN(confidence)::numeric,3)::float AS min,
                ROUND(MAX(confidence)::numeric,3)::float AS max
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY event_type`,
      );
      const gaps = await run(
        `WITH ordered AS (
           SELECT timestamp,
                  timestamp - LAG(timestamp) OVER (ORDER BY timestamp) AS gap
           FROM events WHERE timestamp >= $1 AND timestamp <= $2
         )
         SELECT TO_CHAR(timestamp, 'HH24:MI') AS from_time,
                ROUND(EXTRACT(EPOCH FROM gap) / 60)::int AS gap_minutes
         FROM ordered WHERE gap > interval '15 minutes'
         ORDER BY gap DESC LIMIT 10`,
      );
      const sceneContext = await run(
        `SELECT scene_context->>'weather' AS weather,
                scene_context->>'timeOfDay' AS tod,
                COUNT(*)::int AS count
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY weather, tod ORDER BY count DESC LIMIT 10`,
      );
      const uniqueTracks = await run(
        `SELECT camera_id,
                COUNT(DISTINCT det->>'trackId')::int AS unique_tracks
         FROM events, jsonb_array_elements(object_detections) det
         WHERE timestamp >= $1 AND timestamp <= $2 AND det->>'trackId' IS NOT NULL
         GROUP BY camera_id ORDER BY unique_tracks DESC`,
      );
      const cameraHourly = await run(
        `SELECT camera_id, EXTRACT(HOUR FROM timestamp)::int AS hour, COUNT(*)::int AS count
         FROM events WHERE timestamp >= $1 AND timestamp <= $2
         GROUP BY camera_id, hour ORDER BY camera_id, hour`,
      );
      const weekBaseline = await run(
        `WITH daily_counts AS (
           SELECT DATE(timestamp) AS d, COUNT(*)::int AS cnt
           FROM events WHERE timestamp >= $1::timestamp - interval '7 days' AND timestamp <= $2::timestamp
           GROUP BY d
         )
         SELECT ROUND(AVG(cnt))::int AS avg_daily_events,
                MIN(cnt) AS min_day,
                MAX(cnt) AS max_day
         FROM daily_counts`,
      );
      const recentHighThreat = await run(
        `SELECT id, timestamp, event_type, camera_id, severity,
                threat_assessment->>'level' AS threat_level,
                COALESCE(persons_detected,0) AS persons_detected,
                COALESCE(known_faces_count,0) AS known_faces,
                COALESCE(unknown_faces_count,0) AS unknown_faces
         FROM events
         WHERE timestamp >= $1 AND timestamp <= $2
           AND (threat_assessment->>'level' IN ('critical','high')
                OR severity = 'alert'
                OR unknown_faces_count > 0)
         ORDER BY timestamp DESC
         LIMIT 15`,
      );

      this.ok(res, {
        date: dateParam,
        totals: totals[0] || {},
        byType,
        byCamera,
        hourlyByType,
        hourlyByThreat,
        objectClasses,
        trackStates,
        severityVsThreat,
        bursts,
        confidence,
        gaps,
        sceneContext,
        uniqueTracks,
        cameraHourly,
        weekBaseline: weekBaseline[0] || { avg_daily_events: 0, min_day: 0, max_day: 0 },
        recentHighThreat,
      });
    } catch (error) {
      this.serverError(res, error, 'getDailyInsights');
    }
  }

}

export const analyticsController = new AnalyticsController();
