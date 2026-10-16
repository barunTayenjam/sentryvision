import { DataSource } from 'typeorm';
import { StreamManager } from '../streams/rtspManager.js';
import { ConsolidatedDetectionService } from '../detection/consolidatedDetectionService.js';
import { TimelineService } from './timeline/timelineService.js';
import { DetectionService } from './detection/detectionService.js';
import NotificationService from './notificationService.js';
import { RetentionPolicyService } from './retentionPolicyService.js';
import { AutomatedCleanupService } from './automatedCleanupService.js';
import { TimelapseService } from './timelapse/timelapseService.js';
import { PythonWsClient } from './pythonWsClient.js';

/**
 * Type-safe service registry replacing the unsafe `(global as any)` pattern.
 *
 * Provides typed getter/setter pairs for all backend services.
 * Getters throw descriptive errors if the service has not been initialized,
 * enabling fail-fast behavior rather than silent undefined access.
 */
class ServiceRegistry {
  private services: Map<string, unknown> = new Map();

  // ── AppDataSource ──

  setAppDataSource(dataSource: DataSource): void {
    this.services.set('appDataSource', dataSource);
  }

  getAppDataSource(): DataSource {
    return this.getRequired<DataSource>('appDataSource');
  }

  // ── StreamManager ──

  setStreamManager(manager: StreamManager): void {
    this.services.set('streamManager', manager);
  }

  getStreamManager(): StreamManager {
    return this.getRequired<StreamManager>('streamManager');
  }

  // ── ConsolidatedDetectionService ──

  setDetectionService(service: ConsolidatedDetectionService): void {
    this.services.set('detectionService', service);
  }

  getDetectionService(): ConsolidatedDetectionService {
    return this.getRequired<ConsolidatedDetectionService>('detectionService');
  }

  // ── TimelineService ──

  setTimelineService(service: TimelineService): void {
    this.services.set('timelineService', service);
  }

  getTimelineService(): TimelineService {
    return this.getRequired<TimelineService>('timelineService');
  }

  // ── DetectionService (config) ──

  setDetectionConfigService(service: DetectionService): void {
    this.services.set('detectionConfigService', service);
  }

  getDetectionConfigService(): DetectionService {
    return this.getRequired<DetectionService>('detectionConfigService');
  }

  // ── NotificationService (static class) ──

  setNotificationService(service: typeof NotificationService): void {
    this.services.set('notificationService', service);
  }

  getNotificationService(): typeof NotificationService {
    return this.getRequired<typeof NotificationService>('notificationService');
  }

  // ── RetentionPolicyService ──

  setRetentionPolicyService(service: RetentionPolicyService): void {
    this.services.set('retentionPolicyService', service);
  }

  getRetentionPolicyService(): RetentionPolicyService {
    return this.getRequired<RetentionPolicyService>('retentionPolicyService');
  }

  // ── AutomatedCleanupService ──

  setAutomatedCleanupService(service: AutomatedCleanupService): void {
    this.services.set('automatedCleanupService', service);
  }

  getAutomatedCleanupService(): AutomatedCleanupService {
    return this.getRequired<AutomatedCleanupService>('automatedCleanupService');
  }

  // ── TimelapseService ──

  setTimelapseService(service: TimelapseService): void {
    this.services.set('timelapseService', service);
  }

  getTimelapseService(): TimelapseService {
    return this.getRequired<TimelapseService>('timelapseService');
  }

  // ── PythonWsClient ──

  setPythonWsClient(client: PythonWsClient): void {
    this.services.set('pythonWsClient', client);
  }

  getPythonWsClient(): PythonWsClient {
    return this.getRequired<PythonWsClient>('pythonWsClient');
  }

  // ── Core getter with fail-fast ──

  private getRequired<T>(key: string): T {
    const service = this.services.get(key);
    if (!service) {
      throw new Error(
        `ServiceRegistry: Service '${key}' has not been initialized. ` +
          `Ensure serviceRegistry.set${key.charAt(0).toUpperCase() + key.slice(1)}() is called during startup.`,
      );
    }
    return service as T;
  }
}

/**
 * Singleton instance — import this everywhere instead of `(global as any)`.
 */
export const serviceRegistry = new ServiceRegistry();
export { ServiceRegistry };
