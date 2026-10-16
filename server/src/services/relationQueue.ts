import { logger } from '../utils/logger.js';
import { AppDataSource } from '../database.js';
import { relationAnalysisService } from './relationAnalysisService.js';
import { reembedEventById } from './eventSearch/sceneEmbeddingService.js';

const CONCURRENCY = 2;
const IDLE_POLL_MS = 2000;
const BUSY_POLL_MS = 50;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_BASE_S = 15;
const STALE_PROCESSING_MIN = 10;
const STRAGGLER_WINDOW_DAYS = 7;
const STRAGGLER_LIMIT = 2000;

interface ClaimedJob {
  id: number;
  event_id: string;
  attempts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enqueueRelationJob(eventId: string): Promise<void> {
  await AppDataSource.query(
    'INSERT INTO relation_jobs (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING',
    [eventId],
  );
}

export async function enqueueStragglers(
  windowDays: number = STRAGGLER_WINDOW_DAYS,
  limit: number = STRAGGLER_LIMIT,
): Promise<number> {
  const rows = (await AppDataSource.query(
    `INSERT INTO relation_jobs (event_id)
     SELECT e.id FROM events e
     WHERE e.file_path IS NOT NULL AND e.file_path <> ''
       AND e.relations IS NULL
       AND e.created_at > now() - ($1 || ' days')::interval
       AND NOT EXISTS (SELECT 1 FROM relation_jobs j WHERE j.event_id = e.id)
     LIMIT $2
     RETURNING event_id`,
    [String(windowDays), limit],
  )) as Array<{ event_id: string }>;
  return rows.length;
}

export async function resetStaleProcessing(): Promise<void> {
  await AppDataSource.query(
    `UPDATE relation_jobs SET status = 'pending', next_attempt_at = now()
     WHERE status = 'processing' AND started_at < now() - ($1 || ' minutes')::interval`,
    [String(STALE_PROCESSING_MIN)],
  );
}

export async function claimJobs(limit: number = CONCURRENCY): Promise<ClaimedJob[]> {
  const raw = await AppDataSource.query(
    `UPDATE relation_jobs SET status = 'processing', started_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM relation_jobs
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, event_id, attempts`,
    [limit],
  );
  // TypeORM returns UPDATE...RETURNING as [rows, rowCount]; pg/SELECT shapes
  // return the rows array directly. Discriminate on the first element.
  const rows = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
  return (rows ?? []) as ClaimedJob[];
}

async function completeJob(jobId: number): Promise<void> {
  await AppDataSource.query(
    `UPDATE relation_jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`,
    [jobId],
  );
}

async function retryJob(jobId: number, attempts: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const safeAttempts = Number.isFinite(attempts) ? attempts : 1;
  if (safeAttempts >= MAX_ATTEMPTS) {
    await AppDataSource.query(
      `UPDATE relation_jobs SET status = 'failed', finished_at = now(), last_error = $2 WHERE id = $1`,
      [jobId, message],
    );
    return;
  }
  const backoffS = RETRY_BACKOFF_BASE_S * 2 ** (safeAttempts - 1);
  await AppDataSource.query(
    `UPDATE relation_jobs SET status = 'pending', next_attempt_at = now() + ($2 || ' seconds')::interval, last_error = $3 WHERE id = $1`,
    [jobId, String(backoffS), message],
  );
}

export async function runRelationWorkerTick(): Promise<number> {
  const jobs = await claimJobs();
  if (jobs.length === 0) return 0;

  await Promise.all(
    jobs.map(async (job) => {
      try {
        const result = await relationAnalysisService.getEventRelations(job.event_id);
        await completeJob(job.id);
        logger.info(
          `[RelationQueue] job ${job.id} done: event ${job.event_id} (${result?.relations?.length ?? 0} relations)`,
          'RelationQueue',
        );
        // Relations change the scene caption — re-embed so semantic search
        // finds the richer text.
        void reembedEventById(job.event_id).catch(() => {});
        if (result && result.relations.length > 0) {
          try {
            const { relationThreatService } = await import('./relationThreatService.js');
            const threat = await relationThreatService.assessEventThreat(job.event_id);
            logger.info(
              `[RelationQueue] threat for ${job.event_id}: ${threat?.threat?.level ?? 'n/a'}`,
              'RelationQueue',
            );
          } catch (threatErr) {
            logger.warn(
              `[RelationQueue] threat assessment failed for ${job.event_id} (relations kept)`,
              'RelationQueue',
              threatErr,
            );
          }
        }
      } catch (error) {
        await retryJob(job.id, job.attempts, error).catch((retryErr: unknown) => {
          logger.error(`[RelationQueue] failed to update job ${job.id}`, 'RelationQueue', retryErr);
        });
        logger.warn(
          `[RelationQueue] job ${job.id} attempt ${job.attempts} failed: ${error instanceof Error ? error.message : error}`,
          'RelationQueue',
        );
      }
    }),
  );
  return jobs.length;
}

let workerStarted = false;

export function startRelationQueueWorker(): void {
  if (workerStarted) return;
  workerStarted = true;

  void (async () => {
    try {
      await resetStaleProcessing();
      const enqueued = await enqueueStragglers();
      if (enqueued > 0) {
        logger.info(`[RelationQueue] enqueued ${enqueued} straggler events`, 'RelationQueue');
      }
    } catch (error) {
      logger.error('[RelationQueue] startup sweep failed', 'RelationQueue', error);
    }

    for (;;) {
      let processed = 0;
      try {
        processed = await runRelationWorkerTick();
      } catch (error) {
        logger.error('[RelationQueue] tick failed', 'RelationQueue', error);
      }
      await sleep(processed > 0 ? BUSY_POLL_MS : IDLE_POLL_MS);
    }
  })().catch((error) => {
    workerStarted = false;
    logger.error('[RelationQueue] worker loop crashed', 'RelationQueue', error);
  });

  logger.info('[RelationQueue] continuous worker started', 'RelationQueue');
}

export function isRelationQueueWorkerStarted(): boolean {
  return workerStarted;
}
