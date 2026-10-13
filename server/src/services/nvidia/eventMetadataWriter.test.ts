/**
 * AI post-analysis must never erase the pipeline's person count.
 *
 * Root cause: `overwriteEventMetadata` wrote `persons_detected` from the
 * vision model's prose entities. Twice (12:01 cam2, 12:02 cam1) the model
 * enumerated 0 people on snapshots carrying a *verified* human pose
 * (33 MediaPipe keypoints), clobbering the real count of 1 — and the
 * person-tab list filter then hid both rows, which read as "the detection
 * was deleted". The AI may only ever raise the count, never lower it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

import { EventMetadataWriter } from './eventMetadataWriter.js';

describe('overwriteEventMetadata person count', () => {
  const eventRepository = { update: jest.fn() };
  let writer: EventMetadataWriter;

  beforeEach(() => {
    jest.clearAllMocks();
    writer = new EventMetadataWriter({ query: jest.fn() });
  });

  function resultWithPeople(people: unknown[]) {
    return {
      detectedEntities: { people, vehicles: [], objects: [], animals: [] },
      threatAssessment: { level: 'low', confidence: 10 },
      sceneDescription: 'courtyard',
      persons: people,
      model: 'test-model',
    } as any;
  }

  it('keeps the pipeline count when the AI enumerates zero people', async () => {
    await writer.overwriteEventMetadata(
      eventRepository,
      { id: 'evt-1', persons_detected: 1 },
      resultWithPeople([]),
    );

    const update = eventRepository.update.mock.calls[0][1];
    expect(update.persons_detected).toBe(1);
  });

  it('raises the count when the AI genuinely finds more people', async () => {
    await writer.overwriteEventMetadata(
      eventRepository,
      { id: 'evt-1', persons_detected: 1 },
      resultWithPeople([{ label: 'person' }, { label: 'person' }]),
    );

    const update = eventRepository.update.mock.calls[0][1];
    expect(update.persons_detected).toBe(2);
  });

  it('still writes zero for an AI-analyzed motion row with no pipeline count', async () => {
    await writer.overwriteEventMetadata(
      eventRepository,
      { id: 'evt-2', persons_detected: 0 },
      resultWithPeople([]),
    );

    const update = eventRepository.update.mock.calls[0][1];
    expect(update.persons_detected).toBe(0);
  });
});
