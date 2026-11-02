// Backfill events.threat_assessment with jev urgency scores.
// Run inside the app container (has DB_* env + router access):
//   cat scripts/backfill-jev.mjs | docker exec -i sentryvision-app node --input-type=module -
// Resumable: skips events that already have noul_score. Marks rows with backfilled:true.
import pg from 'pg';

const JEV_URL = process.env.JEV_URL || 'http://192.168.31.99:20128/v1/systemone';
const API_KEY = process.env.NVIDIA_API_KEY || '';
const MODELS = [
  process.env.JEV_MODEL || 'cf/@cf/cloudflare/clef-flash',
  ...(process.env.JEV_FALLBACK_MODELS || 'oc/jev-1.13-free')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];
const URGENT_T = parseFloat(process.env.JEV_URGENT_THRESHOLD || '0.6');
const SUPPRESS_T = parseFloat(process.env.JEV_SUPPRESS_THRESHOLD || '0.3');
const CONCURRENCY = parseInt(process.env.JEV_BACKFILL_CONCURRENCY || '8', 10);
const BATCH = 500;

if (!API_KEY) {
  console.error('NVIDIA_API_KEY missing — aborting, no partial backfill');
  process.exit(1);
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 4,
});

// Mirrors buildEventState() in jevThreatService.ts so backfilled scores
// stay comparable with live-gate scores.
function buildState(e) {
  const ts = new Date(e.timestamp);
  const timeInfo = ts
    .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    .toLowerCase();
  const dayNight = timeInfo.includes('pm') || timeInfo.includes('12') ? 'night' : 'day';
  let firstClass = null;
  try {
    const dets =
      typeof e.object_detections === 'string' ? JSON.parse(e.object_detections) : e.object_detections;
    if (Array.isArray(dets) && dets.length > 0 && dets[0] && dets[0].class) firstClass = dets[0].class;
  } catch {
    /* malformed jsonb array — skip context */
  }
  const persons = e.persons_detected || 0;
  const parts = [];
  if (e.camera_id) parts.push(`camera ${e.camera_id}`);
  if (e.event_type) parts.push(`event: ${e.event_type}`);
  parts.push(`${persons} person${persons !== 1 ? 's' : ''}`);
  if ((e.faces_detected || 0) > 0) parts.push('face detected');
  if (firstClass) parts.push(`detected ${firstClass}`);
  return `${parts.join(', ')}, ${dayNight}, ${timeInfo}`.replace(/\s+/g, ' ');
}

async function assess(state) {
  for (const model of MODELS) {
    try {
      const res = await fetch(JEV_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model,
          state,
          questions: {
            is_urgent: {
              type: 'noul',
              instructions: 'Does this request require urgent attention? (Break-in, immediate danger, emergency)',
            },
            notify_now: {
              type: 'noul',
              instructions: 'Should an immediate push notification be sent? Consider quiet hours and event severity.',
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        console.warn(`backfill ${model} ${res.status}: ${text?.slice(0, 100)}`);
        continue;
      }
      const data = await res.json();
      // Some providers wrap in {"result":{...}} (clef-flash); unwrap always.
      const payload = data.result ?? data;
      const urgentScore = payload.answers?.is_urgent?.noul;
      const notifyScore = payload.answers?.notify_now?.noul ?? 0;
      if (typeof urgentScore !== 'number') continue; // next model
      return { urgentScore, notifyScore, model };
    } catch (err) {
      console.warn('backfill assess error:', err?.message || err);
      continue;
    }
  }
  return null; // all models failed
}

function payloadOf(urgentScore, notifyScore, model) {
  const isUrgent = urgentScore >= URGENT_T;
  let level = 'low';
  if (urgentScore >= 0.8) level = 'critical';
  else if (urgentScore >= 0.6) level = 'high';
  else if (urgentScore >= 0.4) level = 'medium';
  const notifyNow = notifyScore >= 0.5 || isUrgent ? true : notifyScore < SUPPRESS_T ? false : isUrgent;
  return {
    level,
    confidence: Math.round(urgentScore * 100),
    noul_score: Number(urgentScore.toFixed(4)),
    is_urgent: isUrgent,
    notification_override: notifyNow,
    assessed_at: new Date().toISOString(),
    model,
    backfilled: true,
  };
}

async function fetchBatch() {
  const { rows } = await pool.query(
    `SELECT id, camera_id, event_type, persons_detected, faces_detected, object_detections, timestamp
     FROM events WHERE COALESCE(threat_assessment->>'noul_score','') = ''
     ORDER BY timestamp ASC LIMIT $1`,
    [BATCH],
  );
  return rows;
}

async function writeOne(id, payload) {
  await pool.query(
    `UPDATE events SET threat_assessment = COALESCE(threat_assessment, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify(payload), id],
  );
}

let done = 0;
let failed = 0;
let consecutiveFailures = 0;

async function processRow(row) {
  if (consecutiveFailures > 100) return;
  const state = buildState(row);
  const r = await assess(state);
  if (!r) {
    failed++;
    consecutiveFailures++;
    if (failed <= 10 || failed % 100 === 0) console.error(`[backfill-jev] ${row.id}: all models failed`);
    return;
  }
  await writeOne(row.id, payloadOf(r.urgentScore, r.notifyScore, r.model));
  done++;
  consecutiveFailures = 0;
  if (done % 200 === 0) console.log(`[backfill-jev] ${done} scored (failed: ${failed})`);
}

async function main() {
  const t0 = Date.now();
  console.log(
    `[backfill-jev] models=${MODELS.join(' -> ')} concurrency=${CONCURRENCY} urgentT=${URGENT_T} suppressT=${SUPPRESS_T}`,
  );
  while (true) {
    if (consecutiveFailures > 100) {
      console.error(
        '[backfill-jev] aborting: >100 consecutive failures (router down?) — rerun to resume',
      );
      break;
    }
    const rows = await fetchBatch();
    if (rows.length === 0) break;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(processRow));
    }
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM events WHERE COALESCE(threat_assessment->>'noul_score','') = ''`,
  );
  console.log(`[backfill-jev] DONE scored=${done} failed=${failed} remaining=${rows[0].n} in ${mins}m`);
  await pool.end();
  process.exit(failed > 0 && done === 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[backfill-jev] fatal:', err.message || err);
  await pool.end().catch(() => {});
  process.exit(1);
});
