import { describe, expect, it } from 'vitest';
import { streamSrcForHq, streamSrcForTile } from './streamSrc';

describe('streamSrcForTile', () => {
  it('always returns the cheap profile', () => {
    expect(streamSrcForTile('cam1')).toBe('cam1_cheap');
    expect(streamSrcForTile('cam2')).toBe('cam2_cheap');
  });

  it('never returns the camera id itself', () => {
    expect(streamSrcForTile('cam1')).not.toBe('cam1');
  });
});

describe('streamSrcForHq', () => {
  it('returns the 720p substream', () => {
    expect(streamSrcForHq('cam1')).toBe('cam1_sub');
  });

  it('never returns the 1440p main stream', () => {
    expect(streamSrcForHq('cam1')).not.toBe('cam1');
  });
});
