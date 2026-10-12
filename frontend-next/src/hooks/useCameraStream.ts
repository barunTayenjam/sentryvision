import { useEffect, useState, useRef, useCallback } from 'react';
import { useCameraStore } from '@/stores/camera';
import { useSocketStore } from '@/stores/socket';
import socketService from '@/services/SocketService';
import { getAuthToken } from '@/services/api/baseClient';
import { Camera } from '@/types/security';

const camLog = (msg: string, meta?: Record<string, unknown>) =>
  console.debug(`[CAMERA] ${msg}`, meta);
const camWarn = (msg: string, meta?: Record<string, unknown>) =>
  console.warn(`[CAMERA] ${msg}`, meta);

// go2rtc sits behind a JWT gate; <video>/<WebSocket> cannot set headers,
// so HLS and MSE streams carry the token in the URL.
const withMediaToken = (url: string): string => {
  const token = getAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
};

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'reconnecting';

export interface StreamMetrics {
  fps: number;
  bandwidth: number;
  latency: number;
  resolution: string;
}

interface MotionState {
  detected: boolean;
  confidence: number;
  objectCount: number;
  lastMotionTime: number;
}

const GO2RTC_BASE = '/go2rtc';

interface UseCameraStreamOptions {
  camera: Camera;
  /** go2rtc stream name override (e.g. `${id}_sub` substream for tiles). */
  streamSrc?: string;
  autoStart?: boolean;
}

export const useCameraStream = ({ camera, streamSrc, autoStart = true }: UseCameraStreamOptions) => {
  const src = streamSrc ?? camera.id;
  const startCameraStream = useCameraStore((state) => state.startCameraStream);
  const stopCameraStream = useCameraStore((state) => state.stopCameraStream);
  const socketConnected = useSocketStore((state) => state.connected);

  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [isWanStream, setIsWanStream] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [showFullOverlay, setShowFullOverlay] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const mseWsRef = useRef<WebSocket | null>(null);
  const mseMediaSourceRef = useRef<MediaSource | null>(null);
  const mseSettledRef = useRef(false);

  const lastFrameTimeRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const [metrics, setMetrics] = useState<StreamMetrics>({
    fps: 0,
    bandwidth: 0,
    latency: 0,
    resolution: '1080p',
  });

  const [motion, setMotion] = useState<MotionState>({
    detected: false,
    confidence: 0,
    objectCount: 0,
    lastMotionTime: 0,
  });

  const streamActionRef = useRef<'start' | 'stop' | null>(null);
  const connectionStartTimeRef = useRef<number>(0);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeDetectionRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  const lastRestartTimeRef = useRef<number>(0);
  const restartCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureCountRef = useRef<number>(0);
  const connectionAttemptsRef = useRef<number>(0);
  const lastConnectionAttemptRef = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(0);
  const lastVideoTimeUpdateRef = useRef<number>(0);
  const watchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamStartTimeRef = useRef<number>(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestFrameRef = useRef<HTMLImageElement | null>(null);
  const hasNewFrameRef = useRef(false);
  const renderRafRef = useRef<number>(0);
  const isWanRef = useRef<boolean | null>(null);
  const frameUnsubscribeRef = useRef<(() => void) | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const handleStreamStartRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const handleStreamStopRef = useRef<() => void>(() => {});

  const RESTART_COOLDOWN_MS = 5000;
  const VISIBILITY_DEBOUNCE_MS = 1000;
  const MAX_FAILURE_COUNT = 3;
  const CONNECTION_RATE_LIMIT_MS = 3000;
  const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = 10;
  const STALL_THRESHOLD_MS = 5000;
  const STARTUP_GRACE_PERIOD_MS = 10000;

  const rateLimitResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canRestartStream = useCallback(() => {
    const now = Date.now();
    const timeSinceLastRestart = now - lastRestartTimeRef.current;

    if (timeSinceLastRestart < RESTART_COOLDOWN_MS) {
      return false;
    }

    if (now - lastConnectionAttemptRef.current < CONNECTION_RATE_LIMIT_MS) {
      return false;
    }

    connectionAttemptsRef.current++;
    if (connectionAttemptsRef.current > MAX_CONNECTION_ATTEMPTS_PER_MINUTE) {
      if (!rateLimitResetRef.current) {
        rateLimitResetRef.current = setTimeout(() => {
          connectionAttemptsRef.current = 0;
          rateLimitResetRef.current = null;
        }, 60000);
      }
      return false;
    }

    lastRestartTimeRef.current = now;
    lastConnectionAttemptRef.current = now;
    return true;
  }, []);

  const handleStreamRestart = useCallback(() => {
    if (!canRestartStream()) {
      camLog(`[CameraStream:${camera.name}] Restart suppressed by rate limit or cooldown`);
      return;
    }

    camLog(`[CameraStream:${camera.name}] Restarting stream...`);

    if (failureCountRef.current >= MAX_FAILURE_COUNT) {
      const backoffMs = Math.min(
        30000,
        1000 * Math.pow(2, failureCountRef.current - MAX_FAILURE_COUNT),
      );
      camLog(
        `[CameraStream:${camera.name}] Too many failures, backing off for ${backoffMs}ms`,
      );
      if (restartCooldownRef.current) clearTimeout(restartCooldownRef.current);
      restartCooldownRef.current = setTimeout(() => {
        streamActionRef.current = null;
        handleStreamStopRef.current();
        restartTimerRef.current = setTimeout(() => {
          handleStreamStartRef.current();
        }, 500);
      }, backoffMs);
      return;
    }

    streamActionRef.current = null;
    handleStreamStopRef.current();
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => handleStreamStartRef.current(), 1000);
  }, [canRestartStream, camera.name]);

  useEffect(() => {
    if (connectionState === 'connecting' || connectionState === 'reconnecting') {
      setShowFullOverlay(true);
      connectionStartTimeRef.current = Date.now();
    }
    if (connectionState === 'connected') {
      setShowFullOverlay(false);
    }
    if (connectionState === 'error') {
      setShowFullOverlay(true);
    }
    if (connectionState === 'idle') {
      setShowFullOverlay(false);
    }
  }, [connectionState]);

  useEffect(() => {
    if (
      (connectionState === 'connecting' || connectionState === 'reconnecting') &&
      showFullOverlay
    ) {
      const timer = setTimeout(() => {
        setShowFullOverlay(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [connectionState, showFullOverlay]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    swipeDetectionRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!swipeDetectionRef.current) return;
    const dx = Math.abs(e.clientX - swipeDetectionRef.current.startX);
    const dy = Math.abs(e.clientY - swipeDetectionRef.current.startY);
    if (dx > 10 || dy > 10) {
      swipeDetectionRef.current.moved = true;
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    if (swipeDetectionRef.current && !swipeDetectionRef.current.moved) {
      const video = videoRef.current;
      if (video) {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          video.requestFullscreen().catch(() => {});
        }
      }
    }
    swipeDetectionRef.current = null;
  }, []);

  const cleanupHLS = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  }, []);

  const startHLS = useCallback((): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      cleanupHLS();
      camLog(`[CameraStream:${camera.name}] Starting HLS stream via go2rtc`);
      const hlsUrl = `${GO2RTC_BASE}/api/stream.m3u8?src=${src}`;
      const video = videoRef.current;

      if (!video) {
        reject(new Error('No video element'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('HLS connection timeout'));
      }, 15000);

      const onPlay = () => {
        clearTimeout(timeout);
        lastFrameTimeRef.current = Date.now();
        lastVideoTimeRef.current = 0;
        lastVideoTimeUpdateRef.current = Date.now();
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        const elapsed = Date.now() - streamStartTimeRef.current;
        setMetrics((prev) => ({ ...prev, latency: elapsed }));
        connectionAttemptsRef.current = 0;
        setConnectionState('connected');
        video.removeEventListener('playing', onPlay);
        resolve();
      };

      const onError = () => {
        clearTimeout(timeout);
        video.removeEventListener('error', onError);
        reject(new Error('HLS playback error'));
      };

      video.addEventListener('playing', onPlay);
      video.addEventListener('error', onError);
      video.src = withMediaToken(hlsUrl);
      video.play().catch((e) => {
        if (e.name !== 'AbortError') camWarn('HLS play failed:', e);
      });
    });
  }, [src, camera.id, camera.name, cleanupHLS]);

  const cleanupPeerConnection = useCallback(() => {
    if (pcRef.current) {
      camLog(`[CameraStream:${camera.name}] Cleaning up PeerConnection`);
      pcRef.current.close();
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (watchdogIntervalRef.current) {
      clearInterval(watchdogIntervalRef.current);
      watchdogIntervalRef.current = null;
    }
  }, [camera.name]);

  const isStreamingRef = useRef(isStreaming);
  const connectionStateRef = useRef(connectionState);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
    connectionStateRef.current = connectionState;
  }, [isStreaming, connectionState]);

  const startWatchdog = useCallback(() => {
    if (watchdogIntervalRef.current) clearInterval(watchdogIntervalRef.current);
    watchdogIntervalRef.current = setInterval(() => {
      if (videoRef.current && isStreamingRef.current && !document.hidden && !isWanRef.current) {
        const now = Date.now();

        if (now - streamStartTimeRef.current < STARTUP_GRACE_PERIOD_MS) return;

        if (connectionStateRef.current === 'reconnecting') {
          if (now - lastVideoTimeUpdateRef.current > STALL_THRESHOLD_MS * 2) {
            camWarn(`[CameraStream:${camera.name}] ICE disconnected too long, restarting`);
            failureCountRef.current++;
            handleStreamRestart();
          }
          return;
        }

        if (
          connectionStateRef.current === 'connecting' ||
          connectionStateRef.current === ('reconnecting' as string)
        ) {
          const video = videoRef.current;
          if (video.currentTime > 0 && video.readyState >= 2 && !mseSettledRef.current) {
            camLog(
              `[CameraStream:${camera.name}] Video playing but connection never settled — forcing connected`,
            );
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            setConnectionState('connected');
            mseSettledRef.current = true;
          }
          return;
        }

        if (connectionStateRef.current !== 'connected') return;

        const currentTime = videoRef.current.currentTime;

        if (currentTime !== lastVideoTimeRef.current) {
          lastVideoTimeRef.current = currentTime;
          lastVideoTimeUpdateRef.current = now;
          failureCountRef.current = 0;
        } else if (now - lastVideoTimeUpdateRef.current > STALL_THRESHOLD_MS) {
          camWarn(`[CameraStream:${camera.name}] Stream stalled detected by watchdog`);
          handleStreamRestart();
        }
      }
    }, 2000);
  }, [camera.name, handleStreamRestart]);

  const startWebRTC = useCallback((): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      cleanupPeerConnection();

      camLog(`[CameraStream:${camera.name}] Starting WebRTC connection`);
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pcRef.current = pc;

      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      let settled = false;

      pc.ontrack = (event) => {
        if (pcRef.current !== pc) return;
        camLog(`[CameraStream:${camera.name}] Received video track`);
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
          lastFrameTimeRef.current = Date.now();
          lastVideoTimeRef.current = 0;
          lastVideoTimeUpdateRef.current = Date.now();

          videoRef.current.play().catch((e) => {
            if (e.name !== 'AbortError') camWarn('Video play failed:', e);
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        const state = pc.iceConnectionState;
        camLog(`[CameraStream:${camera.name}] ICE state: ${state}`);

        if (settled) {
          if (state === 'failed') {
            failureCountRef.current++;
            handleStreamRestart();
          } else if (state === 'disconnected') {
            camLog(`[CameraStream:${camera.name}] ICE disconnected, waiting for recovery...`);
            setConnectionState('reconnecting');
          } else if (state === 'connected' || state === 'completed') {
            lastFrameTimeRef.current = Date.now();
            lastVideoTimeRef.current = 0;
            lastVideoTimeUpdateRef.current = Date.now();
            setConnectionState('connected');
          }
          return;
        }

        if (state === 'connected' || state === 'completed') {
          settled = true;
          lastFrameTimeRef.current = Date.now();
          lastVideoTimeRef.current = 0;
          lastVideoTimeUpdateRef.current = Date.now();
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          const elapsed = Date.now() - streamStartTimeRef.current;
          setMetrics((prev) => ({ ...prev, latency: elapsed }));
          connectionAttemptsRef.current = 0;
          setConnectionState('connected');
          resolve();
        } else if (state === 'failed') {
          settled = true;
          reject(new Error('ICE connection failed'));
        } else if (state === 'disconnected') {
          camLog(`[CameraStream:${camera.name}] ICE disconnected, waiting for recovery...`);
          setConnectionState('reconnecting');
        }
      };

      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          const token = getAuthToken();
          const response = await fetch(`${GO2RTC_BASE}/api/webrtc?src=${src}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ type: offer.type, sdp: offer.sdp }),
          });

          if (!response.ok) {
            throw new Error(`go2rtc returned ${response.status}`);
          }

          const answer = await response.json();
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      })();
    });
  }, [src, camera.id, camera.name, cleanupPeerConnection, handleStreamRestart]);

  const cleanupMSE = useCallback(() => {
    mseSettledRef.current = false;
    if (mseWsRef.current) {
      mseWsRef.current.close();
      mseWsRef.current = null;
    }
    if (mseMediaSourceRef.current) {
      try {
        if (mseMediaSourceRef.current.readyState === 'open')
          mseMediaSourceRef.current.endOfStream();
      } catch {
        /* ended */
      }
      mseMediaSourceRef.current = null;
    }
  }, []);

  const startMSE = useCallback((): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      cleanupMSE();
      camLog(`[CameraStream:${camera.name}] Starting MSE stream via go2rtc`);
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}${GO2RTC_BASE}/api/ws?src=${src}`;
      const ws = new WebSocket(withMediaToken(wsUrl));
      ws.binaryType = 'arraybuffer';
      mseWsRef.current = ws;

      mseSettledRef.current = false;
      let sourceBuffer: SourceBuffer | null = null;
      const queue: ArrayBuffer[] = [];
      let isUpdating = false;

      const drainQueue = () => {
        if (!sourceBuffer || isUpdating || queue.length === 0) return;
        isUpdating = true;
        try {
          sourceBuffer.appendBuffer(queue.shift()!);
        } catch {
          isUpdating = false;
        }
      };

      const settleMse = () => {
        if (mseSettledRef.current) return;
        mseSettledRef.current = true;
        lastFrameTimeRef.current = Date.now();
        lastVideoTimeRef.current = 0;
        lastVideoTimeUpdateRef.current = Date.now();
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        const elapsed = Date.now() - streamStartTimeRef.current;
        setMetrics((prev) => ({ ...prev, latency: elapsed }));
        connectionAttemptsRef.current = 0;
        setConnectionState('connected');
        resolve();
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'mse', value: 'video' }));
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'mse' && msg.value) {
              const ms = new MediaSource();
              mseMediaSourceRef.current = ms;
              ms.addEventListener('sourceopen', () => {
                try {
                  sourceBuffer = ms.addSourceBuffer(msg.value);
                  sourceBuffer.mode = 'segments';
                  sourceBuffer.addEventListener('updateend', () => {
                    isUpdating = false;
                    drainQueue();
                  });
                  sourceBuffer.addEventListener('error', () => {
                    isUpdating = false;
                  });
                  if (queue.length > 0) settleMse();
                } catch (err) {
                  if (!mseSettledRef.current) {
                    mseSettledRef.current = true;
                    reject(err);
                  }
                }
              });
              if (videoRef.current) {
                videoRef.current.src = URL.createObjectURL(ms);
                videoRef.current.play().catch((e) => {
                  if (e.name !== 'AbortError') camWarn('Video play failed:', e);
                });
              }
            }
          } catch {
            /* parse error */
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          queue.push(event.data);
          if (sourceBuffer) settleMse();
          drainQueue();
        }
      };

      ws.onerror = () => {
        mseSettledRef.current = true;
        reject(new Error('MSE WebSocket error'));
      };
      ws.onclose = () => {
        if (mseSettledRef.current) {
          return;
        } else if (connectionStateRef.current === 'connected') {
          camLog(`[CameraStream:${camera.name}] MSE WebSocket closed unexpectedly`);
          setConnectionState('reconnecting');
          failureCountRef.current++;
          handleStreamRestart();
        }
      };
    });
  }, [src, camera.id, camera.name, cleanupMSE, handleStreamRestart]);

  const stopFrameRender = useCallback(() => {
    if (renderRafRef.current) {
      cancelAnimationFrame(renderRafRef.current);
      renderRafRef.current = 0;
    }
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (frameUnsubscribeRef.current) {
      frameUnsubscribeRef.current();
      frameUnsubscribeRef.current = null;
    }
    if (latestFrameRef.current) {
      URL.revokeObjectURL(latestFrameRef.current.src);
      latestFrameRef.current = null;
    }
    hasNewFrameRef.current = false;
  }, []);

  const startFrameRender = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resizeCanvas = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };

    resizeCanvas();
    const parent = canvas.parentElement;
    if (parent) {
      resizeObserverRef.current = new ResizeObserver(resizeCanvas);
      resizeObserverRef.current.observe(parent);
    }

    const render = () => {
      if (hasNewFrameRef.current && latestFrameRef.current) {
        const img = latestFrameRef.current;
        if (
          canvas.width > 0 &&
          canvas.height > 0 &&
          img.naturalWidth > 0 &&
          img.naturalHeight > 0
        ) {
          const scale = Math.max(
            canvas.width / img.naturalWidth,
            canvas.height / img.naturalHeight,
          );
          const x = (canvas.width - img.naturalWidth * scale) / 2;
          const y = (canvas.height - img.naturalHeight * scale) / 2;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, x, y, img.naturalWidth * scale, img.naturalHeight * scale);
        }
        hasNewFrameRef.current = false;
      }
      renderRafRef.current = requestAnimationFrame(render);
    };
    renderRafRef.current = requestAnimationFrame(render);
  }, []);

  const setupWanStream = useCallback(() => {
    setIsWanStream(true);
    stopFrameRender();
    frameUnsubscribeRef.current = socketService.on('frame', (raw: Record<string, unknown>) => {
      const event = raw as { cameraId: string; data: ArrayBuffer; role: string; timestamp: string };
      if (event.cameraId !== camera.id) return;
      const blob = new Blob([event.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        if (latestFrameRef.current) {
          URL.revokeObjectURL(latestFrameRef.current.src);
        }
        latestFrameRef.current = img;
        hasNewFrameRef.current = true;
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    });
    startFrameRender();
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    setConnectionState('connected');
  }, [camera.id, stopFrameRender, startFrameRender]);

  const getStreamErrorMessage = useCallback((err: unknown, mode: 'initial' | 'webrtc' | 'mse' | 'hls' | 'socket' = 'initial') => {
    if (mode === 'socket') {
      const msg = err instanceof Error ? err.message : String(err);
      // Socket errors are already formatted by the server; pass through concisely
      return msg.length > 80 ? msg.slice(0, 77) + '...' : msg;
    }

    const base = err instanceof Error ? err.message : 'Failed to start stream';

    switch (mode) {
      case 'initial':
        if (base.includes('timeout')) {
          return 'Connection timed out. Check your network and try again.';
        }
        if (base.includes('WebRTC')) {
          return 'WebRTC connection failed. Trying MSE fallback...';
        }
        if (base.includes('MSE')) {
          return 'MSE stream failed. Trying HLS fallback...';
        }
        if (base.includes('HLS')) {
          return 'HLS playback failed. Falling back to browser canvas.';
        }
        return 'Failed to start stream. Please try again.';

      case 'webrtc':
        return 'WebRTC connection lost. Check network and restart stream.';

      case 'mse':
        return 'MSE stream error. Switching to alternative playback method.';

      case 'hls':
        return 'HLS stream error. Video will play via browser fallback.';

      default:
        return base;
    }
  }, []);

  const handleStreamStart = useCallback(async () => {
    if (streamActionRef.current === 'start') return;

    camLog(`[CameraStream:${camera.name}] Starting stream`);
    setError(null);
    setConnectionState('connecting');
    streamActionRef.current = 'start';
    setIsStreaming(true);
    setIsWanStream(false);

    frameCountRef.current = 0;
    lastFrameTimeRef.current = Date.now();
    lastVideoTimeRef.current = 0;
    lastVideoTimeUpdateRef.current = Date.now();
    streamStartTimeRef.current = Date.now();

    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
    }
    connectionTimeoutRef.current = setTimeout(() => {
      streamActionRef.current = null;
      setConnectionState('error');
      setError(getStreamErrorMessage('Connection timeout', 'initial'));
      setIsStreaming(false);
    }, 30000);

    try {
      await startCameraStream(camera.id);

      if (isWanRef.current === true) {
        setupWanStream();
        return;
      }

      const webRtcTimeoutMs = isWanRef.current === false ? 10000 : 5000;
      try {
        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('WebRTC timeout')), webRtcTimeoutMs),
        );
        await Promise.race([startWebRTC(), timeoutPromise]);
        isWanRef.current = false;
        startWatchdog();
      } catch {
        camLog(`[CameraStream:${camera.name}] WebRTC failed, trying MSE...`);
        cleanupPeerConnection();
        try {
          const mseTimeout = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('MSE timeout')), 15000),
          );
          await Promise.race([startMSE(), mseTimeout]);
          isWanRef.current = false;
          camLog(`[CameraStream:${camera.name}] MSE connected`);
          startWatchdog();
        } catch (mseError) {
          camLog(`[CameraStream:${camera.name}] MSE failed (${mseError}), trying HLS...`);
          cleanupMSE();
          try {
            const hlsTimeout = new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('HLS timeout')), 15000),
            );
            await Promise.race([startHLS(), hlsTimeout]);
            isWanRef.current = false;
            camLog(`[CameraStream:${camera.name}] HLS connected`);
            startWatchdog();
          } catch (hlsError) {
            camLog(`[CameraStream:${camera.name}] HLS failed (${hlsError}), falling back to WAN canvas`);
            cleanupHLS();
            isWanRef.current = true;
            setupWanStream();
          }
        }
      }
    } catch (err) {
      failureCountRef.current++;
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      const errorMessage = getStreamErrorMessage(err, 'initial');
      setError(errorMessage);
      setConnectionState('error');
      setIsStreaming(false);
      setIsWanStream(false);
      cleanupPeerConnection();
      cleanupMSE();
      cleanupHLS();
      stopFrameRender();
      streamActionRef.current = null;
    }
  }, [
    camera.id,
    camera.name,
    startCameraStream,
    startWebRTC,
    startMSE,
    startHLS,
    cleanupPeerConnection,
    cleanupMSE,
    cleanupHLS,
    stopFrameRender,
    setupWanStream,
    startWatchdog,
    getStreamErrorMessage,
  ]);

  const handleStreamStop = useCallback(() => {
    if (streamActionRef.current === 'stop') return;

    camLog(`[CameraStream:${camera.name}] Stopping stream`);
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    streamActionRef.current = 'stop';
    setIsStreaming(false);
    setIsWanStream(false);
    setConnectionState('idle');
    cleanupPeerConnection();
    cleanupMSE();
    cleanupHLS();
    stopFrameRender();
    stopCameraStream(camera.id);
  }, [
    camera.id,
    camera.name,
    stopCameraStream,
    cleanupPeerConnection,
    cleanupMSE,
    cleanupHLS,
    stopFrameRender,
  ]);

  handleStreamStartRef.current = handleStreamStart;
  handleStreamStopRef.current = handleStreamStop;

  useEffect(() => {
    return () => {
      if (rateLimitResetRef.current) {
        clearTimeout(rateLimitResetRef.current);
        rateLimitResetRef.current = null;
      }
      if (restartCooldownRef.current) {
        clearTimeout(restartCooldownRef.current);
        restartCooldownRef.current = null;
      }
      if (watchdogIntervalRef.current) {
        clearInterval(watchdogIntervalRef.current);
      }
      stopFrameRender();
    };
  }, [stopFrameRender]);

  useEffect(() => {
    let mountTimer: ReturnType<typeof setTimeout> | null = null;

    const maybeStart = () => {
      if (
        autoStart &&
        socketConnected &&
        !isStreaming &&
        (connectionState === 'idle' || connectionState === 'error')
      ) {
        camLog(`[CameraStream:${camera.name}] Auto-starting stream (mount/nav check)`);
        handleStreamRestart();
      }
    };

    if (autoStart && socketConnected) {
      mountTimer = setTimeout(maybeStart, 500);
    }

    return () => {
      if (mountTimer) clearTimeout(mountTimer);
    };
  }, [
    camera.id,
    camera.name,
    autoStart,
    socketConnected,
    isStreaming,
    connectionState,
    handleStreamRestart,
  ]);

  useEffect(() => {
    if (!autoStart && isStreaming) {
      handleStreamStop();
    }
  }, [autoStart, isStreaming, handleStreamStop]);

  useEffect(() => {
    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      cleanupPeerConnection();
      cleanupMSE();
      cleanupHLS();
      streamActionRef.current = null;
      stopCameraStream(camera.id);
    };
  }, [camera.id, stopCameraStream, cleanupPeerConnection, cleanupMSE, cleanupHLS]);

  useEffect(() => {
    if (!socketConnected && isStreaming && connectionState === 'connected') {
      setConnectionState('reconnecting');
    }
  }, [socketConnected, isStreaming, connectionState]);

  useEffect(() => {
    if (isStreaming && socketConnected) {
      lastFrameTimeRef.current = Date.now();
    }
  }, [isStreaming, socketConnected]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (visibilityDebounceRef.current) {
        clearTimeout(visibilityDebounceRef.current);
      }

      visibilityDebounceRef.current = setTimeout(() => {
        if (!document.hidden && socketConnected && autoStart) {
          if (isWanStream) {
            return;
          }
          const isVideoPlaying =
            videoRef.current && !videoRef.current.paused && videoRef.current.readyState >= 3;
          const isStalled = Date.now() - lastVideoTimeUpdateRef.current > STALL_THRESHOLD_MS;

          if (!isStreaming || connectionState !== 'connected' || !isVideoPlaying || isStalled) {
            camLog(
              `[CameraStream:${camera.name}] Tab became visible and stream needs restart.`,
              {
                isStreaming,
                connectionState,
                isVideoPlaying,
                isStalled,
              },
            );
            handleStreamRestart();
          } else {
            // Just ensure it's playing
            videoRef.current?.play().catch(() => {});
          }
        }
      }, VISIBILITY_DEBOUNCE_MS);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
      if (visibilityDebounceRef.current) {
        clearTimeout(visibilityDebounceRef.current);
      }
    };
  }, [
    socketConnected,
    autoStart,
    isStreaming,
    connectionState,
    handleStreamRestart,
    camera.name,
    isWanStream,
  ]);

  useEffect(() => {
    const handleSocketReconnect = () => {
      const video = videoRef.current;
      const isVideoPlaying = video && !video.paused && video.readyState >= 2;

      if (connectionState === 'reconnecting') {
        if (isWanStream || isVideoPlaying) {
          setConnectionState('connected');
          return;
        }
      }

      if (socketConnected && autoStart && !isStreaming && connectionState === 'idle') {
        handleStreamStart();
      }
    };

    const unsubscribe = socketService.on('connect', handleSocketReconnect);
    return () => unsubscribe();
  }, [socketConnected, autoStart, isStreaming, connectionState, handleStreamStart, isWanStream]);

  useEffect(() => {
    let lastStateUpdate = 0;
    const STATE_UPDATE_INTERVAL = 1000;

    const handleDetection = (data: {
      cameraId: string;
      detections: { class?: string; confidence?: number }[];
      timestamp: string;
      metadata?: { confidence?: number };
    }) => {
      if (data.cameraId !== camera.id) return;

      const detections = data.detections || [];
      if (detections.length > 0) {
        setMotion({
          detected: true,
          confidence: data.metadata?.confidence || 0,
          objectCount: detections.length,
          lastMotionTime: Date.now(),
        });

        if (detectionTimeoutRef.current) {
          clearTimeout(detectionTimeoutRef.current);
        }
        detectionTimeoutRef.current = setTimeout(() => {
          detectionTimeoutRef.current = null;
          setMotion((prev) => ({ ...prev, detected: false }));
        }, 3000);
      }

      const now = Date.now();
      if (now - lastStateUpdate >= STATE_UPDATE_INTERVAL) {
        lastStateUpdate = now;
        frameCountRef.current++;
        const elapsed = now - lastFrameTimeRef.current;
        if (elapsed >= 2000) {
          const fps = Math.round((frameCountRef.current * 1000) / elapsed);
          setMetrics((prev) => ({ ...prev, fps }));
          frameCountRef.current = 0;
          lastFrameTimeRef.current = now;
        }
      }
    };

    const handleError = (data: { cameraId: string; error: string }) => {
      if (data.cameraId === camera.id) {
        setError(getStreamErrorMessage(data.error, 'socket'));
        setConnectionState('error');
        setIsStreaming(false);
      }
    };

    const detectionUnsubscribe = socketService.on('detection', handleDetection);
    const errorUnsubscribe = socketService.on('camera-error', handleError);

    return () => {
      detectionUnsubscribe();
      errorUnsubscribe();
    };
  }, [camera.id, getStreamErrorMessage]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    return () => {
      cleanupPeerConnection();
      cleanupMSE();
      cleanupHLS();
      stopFrameRender();
    };
  }, [cleanupPeerConnection, cleanupMSE, cleanupHLS, stopFrameRender]);

  return {
    videoRef,
    canvasRef,
    isStreaming,
    isWanStream,
    isMuted,
    setIsMuted,
    error,
    connectionState,
    metrics,
    motion,
    showFullOverlay,
    failureCountRef,
    handleStreamStart,
    handleStreamStop,
    handleStreamRestart,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    lastVideoTimeUpdateRef,
  };
};
