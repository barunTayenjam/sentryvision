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
