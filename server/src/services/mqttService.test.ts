import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockConnect = jest.fn();
const mockPublish = jest.fn();
const mockEnd = jest.fn();

jest.unstable_mockModule('mqtt', () => ({ connect: mockConnect }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const { MqttService } = await import('./mqttService.js');

function makeClient(fireConnect = true) {
  const client = {
    publish: mockPublish,
    end: mockEnd,
    on: (evt: string, cb: (...args: unknown[]) => void) => {
      if (evt === 'connect' && fireConnect) cb();
      return client;
    },
    connected: true,
  };
  return client;
}

describe('MqttService', () => {
  const cfg = {
    enabled: true,
    host: 'localhost',
    port: 1883,
    topicPrefix: 'sentryvision',
    user: undefined,
    password: undefined,
    qos: 0 as const,
  };

  let service: InstanceType<typeof MqttService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockImplementation(() => makeClient());
    service = new MqttService(cfg);
  });

  it('does not connect when disabled', () => {
    const off = new MqttService({ ...cfg, enabled: false });
    off.start();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('connects with last-will availability topic', () => {
    service.start();
    expect(mockConnect).toHaveBeenCalledWith(
      'mqtt://localhost:1883',
      expect.objectContaining({
        will: {
          topic: 'sentryvision/availability',
          payload: 'offline',
          qos: 0,
          retain: true,
        },
      }),
    );
  });

  it('publishes availability online retained after connect', () => {
    service.start();
    expect(mockPublish).toHaveBeenCalledWith(
      'sentryvision/availability',
      'online',
      { qos: 0, retain: true },
      expect.any(Function),
    );
  });

  it('publishes retained person state per camera', () => {
    service.start();
    mockPublish.mockClear();
    service.publishPersonState('cam1', true);
    expect(mockPublish).toHaveBeenCalledWith(
      'sentryvision/cam1/person',
      'ON',
      { qos: 0, retain: true },
      expect.any(Function),
    );
    service.publishPersonState('cam1', false);
    expect(mockPublish).toHaveBeenCalledWith(
      'sentryvision/cam1/person',
      'OFF',
      { qos: 0, retain: true },
      expect.any(Function),
    );
  });

  it('publishes retained camera status', () => {
    service.start();
    mockPublish.mockClear();
    service.publishCameraStatus('cam1', 'offline');
    expect(mockPublish).toHaveBeenCalledWith(
      'sentryvision/cam1/status',
      'offline',
      { qos: 0, retain: true },
      expect.any(Function),
    );
  });

  it('publishes detection event JSON non-retained', () => {
    service.start();
    mockPublish.mockClear();
    service.publishEvent('cam1', { id: 'e1', type: 'person', confidence: 0.9 });
    const [topic, payload, opts] = mockPublish.mock.calls[0];
    expect(topic).toBe('sentryvision/cam1/events');
    expect(JSON.parse(payload as string)).toMatchObject({
      id: 'e1',
      type: 'person',
      confidence: 0.9,
    });
    expect(opts).toEqual({ qos: 0, retain: false });
  });

  it('publishes HA discovery config for each camera', () => {
    service.start();
    mockPublish.mockClear();
    service.publishHADiscovery(['cam1', 'cam2']);
    const topics = mockPublish.mock.calls.map((c) => c[0]);
    expect(topics).toContain('homeassistant/binary_sensor/sentryvision_cam1_person/config');
    expect(topics).toContain('homeassistant/binary_sensor/sentryvision_cam2_person/config');
    const cfgCall = mockPublish.mock.calls.find((c) =>
      String(c[0]).includes('sentryvision_cam1_person/config'),
    );
    const payload = JSON.parse(cfgCall![1] as string);
    expect(payload.state_topic).toBe('sentryvision/cam1/person');
    expect(payload.device_class).toBe('occupancy');
  });

  it('sanitises camera ids in topics', () => {
    service.start();
    mockPublish.mockClear();
    service.publishPersonState('cam<script>', true);
    const [topic] = mockPublish.mock.calls[0];
    expect(topic).toBe('sentryvision/cam_script_/person');
  });

  it('skips publishing entirely when disabled', () => {
    const off = new MqttService({ ...cfg, enabled: false });
    off.start();
    off.publishPersonState('cam1', true);
    off.publishEvent('cam1', { id: 'e' });
    off.publishHADiscovery(['cam1']);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('ends client on stop', () => {
    service.start();
    service.stop();
    expect(mockEnd).toHaveBeenCalled();
  });

  it('does not throw when client disconnected', () => {
    service.start();
    mockConnect.mockImplementation(() => makeClient(false));
    service.start();
    expect(() => service.publishPersonState('cam1', true)).not.toThrow();
  });
});