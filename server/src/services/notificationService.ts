import { logger } from '../utils/logger.js';
import webPush from 'web-push';
import { AppDataSource } from '../database.js';
import fs from 'node:fs';
import path from 'node:path';
import type { StreamManager } from '../streams/rtspManager.js';

const VAPID_KEYS_DIR = process.env.VAPID_KEYS_DIR || '/data/vapid';
const VAPID_PUB_KEY_FILE = path.join(VAPID_KEYS_DIR, 'public_key.pem');
const VAPID_PRIV_KEY_FILE = path.join(VAPID_KEYS_DIR, 'private_key.pem');
import { NotificationSubscription } from '../models/NotificationSubscription.js';
import { NotificationLog } from '../models/NotificationLog.js';
import { NotificationPreferences } from '../models/NotificationPreferences.js';
import { Event } from '../models/Event.js';

const notificationSubscriptionRepository = AppDataSource.getRepository(NotificationSubscription);
const notificationLogRepository = AppDataSource.getRepository(NotificationLog);

interface NotificationPayload {
  title: string;
  body: string;
  icon?: string;
  image?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

interface PushSubscription {
  endpoint: string;
  keys: {
    p256h: string;
    auth: string;
  };
}

export class NotificationService {
  private static vapidPublicKey: string;
  private static vapidPrivateKey: string;
  private static vapidSubject: string;
  private static cameraNames: Map<string, string> = new Map();

  static loadCameraNames(streamManager: StreamManager): void {
    this.cameraNames.clear();
    const cameras = streamManager.getAllCameras();
    for (const camera of cameras) {
      this.cameraNames.set(camera.id, camera.name);
    }
    logger.info(
      `Loaded ${this.cameraNames.size} camera names for notifications`,
      'NotificationService',
    );
  }

  static getVapidPublicKey(): string | undefined {
    return this.vapidPublicKey || undefined;
  }

  static async initialize(): Promise<void> {
    this.vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@sentryvision.local';
    this.vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
    this.vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';

    if (!this.vapidPublicKey || !this.vapidPrivateKey) {
      try {
        if (fs.existsSync(VAPID_PUB_KEY_FILE)) {
          this.vapidPublicKey = fs.readFileSync(VAPID_PUB_KEY_FILE, 'utf-8').trim();
          this.vapidPrivateKey = fs.readFileSync(VAPID_PRIV_KEY_FILE, 'utf-8').trim();
          logger.info('VAPID keys loaded from filesystem', 'NotificationService');
        }
      } catch (err) {
        logger.warn('Could not load VAPID keys from filesystem', 'NotificationService');
      }
    }

    if (!this.vapidPublicKey || !this.vapidPrivateKey) {
      logger.info('Generating new VAPID keys...', 'NotificationService');
      const keys = webPush.generateVAPIDKeys();
      this.vapidPublicKey = keys.publicKey;
      this.vapidPrivateKey = keys.privateKey;

      try {
        if (!fs.existsSync(VAPID_KEYS_DIR)) {
          fs.mkdirSync(VAPID_KEYS_DIR, { recursive: true });
        }
        fs.writeFileSync(VAPID_PUB_KEY_FILE, this.vapidPublicKey, 'utf-8');
        fs.writeFileSync(VAPID_PRIV_KEY_FILE, this.vapidPrivateKey, 'utf-8');
        fs.chmodSync(VAPID_PUB_KEY_FILE, 0o600);
        fs.chmodSync(VAPID_PRIV_KEY_FILE, 0o600);
        logger.info('VAPID keys persisted to filesystem', 'NotificationService');
      } catch (err) {
        logger.warn(
          'Could not persist VAPID keys to filesystem — will regenerate on next restart',
          'NotificationService',
        );
      }
    }

    webPush.setVapidDetails(this.vapidSubject, this.vapidPublicKey, this.vapidPrivateKey);

    logger.info('Notification service initialized with VAPID keys', 'NotificationService');
  }

  static generateVAPIDKeys() {
    return webPush.generateVAPIDKeys();
  }

  static async subscribe(
    userId: string,
    subscription: PushSubscription,
  ): Promise<NotificationSubscription> {
    try {
      const newSubscription = notificationSubscriptionRepository.create({
        userId,
        endpoint: subscription.endpoint,
        keysP256h: subscription.keys.p256h,
        keysAuth: subscription.keys.auth,
        isActive: true,
      });

      await notificationSubscriptionRepository.save(newSubscription);
      logger.info(`User ${userId} subscribed to notifications`, 'NotificationService');
      return newSubscription;
    } catch (error) {
      logger.error('Failed to save subscription', 'NotificationService', error);
      throw error;
    }
  }

  static async unsubscribe(userId: string, endpoint: string): Promise<void> {
    try {
      await notificationSubscriptionRepository.delete({
        userId,
        endpoint,
      });
      logger.info(`User ${userId} unsubscribed from notifications`, 'NotificationService');
    } catch (error) {
      logger.error('Failed to unsubscribe', 'NotificationService', error);
      throw error;
    }
  }

  static async getSubscription(userId: string): Promise<NotificationSubscription | null> {
    try {
      return await notificationSubscriptionRepository.findOne({
        where: { userId, isActive: true },
      });
    } catch (error) {
      logger.error('Failed to get subscription', 'NotificationService', error);
      throw error;
    }
  }

  static async sendPushNotification(
    subscription: NotificationSubscription,
    payload: NotificationPayload,
  ): Promise<boolean> {
    const pushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keysP256h,
        auth: subscription.keysAuth,
      },
    };

    try {
      await webPush.sendNotification(pushSubscription, JSON.stringify(payload));

      await notificationSubscriptionRepository.update(subscription.id, {
        lastUsed: new Date(),
      });

      return true;
    } catch (error: unknown) {
      const notifErr = error as { statusCode?: number };
      if (notifErr.statusCode === 410) {
        await notificationSubscriptionRepository.update(subscription.id, {
          isActive: false,
        });
        logger.info('Subscription expired, marked as inactive', 'NotificationService');
      } else {
        logger.error('Failed to send push notification', 'NotificationService', error);
      }
      return false;
    }
  }

  static async shouldNotify(
    userId: string,
    eventType: string,
    isUrgent = false,
  ): Promise<boolean> {
    try {
      const preferencesRepository = AppDataSource.getRepository(NotificationPreferences);
      const prefs = await preferencesRepository.findOne({ where: { userId } });

      if (!prefs) {
        return true;
      }

      // Infrastructure alerts (disk, pipeline offline) must reach the user even
      // during quiet hours — quiet hours are for detection events.
      if (eventType === 'system') return true;

      if (eventType === 'motion' && !prefs.motionEnabled) return false;
      if (eventType === 'face' && !prefs.faceEnabled) return false;
      if (eventType === 'object' && !prefs.objectEnabled) return false;

      // JEV urgent assessment overrides quiet hours (break-in at 2am should still alert).
      if (isUrgent) {
        logger.info(
          `Urgent event override for user ${userId}, bypassing quiet hours`,
          'NotificationService',
        );
        return true;
      }

      if (prefs.quietHoursEnabled) {
        const now = new Date();
        const userTimeStr = now.toLocaleTimeString('en-US', {
          timeZone: prefs.quietHoursTimezone || 'UTC',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });

        const isQuietHours = this.isTimeInQuietHours(
          userTimeStr,
          prefs.quietHoursStart,
          prefs.quietHoursEnd,
        );

        if (isQuietHours) {
          logger.info(
            `Quiet hours active for user ${userId}, skipping notification`,
            'NotificationService',
          );
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Error checking notification preferences', 'NotificationService', error);
      return true;
    }
  }

  private static isTimeInQuietHours(
    currentTime: string,
    startTime: string,
    endTime: string,
  ): boolean {
    if (startTime < endTime) {
      return currentTime >= startTime && currentTime < endTime;
    } else {
      return currentTime >= startTime || currentTime < endTime;
    }
  }

  static async sendNotificationToUser(
    userId: string,
    payload: NotificationPayload,
    eventType: string,
    eventId?: string,
  ): Promise<void> {
    const subscriptions = await notificationSubscriptionRepository.find({
      where: { userId, isActive: true },
    });

    if (subscriptions.length === 0) {
      logger.info(`No active subscriptions found for user ${userId}`, 'NotificationService');
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const subscription of subscriptions) {
      const success = await this.sendPushNotification(subscription, payload);

      const log = notificationLogRepository.create({
        userId,
        eventId: eventId || null,
        type: eventType,
        payload: payload as any,
        status: success ? 'success' : 'failed',
        errorMessage: success ? null : 'Failed to deliver push notification',
        retryCount: success ? 0 : 1,
      });

      await notificationLogRepository.save(log);

      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    logger.info(
      `Notification sent to user ${userId}: ${successCount} success, ${failCount} failed`,
      'NotificationService',
    );
  }

  static async notifyMotionEvent(event: Event, isUrgent = false): Promise<void> {
    const cameraName = event.camera_id
      ? this.cameraNames.get(event.camera_id) || event.camera_id
      : 'Unknown camera';
    const timeStr = new Date(event.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const threat = (event.threat_assessment as { level?: string } | null) ?? null;
    const urgentTag = isUrgent || threat?.level === 'critical' ? '🚨 ' : '';

    const payload: NotificationPayload = {
      title: `${urgentTag}Motion Detected`,
      body: `Motion detected at ${cameraName} (${timeStr})`,
      icon: '/icon-192.png',
      image: event.file_path ? `/api/events/image/${event.file_path.split('/').pop()}` : undefined,
      badge: '/badge-72.png',
      tag: `motion-${event.camera_id}`,
      data: {
        eventId: event.id,
        cameraId: event.camera_id,
        timestamp: event.timestamp,
        type: 'motion',
        urgent: isUrgent,
      },
    };

    await this.sendNotificationToAllUsers(payload, 'motion', event.id, isUrgent);
  }

  static async notifyUnknownFace(event: Event, isUrgent = false): Promise<void> {
    const cameraName = event.camera_id
      ? this.cameraNames.get(event.camera_id) || event.camera_id
      : 'Unknown camera';
    const timeStr = new Date(event.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const threat = (event.threat_assessment as { level?: string } | null) ?? null;
    const urgentTag = isUrgent || threat?.level === 'critical' ? '🚨 ' : '';

    const payload: NotificationPayload = {
      title: `${urgentTag}Unknown Face Detected`,
      body: `Unknown person detected at ${cameraName} (${timeStr})`,
      icon: '/icon-192.png',
      image: event.file_path ? `/api/events/image/${event.file_path.split('/').pop()}` : undefined,
      badge: '/badge-72.png',
      tag: `face-unknown-${event.camera_id}`,
      data: {
        eventId: event.id,
        cameraId: event.camera_id,
        timestamp: event.timestamp,
        type: 'face',
        status: 'unknown',
        urgent: isUrgent,
      },
    };

    await this.sendNotificationToAllUsers(payload, 'face', event.id, isUrgent);
  }

  static async notifyObjectDetected(event: Event, objects: string[], isUrgent = false): Promise<void> {
    const cameraName = event.camera_id
      ? this.cameraNames.get(event.camera_id) || event.camera_id
      : 'Unknown camera';
    const timeStr = new Date(event.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const threat = (event.threat_assessment as { level?: string } | null) ?? null;
    const urgentTag = isUrgent || threat?.level === 'critical' ? '🚨 ' : '';

    const payload: NotificationPayload = {
      title: `${urgentTag}${objects[0]?.charAt(0).toUpperCase() + objects[0]?.slice(1)} Detected`,
      body: `${objects.join(', ')} detected at ${cameraName} (${timeStr})`,
      icon: '/icon-192.png',
      image: event.file_path ? `/api/events/image/${event.file_path.split('/').pop()}` : undefined,
      badge: '/badge-72.png',
      tag: `object-${objects[0]}-${event.camera_id}`,
      data: {
        eventId: event.id,
        cameraId: event.camera_id,
        timestamp: event.timestamp,
        type: 'object',
        objects,
        urgent: isUrgent,
      },
    };

    await this.sendNotificationToAllUsers(payload, 'object', event.id, isUrgent);
  }

  static async notifySystemAlert(title: string, message: string): Promise<void> {
    const payload: NotificationPayload = {
      title,
      body: message,
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      tag: `system-${Date.now()}`,
      data: {
        type: 'system',
        timestamp: new Date().toISOString(),
      },
    };

    await this.sendNotificationToAllUsers(payload, 'system');
  }

  private static async sendNotificationToAllUsers(
    payload: NotificationPayload,
    eventType: string,
    eventId?: string,
    isUrgent = false,
  ): Promise<void> {
    const { User } = await import('../models/index.js');
    const userRepository = AppDataSource.getRepository(User);

    const users = await userRepository.find();

    for (const user of users) {
      const shouldNotify = await this.shouldNotify(user.id, eventType, isUrgent);
      if (shouldNotify) {
        await this.sendNotificationToUser(user.id, payload, eventType, eventId);
      } else {
        logger.info(
          `Notification for ${eventType} suppressed for user ${user.id} due to preferences`,
          'NotificationService',
        );
      }
    }
  }

  static async cleanupExpiredSubscriptions(): Promise<number> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await notificationSubscriptionRepository
      .createQueryBuilder()
      .delete()
      .where('last_used < :date', { date: thirtyDaysAgo })
      .orWhere('is_active = :isActive', { isActive: false })
      .execute();

    logger.info(`Cleaned up ${result.affected || 0} expired subscriptions`, 'NotificationService');
    return result.affected || 0;
  }

  static async getNotificationLogs(userId: string, limit: number = 50): Promise<NotificationLog[]> {
    return await notificationLogRepository.find({
      where: { userId },
      order: { sentAt: 'DESC' },
      take: limit,
    });
  }
}

export default NotificationService;
