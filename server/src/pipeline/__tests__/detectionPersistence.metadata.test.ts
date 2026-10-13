/**
 * Detection metadata must survive persistence and reach the events page.
 *
 * Python measures it on every person track — `human_verification.pose`
 * (stance / facing / arms_raised / torso_lean_deg) and `person_attributes`
 * (clothing, facing, distance, …) — and sends both over the WebSocket. This
 * function stored only four of the verification fields and dropped the
 * attributes entirely, so the events page had nothing to show: its detection
 * panel read `lightLevel`/`motionArea`, keys the pipeline stopped emitting
 * long ago, and rendered an empty block.
 *
 * The events list API returns `metadata` and `object_detections` (it does not
 * join `event_detections`), so this is where they have to be carried.
 */

import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.unstable_mockModule('../../models/Event.js', () => ({
  Event: class {
    static create = jest.fn();
  },
}));
jest.unstable_mockModule('../../models/EventDetection.js', () => ({
  EventDetection: class {
    static create = jest.fn();
  },
}));
jest.unstable_mockModule('../../models/HumanVerification.js', () => ({
  HumanVerification: class {
    static create = jest.fn();
  },
}));
jest.unstable_mockModule('../../database.js', () => ({
  AppDataSource: { getRepository: jest.fn() },
}));
jest.unstable_mockModule('../../services/serviceRegistry.js', () => ({
  serviceRegistry: { getStreamManager: jest.fn(() => undefined) },
}));
jest.unstable_mockModule('../../services/notificationService.js', () => ({
  default: class {},
}));
jest.unstable_mockModule('../../services/sceneMemoryService.js', () => ({
  isSceneMemoryEnabled: jest.fn(() => false),
  compareEventToBaseline: jest.fn(() => true),
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const save = jest.fn();
const insert = jest.fn();

const POSE = {
  stance: 'standing',
  facing: 'away',
  arms_raised: false,
  torso_lean_deg: 3.5,
  keypoints: 14,
  visible_landmarks: 14,
  mean_visibility: 0.91,
};

const ATTRIBUTES = {
  clothing: 'dark jacket',
  clothing_colors: ['black'],
  facing: 'north',
  distance: 'mid',
};

function personEvent(over: Record<string, unknown> = {}) {
  return {
    cameraId: 'cam2',
    event: 'track_updated',
    trackId: 42,
    class: 'person',
    classId: 0,
    score: 0.9,
    bbox: [472.5, 80, 54.9, 134.1],
    trackletLen: 5,
    trackState: 'tracked',
    identity: null,
    identityConfidence: 0,
    ...over,
  };
}

describe('detection metadata persistence', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let persistDetectionEvent: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { AppDataSource } = await import('../../database.js');
    AppDataSource.getRepository.mockReturnValue({ save, insert });
    ({ persistDetectionEvent } = await import('../detectionPersistence.js'));
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  function savedEvent() {
    return save.mock.calls[0][0] as {
      object_detections: Array<Record<string, unknown>>;
      metadata: string;
    };
  }

  it('stores person attributes on the persisted detection', async () => {
    await persistDetectionEvent(personEvent({ personAttributes: ATTRIBUTES }));

    expect(savedEvent().object_detections[0].personAttributes).toEqual(ATTRIBUTES);
  });

  it('stamps the coordinate space the boxes were published in', async () => {
    await persistDetectionEvent(personEvent());

    expect(JSON.parse(savedEvent().metadata).bboxSpace).toBe('image');
  });

  it('stores the measured pose with the verification verdict', async () => {
    await persistDetectionEvent(
      personEvent({
        humanVerification: {
          verified: true,
          tier: 'pose',
          keypoints: 14,
          face_detected: false,
          yolo_score: 0.9,
          roi_w: 80,
          roi_h: 140,
          elapsed_ms: 42,
          pose: POSE,
        },
      }),
    );

    const metadata = JSON.parse(savedEvent().metadata);
    expect(metadata.humanVerification).toMatchObject({
      verified: true,
      tier: 'pose',
      keypoints: 14,
      faceDetected: false,
      elapsedMs: 42,
      pose: POSE,
    });
  });

  it('counts the event person even when the scene snapshot is empty or the track is lost', async () => {
    // Two Oct 5 rows carried a verified human (33 pose keypoints) with
    // persons_detected=0 and object_detections=[] — the 5s scene window had
    // expired and the `lost` filter then stripped the primary track too.
    await persistDetectionEvent(personEvent({ trackState: 'lost' }), []);

    expect(save.mock.calls[0][0].persons_detected).toBe(1);
    expect(save.mock.calls[0][0].object_detections).toHaveLength(1);
  });

  it('stores the pipeline person count on the row, not something AI can clobber', async () => {
    await persistDetectionEvent(personEvent());

    expect(save.mock.calls[0][0].persons_detected).toBe(1);
  });

  it('omits metadata noise when the event carries neither', async () => {
    await persistDetectionEvent(personEvent({ humanVerification: undefined }));

    const event = savedEvent();
    expect(event.object_detections[0].personAttributes).toBeNull();
    const metadata = JSON.parse(event.metadata);
    expect(metadata.humanVerification).toBeUndefined();
  });
});
