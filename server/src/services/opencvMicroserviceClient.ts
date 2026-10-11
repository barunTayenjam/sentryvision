import { logger } from '../utils/logger.js';
import axios, { AxiosInstance } from 'axios';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CircuitBreaker } from './circuitBreaker.js';

// Types for OpenCV microservice communication
export interface DetectionResult {
  success: boolean;
  cached: boolean;
  detections?: Array<{
    class: string;
    confidence: number;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
  faceDetections?: Array<{
    id: string;
    name: string;
    confidence: number;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
  processingTime?: number;
  fileHash: string;
  error?: string;
}

export interface OpenCVServiceStatus {
  status: 'ready' | 'initializing' | 'error';
  initialized: boolean;
  service: string;
}

export interface EmbeddingResult {
  embedding: number[];
  dim: number;
}

export class OpenCVMicroserviceClient {
  private client: AxiosInstance;
  private serviceUrl: string;
  private isHealthy: boolean = false;
  private lastHealthCheck: number = 0;
  private healthCheckInterval: number = 30000; // 30 seconds
  private breaker: CircuitBreaker;

  constructor(serviceUrl?: string) {
    this.serviceUrl = serviceUrl || process.env.OPENCV_SERVICE_URL || 'http://localhost:8084';

    this.client = axios.create({
      baseURL: this.serviceUrl,
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.OPENCV_API_TOKEN ? { 'X-API-Token': process.env.OPENCV_API_TOKEN } : {}),
      },
    });

    this.breaker = new CircuitBreaker('OpenCVService', {
      failureThreshold: 5,
      cooldownMs: 30000,
      successThreshold: 2,
    });

    // Request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.info(
          `OpenCV Microservice: ${config.method?.toUpperCase()} ${config.url}`,
          'OpenCVClient',
        );
        return config;
      },
      (error) => {
        logger.error('OpenCV Microservice: Request error', 'OpenCVClient', error);
        return Promise.reject(error);
      },
    );

    // Response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        logger.info(
          `OpenCV Microservice: Response ${response.status} from ${response.config.url}`,
          'OpenCVClient',
        );
        return response;
      },
      (error) => {
        logger.error(`OpenCV Microservice: Response error: ${error.message}`, 'OpenCVClient');
        return Promise.reject(error);
      },
    );
  }

  /**
   * Check if the OpenCV microservice is healthy and ready
   */
  async checkHealth(): Promise<boolean> {
    try {
      const now = Date.now();

      // Cache health check results for a short period
      if (this.isHealthy && now - this.lastHealthCheck < this.healthCheckInterval) {
        return true;
      }

      const response = await this.breaker.execute(() => this.client.get('/health'));
      const isHealthy = response.status === 200 && response.data?.status === 'healthy';

      if (isHealthy) {
        this.isHealthy = true;
        this.lastHealthCheck = now;
        logger.info('OpenCV Microservice: Health check passed', 'OpenCVClient');
      } else {
        this.isHealthy = false;
        logger.warn(
          'OpenCV Microservice: Health check failed - service not healthy',
          'OpenCVClient',
        );
      }

      return isHealthy;
    } catch (error) {
      this.isHealthy = false;
      logger.error('OpenCV Microservice: Health check failed', 'OpenCVClient', error);
      return false;
    }
  }

  /**
   * Get detailed status of the OpenCV service
   */
  async getStatus(): Promise<OpenCVServiceStatus | null> {
    try {
      const response = await this.client.get('/status');
      return response.data;
    } catch (error) {
      logger.error('OpenCV Microservice: Failed to get status', 'OpenCVClient', error);
      return null;
    }
  }

  /**
   * Detect objects in an image using the OpenCV microservice
   */
  async detectObjects(imagePath: string): Promise<DetectionResult> {
    try {
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }

      const imageBuffer = await fs.promises.readFile(imagePath);
      const stats = fs.statSync(imagePath);
      const fileHash = this.generateFileHash(imagePath, stats);

      logger.info(`OpenCV Microservice: Detecting objects in ${imagePath}`, 'OpenCVClient');

      const response = await this.breaker.execute(() =>
        this.client.post('/detect-objects', imageBuffer, {
          headers: { 'Content-Type': 'image/jpeg' },
          params: { fileHash, fileSize: stats.size },
        }),
      );
      return { ...response.data, fileHash };
    } catch (error) {
      logger.error(
        `OpenCV Microservice: Object detection failed for ${imagePath}`,
        'OpenCVClient',
        error,
      );

      if (axios.isAxiosError(error)) {
        throw new Error(`OpenCV service error: ${error.response?.data?.error || error.message}`, {
          cause: error,
        });
      }

      throw error;
    }
  }

  /**
   * Recognize faces in an image using the OpenCV microservice
   */
  async recognizeFaces(imagePath: string): Promise<DetectionResult> {
    try {
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }

      const imageBuffer = await fs.promises.readFile(imagePath);
      const stats = fs.statSync(imagePath);
      const fileHash = this.generateFileHash(imagePath, stats);

      logger.info(`OpenCV Microservice: Recognizing faces in ${imagePath}`, 'OpenCVClient');

      const response = await this.breaker.execute(() =>
        this.client.post('/recognize-faces', imageBuffer, {
          headers: { 'Content-Type': 'image/jpeg' },
          params: { fileHash, fileSize: stats.size },
        }),
      );
      return { ...response.data, fileHash };
    } catch (error) {
      logger.error(
        `OpenCV Microservice: Face recognition failed for ${imagePath}`,
        'OpenCVClient',
        error,
      );

      if (axios.isAxiosError(error)) {
        throw new Error(`OpenCV service error: ${error.response?.data?.error || error.message}`, { cause: error });
      }

      throw error;
    }
  }

  async pushDetectionConfig(cameraId: string, config: Record<string, unknown>): Promise<boolean> {
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      try {
        const response = await this.breaker.execute(() =>
          this.client.post(
            '/api/config',
            {
              camera_id: cameraId,
              settings: config,
            },
            { timeout: 5000 },
          ),
        );
        return response.status === 200;
      } catch (error) {
        attempt++;
        if (attempt >= maxAttempts) {
          logger.error(`Failed to push detection config to Python service: ${error}`, 'OpenCVClient');
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    return false;
  }

  /**
   * Text embedding for semantic search (all-MiniLM-L6-v2 384-dim, /embed).
   * Returns null when the embedder is unavailable — callers fall back to
   * keyword search instead of failing the request.
   */
  async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const response = await this.breaker.execute(() =>
        this.client.post('/embed', { text }, { timeout: 5000 }),
      );
      const data = response.data as EmbeddingResult;
      return Array.isArray(data?.embedding) && data.embedding.length > 0 ? data.embedding : null;
    } catch (error) {
      logger.warn('OpenCV Microservice: Embedding request failed', 'OpenCVClient', error);
      return null;
    }
  }

  /**
   * Generate a hash for file identification and caching
   */
  private generateFileHash(imagePath: string, stats: fs.Stats): string {
    const hash = crypto.createHash('md5');

    // Include file path, size, and modification time in hash
    hash.update(imagePath);
    hash.update(stats.size.toString());
    hash.update(stats.mtime.toISOString());

    return hash.digest('hex');
  }

  /**
   * Wait for service to be ready (with timeout)
   */
  async waitForReady(timeoutMs: number = 120000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds

    logger.info(
      `OpenCV Microservice: Waiting for service to be ready (timeout: ${timeoutMs}ms)`,
      'OpenCVClient',
    );

    while (Date.now() - startTime < timeoutMs) {
      try {
        const isHealthy = await this.checkHealth();
        const status = await this.getStatus();

        // Consider service ready if it's healthy, even if not fully initialized
        // This allows mock detection to work while real OpenCV initialization continues
        if (isHealthy && status && status.status === 'ready') {
          logger.info('OpenCV Microservice: Service is ready and healthy', 'OpenCVClient');
          this.isHealthy = true;
          this.lastHealthCheck = Date.now();
          return true;
        }

        logger.info(
          `OpenCV Microservice: Service status: ${status?.status || 'unknown'}, healthy: ${isHealthy}, waiting...`,
          'OpenCVClient',
        );
      } catch (error) {
        logger.info('OpenCV Microservice: Service not ready yet, waiting...', 'OpenCVClient');
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    logger.error('OpenCV Microservice: Timeout waiting for service to be ready', 'OpenCVClient');
    return false;
  }

  /**
   * Get the service URL
   */
  getServiceUrl(): string {
    return this.serviceUrl;
  }

  /**
   * Check if the client is currently healthy
   */
  isServiceHealthy(): boolean {
    return this.isHealthy;
  }

  /**
   * Get circuit breaker state
   */
  getBreakerState(): string {
    return this.breaker.getState();
  }
}

// Singleton instance for the application
let openCVClient: OpenCVMicroserviceClient | null = null;

export function getOpenCVClient(): OpenCVMicroserviceClient {
  if (!openCVClient) {
    openCVClient = new OpenCVMicroserviceClient();
  }
  return openCVClient;
}

export function resetOpenCVClient(): void {
  openCVClient = null;
}

export default OpenCVMicroserviceClient;
