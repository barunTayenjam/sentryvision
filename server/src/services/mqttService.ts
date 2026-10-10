import { connect as mqttConnect, type MqttClient } from 'mqtt';
import { logger } from '../utils/logger.js';

export interface MqttServiceConfig {
  enabled: boolean;
  host: string | undefined;
  port: number;
  topicPrefix: string;
  user: string | undefined;
  password: string | undefined;
  qos: 0 | 1 | 2;
}

const TOPIC_MAX = 200;

function safeTopicPart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, TOPIC_MAX);
}

export class MqttService {
  private client: MqttClient | null = null;
  private readonly prefix: string;
  private readonly qos: 0 | 1 | 2;

  constructor(private readonly config: MqttServiceConfig) {
    this.prefix = safeTopicPart(config.topicPrefix);
    this.qos = config.qos;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  start(): void {
    if (!this.config.enabled || !this.config.host) {
      logger.info('MQTT disabled — publisher not started', 'MQTT');
      return;
    }

    const url = `mqtt://${this.config.host}:${this.config.port}`;
    this.client = mqttConnect(url, {
      username: this.config.user,
      password: this.config.password,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      will: {
        topic: `${this.prefix}/availability`,
        payload: 'offline',
        qos: this.qos,
        retain: true,
      },
    });

    this.client.on('connect', () => {
      logger.info(`MQTT connected to ${url}`, 'MQTT');
      this.publishRetained(`${this.prefix}/availability`, 'online');
    });

    this.client.on('error', (err) => {
      logger.warn(`MQTT error: ${err.message}`, 'MQTT');
    });

    this.client.on('close', () => {
      logger.debug('MQTT connection closed', 'MQTT');
    });
  }

  stop(): void {
    if (!this.client) return;
    this.publishRetained(`${this.prefix}/availability`, 'offline');
    this.client.end(true);
    this.client = null;
  }

  /** Per-camera person occupancy state (retained, HA binary_sensor compatible). */
  publishPersonState(cameraId: string, present: boolean): void {
    this.publishRetained(
      `${this.prefix}/${safeTopicPart(cameraId)}/person`,
      present ? 'ON' : 'OFF',
    );
  }

  /** Per-camera stream health state (retained). */
  publishCameraStatus(cameraId: string, status: 'online' | 'offline' | 'warning'): void {
    this.publishRetained(`${this.prefix}/${safeTopicPart(cameraId)}/status`, status);
  }

  /** Detection event JSON (non-retained) on the camera event topic. */
  publishEvent(cameraId: string, payload: Record<string, unknown>): void {
    this.publish(
      `${this.prefix}/${safeTopicPart(cameraId)}/events`,
      JSON.stringify(payload),
      false,
    );
  }

  /**
   * Home Assistant MQTT discovery: one person binary_sensor per camera,
   * grouped under a device so HA shows them as one card.
   */
  publishHADiscovery(cameraIds: string[]): void {
    for (const cameraId of cameraIds) {
      const cam = safeTopicPart(cameraId);
      const payload = JSON.stringify({
        name: `${cam} person`,
        unique_id: `sentryvision_${cam}_person`,
        state_topic: `${this.prefix}/${cam}/person`,
        device_class: 'occupancy',
        availability_topic: `${this.prefix}/availability`,
        payload_on: 'ON',
        payload_off: 'OFF',
        device: {
          identifiers: [`sentryvision_${cam}`],
          name: `SentryVision ${cam}`,
          manufacturer: 'SentryVision',
        },
      });
      this.publishRetained(`homeassistant/binary_sensor/sentryvision_${cam}_person/config`, payload);
    }
  }

  private publishRetained(topic: string, payload: string): void {
    this.publish(topic, payload, true);
  }

  private publish(topic: string, payload: string, retain: boolean): void {
    if (!this.client || !this.client.connected) return;
    this.client.publish(topic, payload, { qos: this.qos, retain }, (err) => {
      if (err) {
        logger.warn(`MQTT publish failed for ${topic}: ${err.message}`, 'MQTT');
      }
    });
  }
}

let instance: MqttService | null = null;

export function getMqttService(): MqttService | null {
  return instance;
}

export function initMqttService(config: MqttServiceConfig): MqttService {
  instance = new MqttService(config);
  instance.start();
  return instance;
}

export function shutdownMqttService(): void {
  instance?.stop();
  instance = null;
}
