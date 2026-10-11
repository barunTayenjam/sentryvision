#!/usr/bin/env node
/**
 * Backfill scene embeddings for events.
 *
 * Usage: node scripts/backfill-embeddings.cjs [--limit N] [--batch B]
 * Reads events missing scene_embedding (oldest-first), builds a text caption
 * from event metadata + object detections, calls the opencv-service /embed
 * endpoint, and writes the 384-dim vector to events.scene_embedding.
 *
 * Requires: pg, fetch (Node 18+). Runs on host or inside the app container.
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : fallback;
};
const BATCH = getArg('--batch', 50);
const TOTAL_LIMIT = getArg('--limit', Infinity);
const EMBED_URL = process.env.EMBEDDER_SERVICE_URL || 'http://localhost:8084/embed';
const EMBED_TOKEN = process.env.OPENCV_API_TOKEN || '';

let pgPath;
try {
  pgPath = require.resolve('pg');
} catch {
  pgPath = '/app/node_modules/pg';
}
const { Client } = require(pgPath);

function buildCaption(ev) {
  const parts = [];
  if (ev.event_type) parts.push(ev.event_type);
  if (ev.object_detections && Array.isArray(ev.object_detections)) {
    const classes = [...new Set(ev.object_detections.map((d) => d.class).filter(Boolean))];
    if (classes.length) parts.push(classes.join(' '));
  }
  if (ev.persons_detected > 0) parts.push('person');
  if (ev.faces_detected > 0) parts.push('face');
  try {
    const meta = typeof ev.metadata === 'string' ? JSON.parse(ev.metadata) : ev.metadata;
    if (meta?.scene?.byClass) parts.push(Object.keys(meta.scene.byClass).join(' '));
  } catch { /* ignore */ }
  return parts.join(' ').trim() || ev.event_type || 'event';
}

async function embed(text) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Token': EMBED_TOKEN },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error('no embedding in response');
  return data.embedding;
}

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'sentryvision',
    user: process.env.DB_USER || 'sentryvision',
    password: process.env.DB_PASSWORD,
  });
  await client.connect();

  const { rows: totalRows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM events WHERE scene_embedding IS NULL`,
  );
  let remaining = Math.min(totalRows[0].c, TOTAL_LIMIT);
  console.log(`Events missing embeddings: ${totalRows[0].c}; will process ${remaining}`);

  let done = 0, failed = 0;
  while (remaining > 0) {
    const limit = Math.min(BATCH, remaining);
    const { rows } = await client.query(
      `SELECT id, event_type, camera_id, timestamp, confidence,
              persons_detected, faces_detected, object_detections, metadata
       FROM events
       WHERE scene_embedding IS NULL
       ORDER BY timestamp DESC
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) break;

    for (const ev of rows) {
      try {
        const caption = buildCaption(ev);
        const vector = await embed(caption);
        await client.query(
          `UPDATE events SET scene_embedding = $1::vector WHERE id = $2::uuid`,
          [`[${vector.join(',')}]`, ev.id],
        );
        done++;
      } catch (err) {
        failed++;
        console.error(`[${ev.id}] ${err.message}`);
      }
    }
    remaining -= rows.length;
    console.log(`Progress: ${done} embedded, ${failed} failed, ~${remaining} left`);
  }

  console.log(`Backfill complete: ${done} embedded, ${failed} failed`);
  await client.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
