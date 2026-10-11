import { z } from 'zod';
import { AppDataSource } from '../../database.js';
import { rangeTokenSchema } from './dateResolver.js';
import { VEHICLE_CLASSES } from '../../shared/constants.js';
import eventSearchService from '../../services/eventSearchService.js';

// Class vocabulary is stock COCO. User-facing vehicle names alias onto it.
export const ALIAS_MAP: Record<string, string[]> = {
  scooter: ['motorcycle'],
  bike: ['motorcycle'],
  motorcycle: ['motorcycle'],
  suv: ['car'],
  car: ['car'],
  sedan: ['car'],
  truck: ['truck'],
  lorry: ['truck'],
  bus: ['bus'],
  bicycle: ['bicycle'],
  cycle: ['bicycle'],
};
export const VEHICLE_GROUP = VEHICLE_CLASSES;
export const CONFIDENCE_FLOOR = 0.4;
export const IST = 'Asia/Kolkata';

const rangeSchema = z.union([
  rangeTokenSchema,
  z.object({ from: z.string(), to: z.string() }),
]);

export const vehicleTimelineParamsSchema = z.object({
  vehicle: z.string(),
  range: rangeSchema,
  camera: z.string().nullable().optional(),
});

export const humanCountsParamsSchema = z.object({
  range: rangeSchema,
  camera: z.string().nullable().optional(),
  hour_from: z.number().int().min(0).max(23).nullish(),
  hour_to: z.number().int().min(1).max(24).nullish(),
  objectClass: z
    .enum(['person', 'dog', 'cat', 'car', 'motorcycle', 'bicycle', 'truck', 'bus'])
    .nullish()
    .transform((v) => v ?? 'person'),
});

export const periodReportParamsSchema = z.object({
  range: rangeSchema,
  camera: z.string().nullable().optional(),
});

export type VehicleTimelineParams = z.infer<typeof vehicleTimelineParamsSchema>;
export type HumanCountsParams = z.infer<typeof humanCountsParamsSchema>;
export type PeriodReportParams = z.infer<typeof periodReportParamsSchema>;

export interface VehicleTimelineInput {
  vehicle: string;
  camera?: string | null;
  from: Date;
  to: Date;
}

export interface HumanCountsInput {
  camera?: string | null;
  from: Date;
  to: Date;
  hour_from?: number;
  hour_to?: number;
  objectClass?: string;
}

export interface SpanInput {
  camera: string;
  first: Date;
  last: Date;
  obs: number;
}

export interface Session {
  camera: string;
  first: Date;
  last: Date;
  trackCount: number;
  obs: number;
}

/** Track fragments closer than this are treated as one continuous visit. */
export const SESSION_GAP_MS = 5 * 60 * 1000;

/**
 * The tracker assigns a new ID whenever an object leaves the frame, so one
 * dog or parked scooter scatters into many track IDs. Cluster track spans
 * per camera: spans whose start falls within `gapMs` of the running
 * cluster's end merge into one visit.
 */
export function clusterSessions(spans: SpanInput[], gapMs = SESSION_GAP_MS): Session[] {
  const byCam = new Map<string, SpanInput[]>();
  for (const s of spans) {
    const list = byCam.get(s.camera) ?? [];
    list.push(s);
    byCam.set(s.camera, list);
  }
  const sessions: Session[] = [];
  for (const [camera, camSpans] of byCam) {
    const sorted = [...camSpans].sort((a, b) => a.first.getTime() - b.first.getTime());
    let cur: Session | null = null;
    for (const s of sorted) {
      if (cur && s.first.getTime() <= cur.last.getTime() + gapMs) {
        cur.last = new Date(Math.max(cur.last.getTime(), s.last.getTime()));
        cur.trackCount += 1;
        cur.obs += s.obs;
      } else {
        if (cur) sessions.push(cur);
        cur = { camera, first: s.first, last: s.last, trackCount: 1, obs: s.obs };
      }
    }
    if (cur) sessions.push(cur);
  }
  sessions.sort((a, b) => a.first.getTime() - b.first.getTime());
  return sessions;
}

export function resolveVehicleClasses(vehicle: string): string[] {
  const key = vehicle.trim().toLowerCase();
  if (key === 'vehicle' || key === 'vehicles' || key === 'any') return [...VEHICLE_GROUP];
  const mapped = ALIAS_MAP[key];
  return mapped ?? [];
}

/** Pure classification shared with the unit test. */
export function classifyTrack(
  firstState: string | null,
  lastState: string | null,
): 'returned' | 'left' | 'observed' {
  if (lastState === 'ended' || lastState === 'lost') return 'left';
  if (firstState === 'started') return 'returned';
  return 'observed';
}

export function fmtIstTime(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleString('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export async function vehicleTimeline(
  params: VehicleTimelineInput,
): Promise<{
  tables: import('../../types/chat.js').ChatTable[];
  evidence: import('../../types/chat.js').ToolEvidence;
  images: import('../../types/chat.js').ChatImage[];
}> {
  const classes = resolveVehicleClasses(params.vehicle);
  const values: unknown[] = [classes, params.from, params.to, CONFIDENCE_FLOOR];
  let cameraCond = '';
  if (params.camera) {
    values.push(params.camera);
    cameraCond = `AND ed.camera_id = $${values.length}`;
  }

  const rows = await AppDataSource.query(
    `SELECT ed.track_id,
            ed.camera_id,
            MIN(ed.timestamp) AS first_seen,
            MAX(ed.timestamp) AS last_seen,
            COUNT(*) AS obs,
            COUNT(DISTINCT ed.event_id) AS events
     FROM event_detections ed
     WHERE ed.class = ANY($1)
       AND ed.timestamp >= $2 AND ed.timestamp < $3
       AND ed.confidence >= $4
       ${cameraCond}
     GROUP BY ed.track_id, ed.camera_id
     ORDER BY first_seen`,
    values,
  ) as Array<Record<string, unknown>>;

  const sessions = clusterSessions(
    rows.map((r) => ({
      camera: String(r.camera_id ?? '?'),
      first: new Date(r.first_seen as Date),
      last: new Date(r.last_seen as Date),
      obs: Number(r.obs),
    })),
  );

  // One snapshot per visit (first few) so the user can see what was detected.
  const eventRows = (await AppDataSource.query(
    `SELECT ed.event_id, e.file_path, ed.camera_id,
            MAX(ed.confidence) AS conf, MIN(ed.timestamp) AS ts
     FROM event_detections ed
     JOIN events e ON e.id = ed.event_id
     WHERE ed.class = ANY($1)
       AND ed.timestamp >= $2 AND ed.timestamp < $3 AND ed.confidence >= $4
       AND e.file_path IS NOT NULL
       ${cameraCond}
     GROUP BY 1, 2, 3`,
    values,
  )) as Array<Record<string, unknown>>;
  const candidates = eventRows.map((r) => ({
    camera: String(r.camera_id ?? '?'),
    file: String(r.file_path ?? '').split('/').pop() ?? '',
    conf: Number(r.conf),
    ts: new Date(r.ts as Date),
  }));
  const images: import('../../types/chat.js').ChatImage[] = [];
  for (const [i, s] of sessions.slice(0, 6).entries()) {
    const inVisit = candidates.filter(
      (c) => c.camera === s.camera && c.ts >= s.first && c.ts.getTime() <= s.last.getTime() + 60_000,
    );
    const best = inVisit.sort((a, b) => b.conf - a.conf)[0];
    if (best?.file) {
      images.push({
        url: `/api/events/image/${best.file}`,
        caption: `Visit ${i + 1} · ${s.camera} · ${fmtIstTime(s.first)}`,
      });
    }
  }

  const detections = rows.reduce((a, r) => a + Number(r.obs), 0);
  const events = rows.reduce((a, r) => a + Number(r.events), 0);
  const cameras = [...new Set(rows.map((r) => String(r.camera_id ?? '')).filter(Boolean))];

  return {
    tables: [
      {
        caption: `${params.vehicle} visits (track fragments merged; gaps > ${Math.round(SESSION_GAP_MS / 60000)} min split visits)`,
        headers: ['Camera', 'Visit', 'From (IST)', 'Until (IST)', 'Track fragments', 'Observations'],
        rows: sessions.map((s, i) => [
          s.camera,
          i + 1,
          fmtIstTime(s.first),
          fmtIstTime(s.last),
          s.trackCount,
          s.obs,
        ]),
      },
    ],
    evidence: { detections, events, cameras, sessions: sessions.length, tracks: rows.length },
    images,
  };
}

export interface CameraActivityInput {
  camera?: string | null;
  from: Date;
  to: Date;
}

export async function cameraActivity(
  params: CameraActivityInput,
): Promise<{
  tables: import('../../types/chat.js').ChatTable[];
  evidence: { detections: number; events: number; cameras: string[] };
}> {
  const values: unknown[] = [params.from, params.to, CONFIDENCE_FLOOR];
  let cameraCond = '';
  if (params.camera) {
    values.push(params.camera);
    cameraCond = `AND ed.camera_id = $${values.length}`;
  }

  const rows = (await AppDataSource.query(
    `SELECT ed.camera_id,
            COUNT(*) AS detections,
            COUNT(DISTINCT ed.event_id) AS events,
            COUNT(DISTINCT ed.track_id) AS tracks,
            string_agg(DISTINCT ed.class, ', ' ORDER BY ed.class) AS class_list,
            MIN(ed.timestamp) AS first_seen,
            MAX(ed.timestamp) AS last_seen
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}
     GROUP BY ed.camera_id
     ORDER BY detections DESC`,
    values,
  )) as Array<Record<string, unknown>>;

  const cameras = rows.map((r) => ({
    camera: (r.camera_id as string) ?? '?',
    detections: Number(r.detections),
    events: Number(r.events),
    tracks: Number(r.tracks),
    classes: (r.class_list as string) ?? '',
    first: r.first_seen as Date,
    last: r.last_seen as Date,
  }));

  return {
    tables: [
      {
        caption: 'Camera activity',
        headers: ['Camera', 'Detections', 'Events', 'Tracks', 'Classes', 'First seen', 'Last seen'],
        rows: cameras.map((c) => [
          c.camera,
          c.detections,
          c.events,
          c.tracks,
          c.classes,
          c.first ? fmtIstTime(c.first) : '—',
          c.last ? fmtIstTime(c.last) : '—',
        ]),
      },
    ],
    evidence: {
      detections: cameras.reduce((a, c) => a + c.detections, 0),
      events: cameras.reduce((a, c) => a + c.events, 0),
      cameras: cameras.map((c) => c.camera),
    },
  };
}

export interface EventCorrelationInput {
  camera?: string | null;
  from: Date;
  to: Date;
}

export async function eventCorrelation(
  params: EventCorrelationInput,
): Promise<{
  tables: import('../../types/chat.js').ChatTable[];
  evidence: { detections: number; events: number; cameras: string[] };
}> {
  const values: unknown[] = [params.from, params.to, CONFIDENCE_FLOOR];
  let cameraCond = '';
  if (params.camera) {
    values.push(params.camera);
    cameraCond = `AND ed.camera_id = $${values.length}`;
  }

  const busy = (await AppDataSource.query(
    `SELECT ed.event_id,
            MAX(ed.timestamp) AS ts,
            ed.camera_id,
            COUNT(DISTINCT ed.track_id) FILTER (WHERE ed.track_id IS NOT NULL) AS tracks,
            COUNT(DISTINCT ed.class) AS classes,
            string_agg(DISTINCT ed.class, ', ' ORDER BY ed.class) AS class_list
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}
     GROUP BY ed.event_id, ed.camera_id
     HAVING COUNT(DISTINCT ed.track_id) FILTER (WHERE ed.track_id IS NOT NULL) > 1
     ORDER BY tracks DESC, ts DESC
     LIMIT 10`,
    values,
  )) as Array<Record<string, unknown>>;

  const longTracks = (await AppDataSource.query(
    `SELECT ed.class, ed.camera_id, ed.track_id,
            COUNT(*) AS obs,
            MIN(ed.timestamp) AS first_seen,
            MAX(ed.timestamp) AS last_seen
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
       AND ed.track_id IS NOT NULL
     ${cameraCond}
     GROUP BY ed.class, ed.camera_id, ed.track_id
     ORDER BY (MAX(ed.timestamp) - MIN(ed.timestamp)) DESC
     LIMIT 8`,
    values,
  )) as Array<Record<string, unknown>>;

  const countRow = (await AppDataSource.query(
    `SELECT COUNT(*) AS detections, COUNT(DISTINCT ed.event_id) AS events
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}`,
    values,
  )) as Array<Record<string, unknown>>;

  const fmtTrackSpan = (first: Date, last: Date) =>
    `${fmtIstTime(first)} → ${fmtIstTime(last)}`;

  return {
    tables: [
      {
        caption: 'Busiest events (most concurrent tracks)',
        headers: ['When (IST)', 'Camera', 'Tracks', 'Classes'],
        rows: busy.map((r) => [
          fmtIstTime(r.ts as Date),
          (r.camera_id as string) ?? '?',
          Number(r.tracks),
          (r.class_list as string) ?? '',
        ]),
      },
      {
        caption: 'Longest continuous tracks',
        headers: ['Class', 'Camera', 'Track', 'First → last', 'Observations'],
        rows: longTracks.map((r) => [
          r.class as string,
          (r.camera_id as string) ?? '?',
          Number(r.track_id),
          fmtTrackSpan(r.first_seen as Date, r.last_seen as Date),
          Number(r.obs),
        ]),
      },
    ],
    evidence: {
      detections: Number(countRow[0]?.detections ?? 0),
      events: Number(countRow[0]?.events ?? 0),
      cameras: [...new Set([...busy, ...longTracks].map((r) => String(r.camera_id ?? '')).filter(Boolean))],
    },
  };
}

export interface DailyCount {
  day: string;
  camera: string;
  detections: number;
}

export interface AnomalyResult {
  spikes: Array<{
    day: string;
    camera: string;
    detections: number;
    mean: number;
  }>;
  gaps: Array<{ from: string; to: string; camera: string; days: number }>;
}

/**
 * Flag daily per-camera counts that deviate from that camera's own baseline:
 * spikes are days far above mean+2σ (with an absolute floor so noisy quiet
 * cameras don't flag), gaps are runs of days at or below the floor. The spike
 * baseline excludes the candidate day so one big day can't hide itself.
 */
export function detectDailyAnomalies(
  series: DailyCount[],
  opts: { minSpikeDetections?: number; zThreshold?: number; gapFloor?: number } = {},
): AnomalyResult {
  const { minSpikeDetections = 10, gapFloor = 0 } = opts;
  const byCam = new Map<string, DailyCount[]>();
  for (const r of series) {
    const list = byCam.get(r.camera) ?? [];
    list.push(r);
    byCam.set(r.camera, list);
  }

  const spikes: AnomalyResult['spikes'] = [];
  const gaps: AnomalyResult['gaps'] = [];

  for (const [camera, rows] of byCam) {
    const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
    const counts = sorted.map((r) => r.detections);
    const sum = counts.reduce((a, b) => a + b, 0);
    const sumSq = counts.reduce((a, b) => a + b * b, 0);
    const n = counts.length;

    for (const r of sorted) {
      // Baseline excludes the candidate day so one big spike can't hide itself.
      if (n < 2) continue;
      const exclMean = (sum - r.detections) / (n - 1);
      const exclVar = Math.max(0, (sumSq - r.detections ** 2) / (n - 1) - exclMean ** 2);
      const exclSd = Math.sqrt(exclVar);
      const threshold = Math.max(exclMean * 2, exclMean + 2 * exclSd);
      if (r.detections >= minSpikeDetections && r.detections > exclMean && r.detections >= threshold) {
        spikes.push({
          day: r.day,
          camera,
          detections: r.detections,
          mean: Math.round(exclMean * 10) / 10,
        });
      }
    }

    let runStart = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].detections <= gapFloor) {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        gaps.push({
          from: sorted[runStart].day,
          to: sorted[i - 1].day,
          camera,
          days: i - runStart,
        });
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      gaps.push({
        from: sorted[runStart].day,
        to: sorted[sorted.length - 1].day,
        camera,
        days: sorted.length - runStart,
      });
    }
  }

  spikes.sort((a, b) => b.detections - a.detections);
  gaps.sort((a, b) => b.days - a.days);
  return { spikes, gaps };
}

export interface AnomaliesInput {
  camera?: string | null;
  from: Date;
  to: Date;
}

export async function anomalies(
  params: AnomaliesInput,
): Promise<{
  tables: import('../../types/chat.js').ChatTable[];
  evidence: { detections: number; events: number; cameras: string[] };
}> {
  const values: unknown[] = [params.from, params.to, CONFIDENCE_FLOOR];
  let cameraCond = '';
  if (params.camera) {
    values.push(params.camera);
    cameraCond = `AND ed.camera_id = $${values.length}`;
  }

  const rows = (await AppDataSource.query(
    `SELECT (ed.timestamp AT TIME ZONE '${IST}')::date::text AS day,
            ed.camera_id,
            COUNT(*) AS detections
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    values,
  )) as Array<Record<string, unknown>>;

  const countRow = (await AppDataSource.query(
    `SELECT COUNT(*) AS detections, COUNT(DISTINCT ed.event_id) AS events
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}`,
    values,
  )) as Array<Record<string, unknown>>;

  const present = rows.map((r) => ({
    day: r.day as string,
    camera: (r.camera_id as string) ?? '?',
    detections: Number(r.detections),
  }));

  // GROUP BY only returns days that had detections — a day with zero rows is
  // invisible. Fill missing calendar days per camera with 0 so outage runs
  // (e.g. a camera offline for a week) surface as gaps. Only backfill to the
  // window start for cameras that existed before the window; a camera that
  // first appeared mid-window legitimately has no earlier days.
  const firstEverRows = (await AppDataSource.query(
    `SELECT camera_id, MIN(timestamp) AS first_ever
     FROM event_detections
     GROUP BY camera_id`,
  )) as Array<Record<string, unknown>>;
  const firstEver = new Map<string, string>();
  for (const r of firstEverRows) {
    firstEver.set(String(r.camera_id), String((r.first_ever as Date).toISOString?.() ?? r.first_ever));
  }
  const windowFromDay = new Date(params.from.getTime() + (5 * 60 + 30) * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const byCamPresent = new Map<string, Map<string, number>>();
  for (const r of present) {
    const m = byCamPresent.get(r.camera) ?? new Map<string, number>();
    m.set(r.day, r.detections);
    byCamPresent.set(r.camera, m);
  }
  const filled: DailyCount[] = [];
  for (const [camera, m] of byCamPresent) {
    const days = [...m.keys()].sort();
    if (days.length === 0) continue;
    const firstPresent = days[0];
    const cameraPrecededWindow = (firstEver.get(camera) ?? '9999-99-99') < windowFromDay;
    const fillStart = cameraPrecededWindow
      ? windowFromDay
      : firstPresent;
    let cursor = new Date(`${fillStart}T00:00:00Z`);
    const last = new Date(`${days[days.length - 1]}T00:00:00Z`);
    while (cursor <= last) {
      const d = cursor.toISOString().slice(0, 10);
      filled.push({ day: d, camera, detections: m.get(d) ?? 0 });
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  const result = detectDailyAnomalies(filled, {});

  const tableRows: Array<(string | number | null)[]> = [
    ...result.spikes.map((s) => ['spike', `${s.day} (${s.camera})`, s.detections, `baseline ${s.mean}/day`]),
    ...result.gaps.map((g) => [
      'gap',
      `${g.from} → ${g.to} (${g.camera})`,
      '0',
      g.days === 1 ? '1 day with no detections' : `${g.days} days with no detections`,
    ]),
  ];

  return {
    tables:
      tableRows.length > 0
        ? [{ caption: 'Anomalies', headers: ['Type', 'Period', 'Detections', 'Note'], rows: tableRows }]
        : [],
    evidence: {
      detections: Number(countRow[0]?.detections ?? 0),
      events: Number(countRow[0]?.events ?? 0),
      cameras: [...new Set(rows.map((r) => String(r.camera_id ?? '')).filter(Boolean))],
    },
  };
}

export async function humanCounts(
  params: HumanCountsInput,
): Promise<{
  tables: import('../../types/chat.js').ChatTable[];
  evidence: import('../../types/chat.js').ToolEvidence;
}> {
  const objectClass = params.objectClass ?? 'person';
  const isPerson = objectClass === 'person';

  // Two queries with separate bind arrays: Postgres errors when a bind message
  // supplies parameters the statement never references.
  const hourValues: unknown[] = [params.from, params.to, CONFIDENCE_FLOOR, [objectClass]];
  let hourConds = 'AND ed.confidence >= $3 AND ed.class = ANY($4)';
  if (params.camera) {
    hourValues.push(params.camera);
    hourConds += ` AND ed.camera_id = $${hourValues.length}`;
  }
  if (params.hour_from !== undefined || params.hour_to !== undefined) {
    const from = Math.max(0, params.hour_from ?? 0);
    const to = Math.min(24, params.hour_to ?? 24);
    hourValues.push(from, to);
    hourConds += ` AND extract(hour FROM ed.timestamp AT TIME ZONE '${IST}') >= $${hourValues.length - 1}
                  AND extract(hour FROM ed.timestamp AT TIME ZONE '${IST}') < $${hourValues.length}`;
  }

  const rows = await AppDataSource.query(
    `SELECT extract(hour FROM ed.timestamp AT TIME ZONE '${IST}')::int AS hour,
            COUNT(*) AS detections,
            COUNT(DISTINCT (ed.camera_id, ed.track_id)) AS humans,
            COUNT(*) FILTER (WHERE ed.human_verified = true) AS verified,
            COUNT(DISTINCT ed.event_id) AS events
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2
       ${hourConds}
     GROUP BY 1
     ORDER BY 1`,
    hourValues,
  ) as Array<Record<string, unknown>>;

  const hourRows = rows.map((r) => ({
    hour: Number(r.hour),
    humans: Number(r.humans),
    detections: Number(r.detections),
    verified: Number(r.verified),
    events: Number(r.events),
  }));

  const spanValues: unknown[] = [params.from, params.to, CONFIDENCE_FLOOR, [objectClass]];
  let spanConds = 'AND ed.confidence >= $3 AND ed.class = ANY($4)';
  if (params.camera) {
    spanValues.push(params.camera);
    spanConds += ` AND ed.camera_id = $${spanValues.length}`;
  }
  if (params.hour_from !== undefined || params.hour_to !== undefined) {
    const from = Math.max(0, params.hour_from ?? 0);
    const to = Math.min(24, params.hour_to ?? 24);
    spanValues.push(from, to);
    spanConds += ` AND extract(hour FROM ed.timestamp AT TIME ZONE '${IST}') >= $${spanValues.length - 1}
                  AND extract(hour FROM ed.timestamp AT TIME ZONE '${IST}') < $${spanValues.length}`;
  }
  const spanRows = (await AppDataSource.query(
    `SELECT ed.camera_id,
            ed.track_id,
            MIN(ed.timestamp) AS first_seen,
            MAX(ed.timestamp) AS last_seen,
            COUNT(*) AS obs
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2
       ${spanConds}
     GROUP BY 1, 2`,
    spanValues,
  )) as Array<Record<string, unknown>>;
  const trackSpans = spanRows
    .filter((r) => r.track_id !== null)
    .map((r) => ({
      camera: String(r.camera_id ?? '?'),
      first: new Date(r.first_seen as Date),
      last: new Date(r.last_seen as Date),
      obs: Number(r.obs),
    }));
  const sessions = clusterSessions(trackSpans);

  const label = (h: number) => {
    const s = `${String(h % 24).padStart(2, '0')}:00`;
    const e = `${String((h + 1) % 24).padStart(2, '0')}:00`;
    return `${s}–${e}`;
  };
  const classLabel = isPerson ? 'Humans' : `${objectClass}s`;
  const uniqueHeader = isPerson ? 'Unique humans' : 'Unique tracks';
  const verifiedHeader = isPerson ? 'Verified humans' : 'Verified';

  return {
    tables: [
      {
        caption: `${classLabel} by hour (IST)`,
        headers: ['Hour', uniqueHeader, `${objectClass} detections`, verifiedHeader, 'Events'],
        rows: hourRows.map((r) => [label(r.hour), r.humans, r.detections, r.verified, r.events]),
      },
    ],
    evidence: {
      detections: hourRows.reduce((a, r) => a + r.detections, 0),
      events: hourRows.reduce((a, r) => a + r.events, 0),
      cameras: [],
      sessions: sessions.length,
      tracks: trackSpans.length,
    },
  };
}

// ── semantic_search: free-text scene similarity over events ──

export const semanticSearchParamsSchema = z.object({
  query: z.string().min(1).max(500),
  camera: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(10).default(5),
});

export type SemanticSearchParams = z.infer<typeof semanticSearchParamsSchema>;

export interface SemanticSearchHit {
  id: string;
  eventType: string;
  timestamp: string | Date;
  cameraId: string;
  confidence: number;
  personsDetected: number;
  facesDetected: number;
  objectDetections: Array<{ class?: string; confidence?: number }>;
  faceDetections: Array<unknown>;
  imageUrl: string | null;
  similarity?: number;
  searchSource?: 'semantic' | 'keyword';
}

/**
 * Free-text scene search: delegates to the eventSearchService hybrid
 * (pgvector cosine ∪ keyword fallback), then enriches each hit from the DB
 * (relations, full detections, analysis) so Ask answers carry everything
 * the `/events` page knows about the event.
 */
export async function semanticSearchTool(params: {
  query: string;
  camera: string | null;
  limit: number;
}): Promise<{
  tables: import('../../types/chat.js').ChatTable[];
  evidence: import('../../types/chat.js').ToolEvidence;
  images: import('../../types/chat.js').ChatImage[];
}> {
  const result = await eventSearchService.semanticSearch(params.query, {
    cameraId: params.camera ?? undefined,
    limit: params.limit,
  });

  const hits = (result.events ?? []) as SemanticSearchHit[];
  if (hits.length === 0) {
    return {
      tables: [],
      evidence: { detections: 0, events: 0, cameras: [] },
      images: [],
    };
  }

  const ids = new Set(hits.map((h) => h.id));

  // Enrichment: full object detections + relations per hit. Never fatal —
  // the base hybrid hits already answer the question.
  let enrich: Map<string, { relations: unknown; details: unknown }> = new Map();
  try {
    const [detailRows, relationRows] = await Promise.all([
      AppDataSource.query(
        `SELECT id::text AS id, object_detections, face_detections, persons_detected, faces_detected, known_faces_count
         FROM events WHERE id = ANY($1::uuid[])`,
        [[...ids]],
      ),
      AppDataSource.query(
        `SELECT id::text AS id, relations, detection_summary, threat_assessment
         FROM events WHERE id = ANY($1::uuid[])`,
        [[...ids]],
      ),
    ]);
    for (const id of ids) {
      enrich.set(id, {
        relations: relationRows.find((r: Record<string, unknown>) => r.id === id) ?? null,
        details: detailRows.find((r: Record<string, unknown>) => r.id === id) ?? null,
      });
    }
  } catch {
    // enrichment unavailable — base hits still stand
  }

  const sorted = [...hits].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  const images: import('../../types/chat.js').ChatImage[] = [];
  for (const h of sorted.slice(0, 6)) {
    if (h.imageUrl) {
      images.push({
        url: h.imageUrl,
        caption: `${h.cameraId} · ${fmtIstTime(h.timestamp)} · ${Math.round((h.similarity ?? 0) * 100)}%`,
      });
    }
  }

  const objLabel = (h: SemanticSearchHit) => {
    const classes = [...new Set((h.objectDetections ?? []).map((d) => d.class).filter(Boolean))];
    return classes.length > 0 ? classes.join(', ') : h.eventType;
  };

  return {
    tables: [
      {
        caption: `Semantic matches for "${params.query}" (cosine-ranked)`,
        headers: ['When (IST)', 'Camera', 'Objects', 'Similarity', 'Source'],
        rows: sorted.map((h) => [
          fmtIstTime(h.timestamp),
          h.cameraId,
          objLabel(h),
          `${Math.round((h.similarity ?? 0) * 100)}%`,
          h.searchSource ?? 'semantic',
        ]),
      },
    ],
    evidence: {
      detections: hits.length,
      events: hits.length,
      cameras: [...new Set(hits.map((h) => String(h.cameraId ?? '')).filter(Boolean))],
    },
    images,
  };
}