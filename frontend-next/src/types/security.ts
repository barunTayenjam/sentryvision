export interface CameraStreamInfo {
  isActive: boolean;
  fps: number;
  width: number;
  height: number;
  hasFrame: boolean;
  frameSize: number;
}

export interface Camera {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'warning';
  streamUrl?: string;
  thumbnail: string;
  location: string;
  detectionEnabled: boolean;
  sensitivity: number;
  lastSeen: Date;
  resolution?: string;
  fps?: number;
  error?: string;
  streams?: {
    detect?: CameraStreamInfo;
    record?: CameraStreamInfo;
    live?: CameraStreamInfo;
  };
  config?: {
    detect: {
      width: number;
      height: number;
      fps: number;
    };
    objects?: {
      track: string[];
      filters?: Record<
        string,
        {
          minArea?: number;
          maxArea?: number;
          threshold?: number;
        }
      >;
    };
    zones?: Array<{
      id: string;
      name: string;
      coordinates: number[][];
      objects?: string[];
      inertia?: number;
      loiteringTime?: number;
    }>;
  };
}

export interface MotionEvent {
  id: string;
  cameraId: string;
  cameraName: string;
  timestamp: Date;
  imageUrl: string | null;
  confidence: number;
  severity?: 'alert' | 'detection' | 'info';
  labels: string[];
  location: string;
  duration: number;
  archived: boolean;
  metadata?: Record<string, unknown>;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  detections?: Array<{
    type: 'person' | 'face' | 'object';
    confidence: number;
    name?: string;
    isKnown?: boolean;
    class?: string;
    identity?: string | null;
    trackId?: number;
    trackletLen?: number | null;
    verificationTier?: string | null;
    humanVerified?: boolean;
    personAttributes?: Record<string, unknown> | null;
    boundingBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  personCount?: number;
  faceCount?: number;
  knownFaces?: number;
  unknownFaces?: number;
  lightLevel?: number;
  motionArea?: number;
  rawMetadata?: Record<string, unknown>;
}

export interface EventRelation {
  subject: string;
  predicate: string;
  object: string;
  score: number;
  subjectIndex: number;
  objectIndex: number;
}

export interface RelationBox {
  x: number;
  y: number;
  width: number;
  height: number;
  class: string;
  color?: string;
}

export interface RelationThreat {
  level: 'low' | 'medium' | 'high';
  confidence: number;
  reasoning: string;
  factors: string[];
  recommendedActions: string[];
  model?: string;
  assessedAt?: string;
}

export interface DetectionResult {
  class: string;
  confidence: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface FaceDetection {
  id: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
  embedding?: number[];
  landmark?: {
    leftEye: [number, number];
    rightEye: [number, number];
    nose: [number, number];
    mouth: [number, number];
  };
  isKnown?: boolean;
}

export interface PersonDetectedEvent {
  cameraId: string;
  timestamp: string;
  persons: DetectionResult[];
  imagePath: string;
}

export interface FaceDetectedEvent {
  cameraId: string;
  timestamp: string;
  faces: FaceDetection[];
  imagePath: string;
}
