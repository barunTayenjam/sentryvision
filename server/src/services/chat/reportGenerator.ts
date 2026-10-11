import { AppDataSource } from '../../database.js';
import { ChatTable } from '../../types/chat.js';
import { CONFIDENCE_FLOOR, IST, VEHICLE_GROUP } from './queryTools.js';

export interface ReportStats {
  totals: { events: number; detections: number };
  humans: { unique: number; detections: number; verified: number };
  vehicles: Array<{
    class: string;
    tracks: number;
    detections: number;
    arrived: number;
    left: number;
  }>;
  busyHours: Array<{ hour: number; detections: number }>;
  longestTracks: Array<{
    class: string;
    camera: string | null;
    trackId: number;
    first: Date;
    last: Date;
  }>;
  threats: Array<{ level: string; events: number }>;
  cameras: string[];
}

interface Window {
  from: Date;
  to: Date;
  camera?: string | null;
}

export async function collectReportStats(w: Window): Promise<ReportStats> {
  const values: unknown[] = [w.from, w.to, CONFIDENCE_FLOOR];
  let cameraCond = '';
  if (w.camera) {
    values.push(w.camera);
    cameraCond = `AND ed.camera_id = $${values.length}`;
  }

  const totalsRows = await AppDataSource.query(
    `SELECT COUNT(DISTINCT ed.event_id) AS events, COUNT(*) AS detections
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}`,
    values,
  );

  const humansRows = await AppDataSource.query(
    `SELECT COUNT(*) AS detections,
            COUNT(DISTINCT (ed.camera_id, ed.track_id)) AS unique_humans,
            COUNT(*) FILTER (WHERE ed.human_verified = true) AS verified
     FROM event_detections ed
     WHERE ed.class = 'person' AND ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}`,
    values,
  );

  const vehicleRows = await AppDataSource.query(
    `SELECT sub.class,
            SUM(sub.detections) AS detections,
            COUNT(*) AS tracks,
            COUNT(*) FILTER (WHERE sub.first_state = 'started') AS arrived,
            COUNT(*) FILTER (WHERE sub.last_state IN ('ended','lost')) AS left
     FROM (
       SELECT ed.class, ed.camera_id, ed.track_id,
              (array_agg(ed.track_state ORDER BY ed.timestamp) FILTER (WHERE ed.track_state IS NOT NULL))[1] AS first_state,
              (array_agg(ed.track_state ORDER BY ed.timestamp DESC) FILTER (WHERE ed.track_state IS NOT NULL))[1] AS last_state,
              COUNT(*) AS detections
       FROM event_detections ed
       WHERE ed.class = ANY($${values.length + 1})
         AND ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
         ${cameraCond}
       GROUP BY ed.class, ed.camera_id, ed.track_id
     ) AS sub
     GROUP BY sub.class
     ORDER BY sub.class`,
    [...values, VEHICLE_GROUP],
  );

  const busyRows = await AppDataSource.query(
    `SELECT extract(hour FROM ed.timestamp AT TIME ZONE '${IST}')::int AS hour, COUNT(*) AS detections
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}
     GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    values,
  );

  const longRows = await AppDataSource.query(
    `SELECT ed.class, ed.camera_id, ed.track_id,
            MIN(ed.timestamp) AS first, MAX(ed.timestamp) AS last
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
       AND ed.track_id IS NOT NULL
     ${cameraCond}
     GROUP BY ed.class, ed.camera_id, ed.track_id
     ORDER BY (MAX(ed.timestamp) - MIN(ed.timestamp)) DESC
     LIMIT 5`,
    values,
  );

  const threatRows = await AppDataSource.query(
    `SELECT COALESCE(e.threat_assessment->>'level', 'none') AS level, COUNT(DISTINCT e.id) AS events
     FROM event_detections ed
     JOIN events e ON e.id = ed.event_id
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}
     GROUP BY 1 ORDER BY 2 DESC`,
    values,
  );

  const cameraRows = await AppDataSource.query(
    `SELECT ed.camera_id AS camera, COUNT(*) AS detections
     FROM event_detections ed
     WHERE ed.timestamp >= $1 AND ed.timestamp < $2 AND ed.confidence >= $3
     ${cameraCond}
     GROUP BY 1 ORDER BY 2 DESC`,
    values as unknown[],
  );

  const totals = totalsRows[0] as { events: string; detections: string };
  const humans = humansRows[0] as { detections: string; unique_humans: string; verified: string };
  const classifyVehicle = (r: Record<string, unknown>) => ({
    class: r.class as string,
    tracks: Number(r.tracks),
    detections: Number(r.detections),
    arrived: Number(r.arrived),
    left: Number(r.left),
  });

  return {
    totals: {
      events: Number(totals.events),
      detections: Number(totals.detections),
    },
    humans: {
      unique: Number(humans.unique_humans),
      detections: Number(humans.detections),
      verified: Number(humans.verified),
    },
    vehicles: (vehicleRows as Array<Record<string, unknown>>).map(classifyVehicle),
    busyHours: (busyRows as Array<Record<string, unknown>>).map((r) => ({
      hour: Number(r.hour),
      detections: Number(r.detections),
    })),
    longestTracks: (longRows as Array<Record<string, unknown>>).map((r) => ({
      class: r.class as string,
      camera: (r.camera_id as string) ?? null,
      trackId: Number(r.track_id),
      first: r.first as Date,
      last: r.last as Date,
    })),
    threats: (threatRows as Array<Record<string, unknown>>).map((r) => ({
      level: r.level as string,
      events: Number(r.events),
    })),
    cameras: (cameraRows as Array<Record<string, unknown>>).map((r) => r.camera as string),
  };
}

export interface ReportScene {
  id: string;
  camera: string;
  timestamp: Date;
  description: string | null;
  relations: Array<{ subject: string; predicate: string; object: string; score?: number }>;
}

export async function collectReportScenes(w: Window, limit = 8): Promise<ReportScene[]> {
  try {
    const values: unknown[] = [w.from, w.to];
    let cameraCond = '';
    if (w.camera) {
      values.push(w.camera);
      cameraCond = `AND e.camera_id = $${values.length}`;
    }
    const rows = (await AppDataSource.query(
      `SELECT e.id::text AS id, e.camera_id, e.timestamp,
              a.scene_description,
              e.relations
       FROM events e
       LEFT JOIN ai_analysis_results a ON a.event_id = e.id::text
       WHERE e.timestamp >= $1 AND e.timestamp < $2
         AND (a.scene_description IS NOT NULL OR
              (e.relations IS NOT NULL AND jsonb_array_length(e.relations) > 0))
         ${cameraCond}
       ORDER BY e.timestamp DESC
       LIMIT ${limit}`,
      values,
    )) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      camera: String(r.camera_id ?? '?'),
      timestamp: new Date(r.timestamp as Date),
      description: typeof r.scene_description === 'string' ? r.scene_description : null,
      relations: Array.isArray(r.relations) ? (r.relations as ReportScene['relations']) : [],
    }));
  } catch {
    return [];
  }
}

function fmtL(t: Date): string {
  return t.toLocaleString('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtH(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

export function reportMarkdown(s: ReportStats): string {
  const lines: string[] = [];
  lines.push('# Period report');
  lines.push('');
  if (s.totals.events > 0) {
    lines.push(`**Totals** — ${s.totals.detections} detections across ${s.totals.events} events.`);
    lines.push('');
    lines.push(`**Humans** — ${s.humans.unique} unique humans (${s.humans.detections} person detections, ${s.humans.verified} verified as human).`);
    lines.push('');
    if (s.vehicles.length > 0) {
      const vTotal = s.vehicles.reduce((a, v) => a + v.detections, 0);
      lines.push(`**Vehicles** — ${vTotal} detections across ${s.vehicles.length} class${s.vehicles.length === 1 ? '' : 'es'} (breakdown below).`);
      lines.push('');
    }
    if (s.busyHours.length > 0) {
      lines.push('**Busiest hours** — ' + s.busyHours.map((h) => `${fmtH(h.hour)} (${h.detections})`).join(', ') + '.');
      lines.push('');
    }
    if (s.longestTracks.length > 0) {
      lines.push('**Longest continuous sightings** —');
      for (const t of s.longestTracks) {
        lines.push(`- ${t.class} on ${t.camera ?? '?'}: ${fmtL(t.first)} → ${fmtL(t.last)} (track #${t.trackId})`);
      }
      lines.push('');
    }
    if (s.threats.length > 0) {
      const concerning = s.threats.filter((t) => t.level === 'high' || t.level === 'critical');
      const assessed = s.threats.reduce((a, t) => a + t.events, 0);
      const concerningN = concerning.reduce((a, t) => a + t.events, 0);
      const concerningPart = concerningN > 0 ? `, **${concerningN} high or critical**` : '';
      const breakdown = s.threats.map((t) => `${t.level}: ${t.events}`).join(', ');
      lines.push(`**Threat assessments** — ${assessed} event${assessed === 1 ? '' : 's'} assessed${concerningPart} (${breakdown}).`);
    }
  } else {
    lines.push('No detections in this window.');
  }
  return lines.join('\n');
}

export function reportTables(s: ReportStats): ChatTable[] {
  return [
    {
      caption: 'Vehicles',
      headers: ['Class', 'Sightings', 'Detections', 'Arrivals', 'Departures'],
      rows: s.vehicles.map((v) => [v.class, v.tracks, v.detections, v.arrived, v.left]),
    },
  ];
}