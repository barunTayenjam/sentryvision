import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { ChatMessage, ChatResponse } from '../../types/chat.js';
import { chatLlm, extractJsonObject } from './chatLlm.js';
import {
  anomalies,
  cameraActivity,
  eventCorrelation,
  humanCounts,
  humanCountsParamsSchema,
  periodReportParamsSchema,
  resolveVehicleClasses,
  semanticSearchParamsSchema,
  semanticSearchTool,
  vehicleTimeline,
  vehicleTimelineParamsSchema,
} from './queryTools.js';
import {
  RangeToken,
  resolveIsoRange,
  resolveRange,
  rangeTokenSchema,
} from './dateResolver.js';
import { collectReportStats, reportMarkdown, reportTables } from './reportGenerator.js';

const TOOLS_PROMPT = `You classify a home-security camera question into one of four tools and return ONLY JSON: {"tool": string, "params": object}.

Tools:
1. tool="vehicle_timeline" — question asks when a vehicle came/went/left/returned/appeared.
   params: { "vehicle": string, "range": string|{from,to}, "camera": string|null }
   Vehicle aliases (map user words to these keys): scooter|bike|motorcycle, suv|car|sedan, truck|lorry, bus, bicycle|cycle. Use the user's word as the vehicle value (e.g. "scooter", "suv").
   range tokens: "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_week", or explicit {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (ISO dates). NEVER compute a calendar date or day-of-week — if the user names an absolute date, pass {"from","to"}; otherwise prefer a token.
   camera: a camera name the user named, else null.

2. tool="human_counts" — question asks how many of some object class were seen, by time of day / hour / period (humans/people, dogs, cats, cars, scooters/motorcycles, bicycles).
   params: { "range": same as above, "camera": string|null, "hour_from": int|null, "hour_to": int|null, "class": string }
   class is one of: person, dog, cat, car, motorcycle, bicycle, truck, bus (default "person"; a "scooter" question about counts → "motorcycle", an "SUV" → "car").
   hour_from/hour_to are 0-24 hour-of-day bounds (e.g. "6-7pm" => hour_from 18, hour_to 19; "evening" => 18..24; "morning" => 6..12). Omit if the user gives no time-of-day.

3. tool="period_report" — question asks for a report/summary of what happened over a period.
   params: { "range": same as above, "camera": string|null }

4. tool="camera_activity" — question compares cameras or asks how busy/active a camera was (which camera saw most, compare cam1 vs cam2, how much happened on a camera).
   params: { "range": same as above, "camera": string|null }  (camera null when comparing all cameras)

5. tool="event_correlation" — question asks about several things at once / overlapping tracks / multiple people in one event / longest sightings / how long someone or something stayed.
   params: { "range": same as above, "camera": string|null }

6. tool="anomalies" — question asks about unusual activity, spikes, sudden surges, quiet days, outages, gaps, or a camera being down/no detections.
   params: { "range": same as above, "camera": string|null }

7. tool="semantic_search" — the user describes a SCENE or MOMENT to find (e.g. "someone at the gate at night", "a car parked in the driveway", "dog in the yard", "person carrying something", "show me when the package arrived"). Use this when the question asks to find/locate/show specific events matching a description rather than count or summarize. Pass the user's descriptive phrase VERBATIM as "query" — do not rephrase it.
   params: { "query": string, "camera": string|null, "limit": int (1-10, default 5) }

8. tool="fallback" — any question none of the above fits (e.g. asking for advice, general info, or data the system cannot provide). params: {}.

Accuracy rules — MANDATORY:
- Never invent dates, times, counts, camera names, or vehicle classes.
- The detection classes are COCO only: person, bicycle, car, motorcycle, bus, truck. A scooter is classified as motorcycle; an SUV as car.
- If the question names a time range you cannot map to a token or ISO date, use range {"from":"<ISO>","to":"<ISO>"} only when the user gave explicit dates; otherwise fall back to "today".
- Respond with only the JSON object.`;

const FALLBACK_SYSTEM = `You answer questions about a home security camera system's recorded detection data.
Facts about the data you may reference:
- Persisted detections contain classes: person, bicycle, car, motorcycle, bus, truck (COCO vocabulary) plus dog and cat. A scooter is recorded as "motorcycle"; an SUV as "car". Two-wheelers were only added to tracking on 2026-08-19 — there is no scooter/motorcycle data before that date.
- The tracker splits one physical object into many track IDs (a dog in and out of view can produce dozens of IDs), so distinct track counts overcount objects.
- Data covers per-camera detections and tracks, human verification (verified vs unverified person detections), face recognition identities, person attributes (clothing, distance, carrying items), per-event threat assessments, and per-day activity.
- You do NOT have live video, audio, weather, or events outside the recorded window. A day with zero detections on a camera may mean the camera was off or nothing triggered detection — you cannot distinguish the two.
Be honest: if the question asks for something the data cannot answer, say so plainly. Do not invent statistics, times, or counts. Keep answers short. Use markdown.`;

export class ChatError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const classificationSchema = z.object({
  tool: z.enum([
    'vehicle_timeline',
    'human_counts',
    'period_report',
    'camera_activity',
    'event_correlation',
    'anomalies',
    'semantic_search',
    'fallback',
  ]),
  params: z.record(z.unknown()),
});

function buildCaveat(
  d: { detections: number; events: number; cameras: string[]; sessions?: number },
  windowLabel: string,
): string {
  const cams = d.cameras.length > 0 ? d.cameras.join(', ') : '—';
  const visits = d.sessions !== undefined ? ` / ~${d.sessions} visits` : '';
  return `Based on ${d.detections} detections / ${d.events} events${visits} · window: ${windowLabel} · cameras: ${cams}. No detections = observation gap, not proof of absence.`;
}

/** Drop narrative sentences whose numbers are absent from the stats payload. */
export function stripUnverifiedNumbers(narrative: string, statsJson: string): string {
  const sentences = narrative.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter((s) => {
    const nums = s.match(/\d{2,}/g);
    if (!nums) return true;
    return nums.every((n) => statsJson.includes(n));
  });
  return kept.join(' ');
}

interface ResolvedRange {
  from: Date;
  to: Date;
  label: string;
}

function resolveParamsRange(params: { range?: unknown }): ResolvedRange {
  if (!params.range) return resolveRange('today');
  const parsed = rangeTokenSchema.safeParse(params.range);
  if (parsed.success) return resolveRange(parsed.data as RangeToken);
  const iso = z.object({ from: z.string(), to: z.string() }).safeParse(params.range);
  if (iso.success) return resolveIsoRange(iso.data.from, iso.data.to);
  throw new ChatError('Could not understand the time range', 400);
}

async function classify(message: string): Promise<{ tool: string; params: Record<string, unknown> }> {
  const reply = await chatLlm(TOOLS_PROMPT, `Question: ${message}`);
  const parsed = classificationSchema.safeParse(extractJsonObject(reply));
  if (!parsed.success) {
    // One retry with corrective feedback.
    const reply2 = await chatLlm(
      TOOLS_PROMPT,
      `Question: ${message}\nYour previous reply was not valid: ${JSON.stringify(parsed.error.flatten().fieldErrors)}. Reply with only the JSON object.`,
    );
    const parsed2 = classificationSchema.safeParse(extractJsonObject(reply2));
    if (!parsed2.success) {
      throw new ChatError('Could not classify the question', 422);
    }
    return parsed2.data;
  }
  return parsed.data;
}

async function answerFallback(message: string, history: ChatMessage[]): Promise<ClassifiedChatResult> {
  const context = history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  const userPrompt = context ? `Conversation so far:\n${context}\n\nQuestion: ${message}` : `Question: ${message}`;
  const content = await chatLlm(FALLBACK_SYSTEM, userPrompt, { maxTokens: 700 });
  return {
    tool: 'fallback',
    params: {},
    answer: { type: 'markdown', content },
    tables: [],
    evidence: { detections: 0, events: 0, cameras: [], window: 'n/a' },
  };
}

export type ClassifiedChatResult = Omit<ChatResponse, 'caveat'>;

export async function runClassifiedChat(
  message: string,
  history: ChatMessage[] = [],
): Promise<ClassifiedChatResult> {
  const trimmed = message.trim();
  if (!trimmed) throw new ChatError('Message is required', 400);

  const classified = await classify(trimmed);
  const tool = classified.tool;

  if (tool === 'fallback') return answerFallback(trimmed, history);

  // semantic_search needs no time range — hits span the whole archive.
  if (tool === 'semantic_search') {
    const parsed = semanticSearchParamsSchema.safeParse(classified.params);
    if (!parsed.success) throw new ChatError('Missing/invalid semantic search params', 422);
    const { tables, evidence, images } = await semanticSearchTool({
      query: parsed.data.query,
      camera: parsed.data.camera ?? null,
      limit: parsed.data.limit,
    });
    const rows = tables[0]?.rows ?? [];
    const windowLabel = `${evidence.events} matches (${evidence.detections} hits)`;
    const lines: string[] = [];
    if (rows.length === 0) {
      lines.push(`Nothing in the archive matches "${parsed.data.query}". Try describing the scene differently — object, place, or time of day.`);
    } else {
      lines.push(`## Found ${rows.length} match${rows.length === 1 ? '' : 'es'} for "${parsed.data.query}"`);
      lines.push('');
      for (const r of rows) {
        lines.push(`- **${r[0]}** on ${r[1]} — ${r[2]} (${r[3]} match, ${r[4]})`);
      }
      lines.push('');
      lines.push('Full detail (relations, verification, AI analysis) on each event card in Events.');
    }
    return {
      tool,
      params: { query: parsed.data.query, camera: parsed.data.camera ?? null, limit: parsed.data.limit },
      answer: { type: 'markdown', content: lines.join('\n') },
      tables,
      evidence: { ...evidence, window: windowLabel },
      images,
    };
  }

  const range = resolveParamsRange(classified.params);

  if (tool === 'vehicle_timeline') {
    const parsed = vehicleTimelineParamsSchema.safeParse(classified.params);
    if (!parsed.success) throw new ChatError('Missing/invalid vehicle params', 422);
    if (resolveVehicleClasses(parsed.data.vehicle).length === 0) {
      return answerFallback(trimmed, history);
    }
    const { tables, evidence, images } = await vehicleTimeline({
      vehicle: parsed.data.vehicle,
      camera: parsed.data.camera,
      from: range.from,
      to: range.to,
    });
    const visitRows = tables[0].rows;
    const lines: string[] = [];
    if (visitRows.length === 0) {
      lines.push(`No ${parsed.data.vehicle} sightings in the window (${range.label}).`);
      const resolved = resolveVehicleClasses(parsed.data.vehicle);
      if (resolved.includes('motorcycle') || resolved.includes('bicycle')) {
        lines.push('');
        lines.push('Note: two-wheelers (scooters, bikes) were only added to tracking on 2026-08-19 — there is no data before that date.');
      }
    } else {
      const first = visitRows[0];
      const last = visitRows[visitRows.length - 1];
      lines.push(`## ${parsed.data.vehicle} — ${visitRows.length} visit${visitRows.length === 1 ? '' : 's'}`);
      lines.push('');
      lines.push(`First seen **${first[2]}**, last seen **${last[3]}** · ${evidence.detections} observation${evidence.detections === 1 ? '' : 's'} across ${evidence.tracks} raw track${evidence.tracks === 1 ? '' : 's'} (merged into visits by 5-min gaps).`);
      if (images.length > 0) {
        lines.push('');
        lines.push(`Snapshots below — ${images.length} of ${visitRows.length} visit${visitRows.length === 1 ? '' : 's'}.`);
      }
    }
    const answer = lines.join('\n');
    return {
      tool,
      params: { vehicle: parsed.data.vehicle, range: range.label, camera: parsed.data.camera ?? null },
      answer: { type: 'markdown', content: answer },
      tables,
      evidence: { ...evidence, window: range.label },
      images,
    };
  }

  if (tool === 'human_counts') {
    if (classified.params.objectClass === undefined && typeof classified.params.class === 'string') {
      classified.params = { ...classified.params, objectClass: classified.params.class };
    }
    const parsed = humanCountsParamsSchema.safeParse(classified.params);
    if (!parsed.success) throw new ChatError('Missing/invalid counts params', 422);
    const objectClass = parsed.data.objectClass;
    const { tables, evidence } = await humanCounts({
      from: range.from,
      to: range.to,
      camera: parsed.data.camera,
      hour_from: parsed.data.hour_from ?? undefined,
      hour_to: parsed.data.hour_to ?? undefined,
      objectClass,
    });
    const rows = tables[0].rows;
    const isPerson = objectClass === 'person';
    const classLabel = isPerson ? 'Humans' : `${objectClass}s`;
    const lines: string[] = [];
    if (rows.length === 0) {
      lines.push(`No ${objectClass} detections in the window (${range.label}).`);
    } else {
      const totalDetections = rows.reduce((a, r) => a + Number(r[2]), 0);
      const verified = rows.reduce((a, r) => a + Number(r[3]), 0);
      const busiest = rows.reduce((a, r) => (Number(r[2]) > Number(a[2]) ? r : a), rows[0]);
      lines.push(`## ${classLabel} — ${range.label}`);
      lines.push('');
      const visits = evidence.sessions !== undefined ? `**~${evidence.sessions} visit${evidence.sessions === 1 ? '' : 's'}** · ` : '';
      const verifiedPart = isPerson && verified > 0 ? `, ${verified} verified` : '';
      lines.push(`${visits}${totalDetections} detection${totalDetections === 1 ? '' : 's'}${verifiedPart} · busiest hour **${busiest[0]}** (${busiest[2]}).`);
      if (evidence.tracks !== undefined && evidence.tracks > 1) {
        lines.push(`(${evidence.tracks} raw track IDs — one object gets a new ID each time it re-enters view; IDs under 5 min apart are merged into one visit.)`);
      }
    }
    return {
      tool,
      params: {
        range: range.label,
        camera: parsed.data.camera ?? null,
        hour_from: parsed.data.hour_from ?? null,
        hour_to: parsed.data.hour_to ?? null,
        class: objectClass,
      },
      answer: { type: 'markdown', content: lines.join('\n') },
      tables,
      evidence: { ...evidence, window: range.label },
    };
  }

  // camera_activity
  if (tool === 'camera_activity') {
    const parsed = periodReportParamsSchema.safeParse(classified.params);
    if (!parsed.success) throw new ChatError('Missing/invalid camera params', 422);
    const { tables, evidence } = await cameraActivity({
      from: range.from,
      to: range.to,
      camera: parsed.data.camera,
    });
    const rows = tables[0].rows;
    const lines: string[] = [];
    if (rows.length === 0) {
      lines.push(`No detections in the window (${range.label}).`);
    } else {
      const busiest = rows[0];
      lines.push(`## Camera activity — ${range.label}`);
      lines.push('');
      lines.push(`Busiest camera: **${busiest[0]}** with ${busiest[1]} detections across ${busiest[2]} events (${busiest[3]} tracks).`);
    }
    return {
      tool,
      params: { range: range.label, camera: parsed.data.camera ?? null },
      answer: { type: 'markdown', content: lines.join('\n') },
      tables,
      evidence: { ...evidence, window: range.label },
    };
  }

  // event_correlation
  if (tool === 'event_correlation') {
    const parsed = periodReportParamsSchema.safeParse(classified.params);
    if (!parsed.success) throw new ChatError('Missing/invalid correlation params', 422);
    const { tables, evidence } = await eventCorrelation({
      from: range.from,
      to: range.to,
      camera: parsed.data.camera,
    });
    const busy = tables[0].rows;
    const longTracks = tables[1].rows;
    const lines: string[] = [];
    if (busy.length === 0 && longTracks.length === 0) {
      lines.push(`No multi-track events or long tracks in the window (${range.label}).`);
    } else {
      lines.push(`## Event correlation — ${range.label}`);
      lines.push('');
      if (busy.length > 0) {
        const peak = busy[0];
        lines.push(`**${busy.length} event${busy.length === 1 ? '' : 's'} with 2+ tracks** · peak: ${peak[2]} tracks at **${peak[0]}** on ${peak[1]} (${peak[3]}).`);
      }
      if (longTracks.length > 0) {
        const longest = longTracks[0];
        lines.push(`Longest sighting: ${longest[0]} on ${longest[1]} — ${longest[3]} (${longest[4]} observations).`);
      }
    }
    return {
      tool,
      params: { range: range.label, camera: parsed.data.camera ?? null },
      answer: { type: 'markdown', content: lines.join('\n') },
      tables,
      evidence: { ...evidence, window: range.label },
    };
  }

  // anomalies
  if (tool === 'anomalies') {
    const parsed = periodReportParamsSchema.safeParse(classified.params);
    if (!parsed.success) throw new ChatError('Missing/invalid anomalies params', 422);
    const { tables, evidence } = await anomalies({
      from: range.from,
      to: range.to,
      camera: parsed.data.camera,
    });
    const rows = tables[0]?.rows ?? [];
    const lines: string[] = [];
    if (rows.length === 0) {
      lines.push(`No anomalies detected in the window (${range.label}). Activity stayed within each camera's normal range.`);
    } else {
      const spikes = rows.filter((r) => r[0] === 'spike');
      const gaps = rows.filter((r) => r[0] === 'gap');
      lines.push(`## Anomalies — ${range.label}`);
      lines.push('');
      const parts: string[] = [];
      if (spikes.length > 0) {
        const worst = spikes[0];
        parts.push(`**${spikes.length} spike day${spikes.length === 1 ? '' : 's'}** (worst: ${worst[2]} detections on ${worst[1]})`);
      }
      if (gaps.length > 0) {
        const gapDays = (r: (string | number | null)[]) => parseInt(String(r[3]), 10) || 0;
        const longest = gaps.reduce((a, r) => (gapDays(r) > gapDays(a) ? r : a), gaps[0]);
        parts.push(`**${gaps.length} gap${gaps.length === 1 ? '' : 's'}** (longest: ${String(longest[3]).replace(/ with no detections/, '')}, ${longest[1]})`);
      }
      lines.push(parts.join(' · ') + '.');
    }
    return {
      tool,
      params: { range: range.label, camera: parsed.data.camera ?? null },
      answer: { type: 'markdown', content: lines.join('\n') },
      tables,
      evidence: { ...evidence, window: range.label },
    };
  }

  // period_report
  const parsed = periodReportParamsSchema.safeParse(classified.params);
  if (!parsed.success) throw new ChatError('Missing/invalid report params', 422);
  const stats = await collectReportStats({ from: range.from, to: range.to, camera: parsed.data.camera });
  const tables = reportTables(stats);
  let narrative = '';
  if (stats.totals.events > 0) {
    try {
      const statsJson = JSON.stringify(stats);
      const narration = await chatLlm(
        `Write a 4-8 sentence plain-language summary of the detection statistics. Use ONLY the numbers given — do not compute, estimate, or invent any value. If a number appears in your text it must appear in the JSON input. Do not mention the camera system internals. Output markdown prose only, no headings, no lists.`,
        `Statistics: ${statsJson}`,
        { maxTokens: 500 },
      );
      const safe = stripUnverifiedNumbers(narration, statsJson).trim();
      if (safe) narrative = safe;
    } catch (err) {
      logger.warn('Report narrative generation failed, using numbers only', 'CHAT', err);
    }
  }
  const body = reportMarkdown(stats) + (narrative ? `\n\n${narrative}` : '');
  return {
    tool,
    params: { range: range.label, camera: parsed.data.camera ?? null },
    answer: { type: 'markdown', content: body },
    tables,
    evidence: {
      detections: stats.totals.detections,
      events: stats.totals.events,
      cameras: stats.cameras,
      window: range.label,
    },
  };
}

export async function handleChatMessage(
  message: string,
  history: ChatMessage[] = [],
): Promise<ChatResponse> {
  const res = await runClassifiedChat(message, history);
  return {
    ...res,
    caveat:
      res.tool === 'fallback'
        ? ''
        : buildCaveat(res.evidence, res.evidence.window),
  };
}