import { logger } from '../utils/logger.js';

const JEV_BASE_URL = 'http://192.168.31.99:20128/v1/systemone';

const DEFAULT_MODEL = 'cf/@cf/cloudflare/clef-flash';
const DEFAULT_FALLBACKS = 'oc/jev-1.13-free';
const URGENT_THRESHOLD = Number(process.env.JEV_URGENT_THRESHOLD || '0.6');
const SUPPRESS_THRESHOLD = Number(process.env.JEV_SUPPRESS_THRESHOLD || '0.3');

// Provider chain: try in order, first success wins. Mirrors VISION_FALLBACK_MODELS
// pattern in nvidiaClient.ts — a single dead/throttled model cannot mute the gate.
const JEV_MODELS: string[] = [
  process.env.JEV_MODEL || DEFAULT_MODEL,
  ...(process.env.JEV_FALLBACK_MODELS || DEFAULT_FALLBACKS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

export interface JevThreatAssessment {
  isUrgent: boolean;
  notifyNow: boolean;
  threatLevel: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  threatScore: number; // raw noul 0-1
  model?: string; // model that produced this assessment
}

/**
 * Assess threat/urgency from a natural-language state description.
 * Tries each configured model; falls back to keywords if all fail (fail-open).
 */
export async function assessThreat(state: string): Promise<JevThreatAssessment> {
  for (const model of JEV_MODELS) {
    const result = await tryModel(state, model);
    if (result) return result;
  }
  logger.warn(`JEV: all models failed (${JEV_MODELS.join(', ')}), using fallback`, 'JevThreatService');
  return conservativeFallback(state);
}

async function tryModel(state: string, model: string): Promise<JevThreatAssessment | null> {
  try {
    const response = await fetch(JEV_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY || ''}`,
      },
      body: JSON.stringify({
        model,
        state,
        questions: {
          is_urgent: {
            type: 'noul' as const,
            instructions:
              'Does this request require urgent attention? (Break-in, immediate danger, emergency)',
          },
          notify_now: {
            type: 'noul' as const,
            instructions:
              'Should an immediate push notification be sent? Consider quiet hours and event severity.',
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn(
        `JEV model ${model} returned ${response.status}: ${text?.substring(0, 150)}`,
        'JevThreatService',
      );
      return null; // next model in chain
    }

    // Some models (clef-flash) wrap the payload in {"result": {...}}; unwrap all.
    const raw = (await response.json()) as {
      result?: JevResponse;
    } & JevResponse;
    const data = raw.result ?? raw;

    const urgentScore = data.answers?.is_urgent?.noul;
    const notifyScore = data.answers?.notify_now?.noul ?? 0;
    if (typeof urgentScore !== 'number') {
      logger.warn(`JEV model ${model} returned no noul score`, 'JevThreatService');
      return null;
    }

    const isUrgent = urgentScore >= URGENT_THRESHOLD;

    // JEV decides whether to push. notify noul >= 0.5 → push; urgent always pushes.
    // notify noul < SUPPRESS_THRESHOLD → suppress (low-risk event, e.g. cat at noon).
    const notifyNow =
      notifyScore >= 0.5 || isUrgent ? true : notifyScore < SUPPRESS_THRESHOLD ? false : isUrgent;

    // Map noul probability to threat level
    let threatLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (urgentScore >= 0.8) threatLevel = 'critical';
    else if (urgentScore >= 0.6) threatLevel = 'high';
    else if (urgentScore >= 0.4) threatLevel = 'medium';
    else threatLevel = 'low';

    logger.info(
      `JEV threat assessment [${model}]: urgent=${urgentScore.toFixed(2)} notify=${notifyScore.toFixed(2)} level=${threatLevel}`,
      'JevThreatService',
    );

    return {
      isUrgent,
      notifyNow,
      threatLevel,
      confidence: Math.round(urgentScore * 100),
      threatScore: urgentScore,
      model,
    };
  } catch (err: unknown) {
    logger.warn(
      `JEV model ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
      'JevThreatService',
    );
    return null; // next model in chain
  }
}

interface JevResponse {
  model: string;
  answers: {
    is_urgent?: { type: string; noul: number };
    notify_now?: { type: string; noul: number };
  };
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Conservative fail-open fallback:
 * - If state contains obvious emergency keywords → treat as urgent (override)
 * - Otherwise → low threat, suppress notification (safer default when LLM unavailable)
 */
function conservativeFallback(state: string): JevThreatAssessment {
  const lower = state.toLowerCase();

  const emergencyKeywords = [
    'break',
    'intruder',
    'weapon',
    'gun',
    'knife',
    'fire',
    'smoke',
    'explosion',
    'emergency',
    'help',
    'attack',
    'assault',
    'theft',
    'steal',
    'violence',
    'danger',
  ];

  const hasEmergency = emergencyKeywords.some((kw) => lower.includes(kw));

  // Fail-open = old behavior: notify. Router down must not silently mute alerts.
  // Emergency keywords still escalate to urgent (quiet-hour override).
  if (hasEmergency) {
    logger.info(
      `JEV fallback: emergency keywords detected in state → treat as urgent`,
      'JevThreatService',
    );
    return {
      isUrgent: true,
      notifyNow: true,
      threatLevel: 'high',
      confidence: 70,
      threatScore: 0.7,
    };
  }

  return {
    isUrgent: false,
    notifyNow: true,
    threatLevel: 'low',
    confidence: 30,
    threatScore: 0.2,
  };
}

/**
 * Build a concise state string from detection event data for jev assessment.
 * Captures key context: camera, event type, persons/vehicles detected, time of day.
 */
export function buildEventState({
  cameraId,
  eventType,
  personsDetected,
  vehiclesDetected,
  faceDetected,
  timestamp,
  additionalContext = '',
}: {
  cameraId?: string;
  eventType?: string;
  personsDetected?: number;
  vehiclesDetected?: number;
  faceDetected?: boolean;
  timestamp?: string;
  additionalContext?: string;
}): string {
  const timeInfo =
    timestamp
      ? new Date(timestamp)
          .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          .toLowerCase()
      : 'unknown time';

  const dayNight = timeInfo.includes('pm') || timeInfo.includes('12')
    ? 'night'
    : 'day';

  const parts: string[] = [];

  if (cameraId) parts.push(`camera ${cameraId}`);
  if (eventType) parts.push(`event: ${eventType}`);
  if (personsDetected !== undefined) {
    parts.push(`${personsDetected} person${personsDetected !== 1 ? 's' : ''}`);
  }
  if (vehiclesDetected !== undefined) {
    parts.push(`${vehiclesDetected} vehicle${vehiclesDetected !== 1 ? 's' : ''}`);
  }
  if (faceDetected) parts.push('face detected');
  if (additionalContext) parts.push(additionalContext);

  const context = parts.join(', ');
  return `${context}, ${dayNight}, ${timeInfo}`.replace(/\s+/g, ' ');
}

/**
 * Map jev threat assessment to event threat_assessment JSONB field format.
 * Existing events table has threat_assessment JSONB with level and confidence keys.
 */
export function mapToThreatAssessment(
  assessment: JevThreatAssessment,
): Record<string, unknown> {
  return {
    level: assessment.threatLevel,
    confidence: assessment.confidence,
    noul_score: assessment.threatScore,
    assessed_at: new Date().toISOString(),
    model: assessment.model || process.env.JEV_MODEL || DEFAULT_MODEL,
    is_urgent: assessment.isUrgent,
    notification_override: assessment.notifyNow,
  };
}