import { logger } from '../../utils/logger.js';
import { AppDataSource } from '../../database.js';
import { getOpenCVClient } from '../../services/opencvMicroserviceClient.js';
import { buildCaption } from './sceneCaptionService.js';

type CaptionEvent = Parameters<typeof buildCaption>[0];

const EMBED_DIM = 384;

async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await getOpenCVClient().getEmbedding(text);
    if (!res || res.length === 0) return null;
    if (res.length !== EMBED_DIM) {
      logger.warn(`Unexpected embedding dim ${res.length}, expected ${EMBED_DIM}`, 'Embedding');
    }
    return res;
  } catch (err) {
    logger.warn(`Embedding failed for caption: ${err}`, 'Embedding');
    return null;
  }
}

export async function embedEventScene(ev: CaptionEvent): Promise<void> {
  try {
    const caption = buildCaption(ev);
    if (!caption) return;

    const embedding = await embedText(caption);
    if (!embedding) return;

    await AppDataSource.query(
      `UPDATE events SET scene_embedding = $1::vector, scene_caption = $2 WHERE id = $3`,
      [`[${embedding.join(',')}]`, caption, ev.id],
    );
  } catch (err) {
    logger.warn(`Failed to embed scene for event ${ev.id}: ${err}`, 'Embedding');
  }
}

const SELECT_EVENT_ROW = `
  SELECT id, event_type, severity, camera_id, timestamp,
         persons_detected, faces_detected, known_faces_count,
         unknown_faces_count, object_detections, face_detections,
         scene_context, relations`;

export async function reembedEventById(id: string): Promise<void> {
  const rows = await AppDataSource.query(`${SELECT_EVENT_ROW} FROM events WHERE id = $1`, [id]);
  if (rows.length > 0) await embedEventScene(rows[0] as CaptionEvent);
}

export async function reembedEvents(limit: number): Promise<number> {
  const rows = await AppDataSource.query(
    `${SELECT_EVENT_ROW} FROM events
      WHERE scene_embedding IS NULL OR scene_caption IS NULL
      ORDER BY timestamp ASC
      LIMIT $1`,
    [limit],
  );
  let done = 0;
  for (const row of rows) {
    try {
      await embedEventScene(row as CaptionEvent);
      done++;
    } catch {
      /* per-row failure continues */
    }
  }
  return done;
}
