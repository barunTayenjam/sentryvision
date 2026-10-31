import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { NormalizedDetection, NormalizedFaceDetection } from '../utils/detectionDataNormalizer.js';

@Entity('events')
@Index(['event_type'])
@Index(['timestamp'])
@Index(['severity'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'varchar',
    length: 50,
    comment: 'Type of event, e.g., motion, person, car',
  })
  event_type!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'info',
    comment: 'Severity tier: alert, detection, info',
  })
  severity!: 'alert' | 'detection' | 'info';

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: 'Path to the saved event file (image or video)',
  })
  file_path!: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: 'Path to a smaller thumbnail for the event',
  })
  thumbnail_path!: string | null;

  @CreateDateColumn()
  timestamp!: Date;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: 'Identifier for the camera that triggered the event',
  })
  camera_id!: string | null;

  @Column({
    type: 'text',
    nullable: true,
    comment: 'Additional data about the event, as a JSON string',
  })
  metadata!: string | null;

  @Column({
    type: 'float',
    default: 0,
    nullable: true,
    comment: 'Confidence score of the detection (0-1)',
  })
  confidence!: number | null;

  @Column({
    type: 'integer',
    default: 0,
    comment: 'Number of persons detected in the frame',
  })
  persons_detected!: number;

  @Column({
    type: 'integer',
    default: 0,
    comment: 'Total number of faces detected',
  })
  faces_detected!: number;

  @Column({
    type: 'integer',
    default: 0,
    comment: 'Number of recognized faces',
  })
  known_faces_count!: number;

  @Column({
    type: 'integer',
    default: 0,
    comment: 'Number of unknown faces',
  })
  unknown_faces_count!: number;

  @Column({
    type: 'jsonb',
    nullable: true,
    default: () => "'[]'",
    comment: 'JSONB array of object detection results',
  })
  object_detections!: NormalizedDetection[];

  @Column({
    type: 'jsonb',
    nullable: true,
    default: () => "'[]'",
    comment: 'JSONB array of face detection results',
  })
  face_detections!: NormalizedFaceDetection[];

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Scene context analysis (environment, lighting, time of day)',
  })
  scene_context!: Record<string, unknown> | null;

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Threat assessment result (level, confidence, factors)',
  })
  threat_assessment!: Record<string, unknown> | null;

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Aggregate detection summary (class counts, totals)',
  })
  detection_summary!: Record<string, unknown> | null;

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'MOG2 motion gate stats (motion_pixels, motion_percentage, confidence)',
  })
  motion_stats!: Record<string, unknown> | null;

  @Column({
    type: 'jsonb',
    nullable: true,
    comment:
      'RelateAnything relation triplets (subject, predicate, object, score, subjectIndex, objectIndex). NULL = not analyzed yet',
  })
  relations!: import('../types/event.js').EventRelation[] | null;

  @Column({
    type: 'text',
    nullable: true,
    comment:
      "User verdict: false_positive | false_negative | confirmed; one per event, updated in place. Feeds export-training-set.py (parity #7 Phase A)",
  })
  user_feedback!: 'false_positive' | 'false_negative' | 'confirmed' | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
