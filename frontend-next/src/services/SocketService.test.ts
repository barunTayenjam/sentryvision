import { describe, expect, it } from 'vitest';
import { streamRequestPayload } from './SocketService';

describe('streamRequestPayload', () => {
  it('defaults to requesting frames when the caller says nothing', () => {
    expect(streamRequestPayload('cam1', 'live')).toEqual({
      cameraId: 'cam1',
      role: 'live',
      frames: true,
    });
  });

  it('carries frames:false through, so a reconnect replay cannot re-enable the relay', () => {
    expect(streamRequestPayload('cam1', 'live', false)).toEqual({
      cameraId: 'cam1',
      role: 'live',
      frames: false,
    });
  });
});
