import { logger } from '../../utils/logger.js';
import { AppDataSource } from '../../database.js';
import NotificationService from '../notificationService.js';
import { collectReportScenes, collectReportStats } from './reportGenerator.js';
import { fmtIstTime } from './queryTools.js';

export interface DigestPayload {
  title: string;
  body: string;
  url: string;
}

function istDayRange(): { from: Date; to: Date; label: string } {
  // IST midnight boundaries for "yesterday".
  const nowIst = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
  const y = new Date(nowIst);
  y.setUTCDate(y.getUTCDate() - 1);
  const day = y.toISOString().slice(0, 10);
  const from = new Date(`${day}T00:00:00+05:30`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to, label: day };
}

/**
 * Build the concise yesterday digest: totals, humans, vehicles with
 * arrived/left, peak hours, threat share, and one scene highlight.
 * Concise but complete — the same six-line shape the user approved.
 */
export async function buildYesterdayDigest(): Promise<DigestPayload> {
  const { from, to, label } = istDayRange();
  const stats = await collectReportStats({ from, to, camera: null });
  const scenes = await collectReportScenes({ from, to, camera: null });

  if (stats.totals.events === 0) {
    return {
      title: `Daily digest — ${label}`,
      body: `No events recorded yesterday (${label}) on any camera.`,
      url: '/events',
    };
  }

  const fmtN = (n: number) => n.toLocaleString('en-IN');
  const padHour = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const fmtPeople = (n: number) => (n === 1 ? '1 person' : `${fmtN(n)} people`);

  const lines: string[] = [];
  lines.push(
    `**${label}** — ${fmtN(stats.totals.events)} events, ${fmtN(stats.totals.detections)} detections, ${stats.cameras.length} camera${stats.cameras.length === 1 ? '' : 's'} (${stats.cameras.join(', ') || '—'}).`,
  );
  lines.push(
    `**People:** ${fmtPeople(stats.humans.unique)} (${fmtN(stats.humans.detections)} detections, ${fmtN(stats.humans.verified)} verified)`,
  );

  if (stats.vehicles.length > 0) {
    const vlines = stats.vehicles.map(
      (v) =>
        `${v.class}s ${v.tracks} tracks/${fmtN(v.detections)} detections (${v.arrived} arrived, ${v.left} left)`,
    );
    lines.push(`**Vehicles:** ${fmtN(stats.vehicles.reduce((a, v) => a + v.detections, 0))} detections — ${vlines.join(', ')}`);
  }

  if (stats.busyHours.length > 0) {
    const peaks = stats.busyHours.slice(0, 3).map((h) => `${padHour(h.hour)} (${fmtN(h.detections)})`);
    lines.push(`**Peaks:** ${peaks.join(' · ')}`);
  }

  // Threat share: count distinct high/critical events over all assessed.
  const critical = stats.threats.filter((t) => t.level === 'critical' || t.level === 'high');
  const threatEvents = critical.reduce((a, t) => a + t.events, 0);
  const threatPct =
    stats.totals.events > 0 ? Math.round((threatEvents / stats.totals.events) * 100) : 0;
  if (threatEvents > 0) {
    lines.push(`**Threat:** ${threatEvents}/${fmtN(stats.totals.events)} events high/critical (${threatPct}%)`);
  } else {
    lines.push(`**Threat:** nothing above medium`);
  }

  // One highlight — the most recent analyzed scene, else longest track.
  const top = scenes[0];
  const longest = stats.longestTracks[0];
  if (top?.description) {
    const time = top.timestamp.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    lines.push(`**Highlight:** ${time} ${top.camera} — ${top.description}`);
  } else if (longest) {
    lines.push(
      `**Longest stay:** ${longest.class} on ${longest.camera ?? '?'} ${fmtIstTime(longest.first)} → ${fmtIstTime(longest.last)} (track ${longest.trackId})`,
    );
  }

  return {
    title: `Daily digest — ${label}`,
    body: lines.join('\n'),
    url: '/events',
  };
}

/** Push yesterday's digest to every user with an active push subscription. */
export async function sendDailyDigest(): Promise<{ pushed: number; failed: number }> {
  const digest = await buildYesterdayDigest();
  return pushDigestToSubscribers(digest);
}

async function pushDigestToSubscribers(
  digest: DigestPayload,
): Promise<{ pushed: number; failed: number }> {
  let rows: Array<{ user_id: string }>;
  try {
    rows = (await AppDataSource.query(
      `SELECT DISTINCT s.user_id
       FROM notification_subscriptions s
       WHERE s.is_active = true`,
    )) as Array<{ user_id: string }>;
  } catch (err) {
    logger.warn('Daily digest: failed to list subscribers', 'DIGEST', err);
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await NotificationService.sendNotificationToUser(
        row.user_id,
        { title: digest.title, body: digest.body.slice(0, 500), url: digest.url },
        'system',
      );
      pushed++;
    } catch (err) {
      failed++;
      logger.warn(`Daily digest: push failed for user ${row.user_id}`, 'DIGEST', err);
    }
  }
  logger.info(`Daily digest sent to ${pushed} users (${failed} failed)`, 'DIGEST');
  return { pushed, failed };
}

// ── Persistence: digests are revisitable from the Events page ──

export interface PersistedDigest {
  id: string;
  digest_date: string;
  title: string;
  body: string;
  url: string;
  event_count: number;
  detection_count: number;
  created_at: string;
}

/** Build + upsert yesterday's digest into daily_digests. */
export async function persistDigest(): Promise<PersistedDigest | null> {
  try {
    const digest = await buildYesterdayDigest();
    const { label } = istDayRange();
    const statsLabel = digest.body.match(/(\d[\d,]*) events/);
    const eventCount = statsLabel ? parseInt(statsLabel[1].replace(/,/g, ''), 10) : 0;
    const detLabel = digest.body.match(/(\d[\d,]*) detections/);
    const detectionCount = detLabel ? parseInt(detLabel[1].replace(/,/g, ''), 10) : 0;

    await AppDataSource.query(
      `INSERT INTO daily_digests (digest_date, title, body, url, event_count, detection_count)
       VALUES ($1::date, $2, $3, $4, $5, $6)
       ON CONFLICT (digest_date) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         event_count = EXCLUDED.event_count,
         detection_count = EXCLUDED.detection_count`,
      [label, digest.title, digest.body, digest.url, eventCount, detectionCount],
    );

    return {
      id: label,
      digest_date: label,
      title: digest.title,
      body: digest.body,
      url: digest.url,
      event_count: eventCount,
      detection_count: detectionCount,
      created_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn('Daily digest: persist failed', 'DIGEST', err);
    return null;
  }
}

/** List digests, newest first. */
export async function listDigests(limit = 30, offset = 0): Promise<PersistedDigest[]> {
  try {
    return (await AppDataSource.query(
      `SELECT id::text, digest_date::text, title, body, url, event_count, detection_count,
              created_at::text
       FROM daily_digests
       ORDER BY digest_date DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    )) as PersistedDigest[];
  } catch (err) {
    logger.warn('Daily digest: list failed', 'DIGEST', err);
    return [];
  }
}

/** Fetch one digest by ISO date (YYYY-MM-DD). */
export async function getDigest(dateStr: string): Promise<PersistedDigest | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  try {
    const rows = (await AppDataSource.query(
      `SELECT id::text, digest_date::text, title, body, url, event_count, detection_count,
              created_at::text
       FROM daily_digests
       WHERE digest_date = $1::date`,
      [dateStr],
    )) as PersistedDigest[];
    return rows[0] ?? null;
  } catch (err) {
    logger.warn(`Daily digest: fetch ${dateStr} failed`, 'DIGEST', err);
    return null;
  }
}

/** Full cron path: persist first (revisitable), then push with deep link. */
export async function persistAndPushDigest(): Promise<{
  persisted: boolean;
  pushed: number;
  failed: number;
}> {
  const stored = await persistDigest();
  const deepLink = stored ? `/events?digest=${stored.digest_date}` : '/events';
  const digest: DigestPayload = stored
    ? { title: stored.title, body: stored.body, url: deepLink }
    : { title: 'Daily digest', body: 'No digest available.', url: deepLink };
  const result = await pushDigestToSubscribers(digest);
  return { persisted: stored !== null, ...result };
}
