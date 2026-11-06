import { io, type Socket } from 'socket.io-client';
import { getAuthToken } from '@/services/api/baseClient';
import type { FaceDetectedEvent, PersonDetectedEvent } from '@/types/security';

type SocketCallback = (...args: never[]) => void;

export type StreamRole = 'detect' | 'record' | 'live';

export interface StreamRequestPayload {
  cameraId: string;
  role: StreamRole;
  frames: boolean;
}

/**
 * The payload sent for `requestStream`, in one place so a reconnect replay
 * cannot drop the `frames` flag and silently re-enable the JPEG relay.
 */
export const streamRequestPayload = (
  cameraId: string,
  role: StreamRole = 'live',
  frames = true,
): StreamRequestPayload => ({ cameraId, role, frames });

class SocketService {
  private socket: Socket | null = null;
  private callbacks = new Map<string, Set<SocketCallback>>();
  private connecting = false;
  private connectPromise: Promise<void> | null = null;
  private requestedStreams = new Map<string, StreamRequestPayload>();
  private visibilityHandler: (() => void) | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.visibilityHandler = () => {
        if (!document.hidden && this.socket?.connected) this.socket.emit('ping');
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      window.addEventListener('focus', this.visibilityHandler);
    }
  }

  connect(): Promise<void> {
    if (typeof window === 'undefined') return Promise.reject(new Error('Socket is client-only'));
    if (this.socket?.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connecting = true;
    const promise = new Promise<void>((resolve, reject) => {
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const socket = io(window.location.origin, {
        // Function form: socket.io re-invokes it on every (re)connect, so a
        // rotated token is picked up instead of replaying the stale one from
        // the initial connect (server rejects those since the JWT gate).
        auth: (cb: (data: { token: string | null }) => void) => cb({ token: getAuthToken() }),
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 5_000,
        reconnectionAttempts: 10,
        path: '/socket.io',
        timeout: isMobile ? 30_000 : 20_000,
        autoConnect: false,
        forceNew: false,
        upgrade: true,
      });
      this.socket = socket;

      const handleConnect = () => {
        this.callbacks.forEach((listeners, event) => {
          listeners.forEach((callback) => {
            socket.off(event, callback as never);
            socket.on(event, callback as never);
          });
        });
        this.requestedStreams.forEach((payload) => {
          socket.emit('requestStream', payload);
        });
        resolve();
      };
      const handleError = () => {
        reject(new Error('Socket connection failed'));
      };
      socket.once('connect', handleConnect);
      socket.once('connect_error', handleError);
      socket.connect();
    }).finally(() => {
      this.connecting = false;
      this.connectPromise = null;
    });
    this.connectPromise = promise;

    return promise;
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connecting = false;
    this.connectPromise = null;
    this.requestedStreams.clear();
    socket?.removeAllListeners();
    socket?.disconnect();
  }

  requestStream(cameraId: string, role: StreamRole = 'live', options: { frames?: boolean } = {}) {
    const payload = streamRequestPayload(cameraId, role, options.frames ?? true);
    this.requestedStreams.set(`${cameraId}-${role}`, payload);
    this.socket?.emit('requestStream', payload);
  }

  stopStream(cameraId: string, role: StreamRole = 'live') {
    this.requestedStreams.delete(`${cameraId}-${role}`);
    this.socket?.emit('stopStream', { cameraId, role });
  }

  on<C extends (...args: never[]) => void>(event: string, callback: C): () => void {
    const listeners = this.callbacks.get(event) ?? new Set<SocketCallback>();
    const erased = callback as unknown as SocketCallback;
    listeners.add(erased);
    this.callbacks.set(event, listeners);
    this.socket?.off(event, erased as never);
    this.socket?.on(event, erased as never);
    return () => this.off(event, erased);
  }

  off(event: string, callback: SocketCallback) {
    this.callbacks.get(event)?.delete(callback);
    this.socket?.off(event, callback as never);
  }

  onPersonDetected(callback: (data: PersonDetectedEvent) => void) {
    return this.on('personDetected', callback);
  }

  onFaceDetected(callback: (data: FaceDetectedEvent) => void) {
    return this.on('faceDetected', callback);
  }

  onEnhancedMotionDetected(callback: (data: Record<string, unknown>) => void) {
    return this.on('enhancedMotionDetected', callback);
  }

  isConnected() {
    return this.socket?.connected ?? false;
  }
}

const socketService = new SocketService();
export default socketService;
