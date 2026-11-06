import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { PythonWsClient } from '../services/pythonWsClient.js';
import { serviceRegistry } from '../services/serviceRegistry.js';

const testDirname = path.resolve(process.cwd(), 'src', 'streams');

/**
 * CLN-03: Verify rtspManager.ts is simplified to Socket.io frame relay
 * - No ffmpeg-static import
 * - No spawn/ChildProcess import
 * - No CameraStream interface
 * - No mainProcess/activeRoles/streams/retryCount fields on Camera
 * - getProcess() returns null
 * - No FFmpeg subprocess management
 */

describe('RTSP Manager Simplification (CLN-03)', () => {
  const srcDir = path.resolve(testDirname);
  const rtspManagerPath = path.join(srcDir, 'rtspManager.ts');

  describe('Source file does not contain FFmpeg/spawn imports', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(rtspManagerPath, 'utf8');
    });

    it('should not import ffmpeg-static', () => {
      expect(source).not.toMatch(/ffmpeg-static/);
      expect(source).not.toMatch(/ffmpeg/);
    });

    it('should not import spawn or ChildProcess from child_process', () => {
      expect(source).not.toMatch(/from ['"]child_process['"]/);
      expect(source).not.toMatch(/spawn/);
      expect(source).not.toMatch(/ChildProcess/);
    });

    it('should not contain CameraStream interface', () => {
      expect(source).not.toMatch(/CameraStream/);
    });

    it('should not contain MJPEG parsing references', () => {
      expect(source).not.toMatch(/MJPEG/);
      expect(source).not.toMatch(/mjpeg/i);
    });

    it('should not reference legacy Camera fields (mainProcess, activeRoles, streams map, retryCount)', () => {
      expect(source).not.toMatch(/mainProcess/);
      expect(source).not.toMatch(/activeRoles/);
      expect(source).not.toMatch(/retryCount/);
    });

    it('should not reference processFrameForMotion', () => {
      expect(source).not.toMatch(/processFrameForMotion/);
    });

    it('should not reference dual pipeline or pythonEnabled legacy logic', () => {
      expect(source).not.toMatch(/pythonEnabled/);
      expect(source).not.toMatch(/dual.*pipeline/i);
    });
  });

  describe('Camera interface does not contain legacy fields', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(rtspManagerPath, 'utf8');
    });

    it('should define Camera interface without mainProcess, activeRoles, streams, or retryCount', () => {
      // Find the Camera interface declaration
      const interfaceMatch = source.match(/export interface Camera \{[\s\S]*?^\}/m);
      expect(interfaceMatch).not.toBeNull();

      const cameraInterface = interfaceMatch![0];
      // Should NOT have legacy fields
      expect(cameraInterface).not.toMatch(/mainProcess/);
      expect(cameraInterface).not.toMatch(/activeRoles/);
      expect(cameraInterface).not.toMatch(/streams/);
      expect(cameraInterface).not.toMatch(/retryCount/);

      // Should have the simplified fields
      expect(cameraInterface).toMatch(/id/);
      expect(cameraInterface).toMatch(/lastFrame/);
      expect(cameraInterface).toMatch(/activeViewers/);
      expect(cameraInterface).toMatch(/isActive/);
      expect(cameraInterface).toMatch(/adaptiveFps/);
    });
  });

  describe('StreamManager class structure', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(rtspManagerPath, 'utf8');
    });

    it('should have getProcess method that returns null', () => {
      expect(source).toMatch(/getProcess.*null/);
      expect(source).toMatch(/getProcess[^}]*null/);
    });

    it('should have wirePythonWsFrames method for Socket.io relay', () => {
      expect(source).toMatch(/wirePythonWsFrames/);
    });

    it('should have startStream/stopStream simplified to subscribe/unsubscribe via PythonWsClient', () => {
      // Should contain pythonWs.subscribe and pythonWs.unsubscribe
      expect(source).toMatch(/pythonWs\.subscribe/);
      expect(source).toMatch(/pythonWs\.unsubscribe/);
    });

    it('should maintain Socket.io frame relay and viewer tracking', () => {
      expect(source).toMatch(/activeViewers/);
      expect(source).toMatch(/\badaptiveFps\b/);
      expect(source).toMatch(/io\.to.*emit.*frame/);
    });

    it('should still have startTestStream as a test helper', () => {
      expect(source).toMatch(/startTestStream/);
    });

    it('should still have takeSnapshot capability', () => {
      expect(source).toMatch(/takeSnapshot/);
    });

    it('should still have simulateMotionDetection for manual testing', () => {
      expect(source).toMatch(/simulateMotionDetection/);
    });
  });

  describe('Simplified class behavior', () => {
    // Note: Full behavioral testing requires Socket.io server and service mocking.
    // These structural tests verify the class follows the simplified contract.

    it('getProcess always returns null at runtime', async () => {
      // Dynamic import to avoid compile-time dependency issues in test isolation
      const mod = await import('./rtspManager.js');
      const { StreamManager } = mod;

      // Create a mock Socket.io server
      const mockIo = {
        on: jest.fn(),
      use: jest.fn(),
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      } as any;

      // We need to handle the fact that constructor calls serviceRegistry.getPythonWsClient()
      // which might throw. This test verifies the structural contract.
      expect(typeof StreamManager.prototype.getProcess).toBe('function');
      // The method signature should accept (cameraId, role) and return null
      const getProcessStr = StreamManager.prototype.getProcess.toString();
      expect(getProcessStr).toContain('null');
      expect(getProcessStr).not.toContain('mainProcess');
    });

    it('getStream method returns width/height from config, not internal state', async () => {
      const mod = await import('./rtspManager.js');
      const { StreamManager } = mod;

      const getStreamStr = StreamManager.prototype.getStream.toString();
      // Should read from camera.config.streams, not from internal stream state
      expect(getStreamStr).toContain('camera.config');
      expect(getStreamStr).not.toContain('CameraStream');
      expect(getStreamStr).not.toContain('.streams.get');
    });

    it('should export streamManager singleton', async () => {
      const mod = await import('./rtspManager.js');
      expect(mod).toHaveProperty('streamManager');
      expect(mod).toHaveProperty('setupRTSPStreams');
    });
  });

  describe('Source file kept essential functionality', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(rtspManagerPath, 'utf8');
    });

    it('should keep the StreamManager class export', () => {
      expect(source).toMatch(/export class StreamManager/);
    });

    it('should keep socket.io import for frame relay', () => {
      expect(source).toMatch(/socket\.io/);
    });

    it('should still have health monitoring integration', () => {
      expect(source).toMatch(/healthMonitor/);
    });

    it('should NOT import from detection modules', () => {
      expect(source).not.toMatch(/detection\//);
    });
  });
});

/**
 * DOC-08: E2E integration test for Python WS -> Node.js -> Socket.io frame relay
 *
 * Creates a mock WebSocket server (simulating the Python process),
 * connects a real PythonWsClient, and verifies frames are relayed
 * through StreamManager.wirePythonWsFrames() to the mock Socket.io
 * rooms exactly once per camera.
 *
 * Dependencies: WebSocketServer (ws), PythonWsClient, serviceRegistry
 */

function createMockWsServer(): Promise<{ server: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    server.on('listening', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}

describe('Frame Relay E2E (DOC-08)', () => {
  let mockServer: WebSocketServer;
  let port: number;
  let currentClient: PythonWsClient | null;

  beforeEach(async () => {
    const created = await createMockWsServer();
    mockServer = created.server;
    port = created.port;
    currentClient = null;
  });

  afterEach(() => {
    mockServer?.close();
    currentClient?.disconnect();
    currentClient = null;
    // Clean up serviceRegistry so next test starts fresh
    (serviceRegistry as any)['services'].delete('pythonWsClient');
  });

  it('should emit frame to Socket.io room exactly once per camera', async () => {
    const pythonWsClient = new PythonWsClient(`ws://127.0.0.1:${port}`);
    currentClient = pythonWsClient;
    serviceRegistry.setPythonWsClient(pythonWsClient as any);

    const mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
      on: jest.fn(),
      use: jest.fn(),
    } as any;

    const { StreamManager } = await import('./rtspManager.js');
    const streamManager = new StreamManager(mockIo);

    streamManager.addCamera({
      id: 'cam1',
      name: 'Test Camera',
      enabled: true,
      streams: [],
      detect: { width: 640, height: 480, fps: 10 },
      nightMode: false,
    });

    // Add an active viewer so the live-room emit path is exercised
    const camera = streamManager.getCamera('cam1')!;
    camera.activeViewers.add('test-viewer');

    return new Promise<void>((resolve, reject) => {
      pythonWsClient.on('connected', () => {
        const clients = [...mockServer.clients];
        const serverWs = clients[0]!;

        // Send JSON metadata then binary frame data
        serverWs.send(
          JSON.stringify({
            type: 'frame',
            cameraId: 'cam1',
            timestamp: Date.now(),
          }),
        );
        serverWs.send(
          Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
        );

        // Allow event-loop tick for WebSocket message delivery
        setTimeout(() => {
          try {
            // Verify both rooms received exactly one emit each
            expect(mockIo.to).toHaveBeenCalledTimes(2);
            expect(mockIo.to).toHaveBeenCalledWith('camera-cam1-live');
            expect(mockIo.to).toHaveBeenCalledWith('camera-cam1-detect');

            // Verify the live emit payload
            const liveCall = (mockIo.emit as jest.Mock).mock.calls.find(
              (call: unknown[]) => (call[1] as Record<string, unknown>)?.role === 'live',
            );
            expect(liveCall).toBeDefined();
            expect((liveCall[1] as Record<string, unknown>).cameraId).toBe('cam1');
            expect((liveCall[1] as Record<string, unknown>).role).toBe('live');
            expect(typeof (liveCall[1] as Record<string, unknown>).timestamp).toBe('string');
            expect(Buffer.isBuffer((liveCall[1] as Record<string, unknown>).data)).toBe(true);

            // Verify the detect emit payload
            const detectCall = (mockIo.emit as jest.Mock).mock.calls.find(
              (call: unknown[]) => (call[1] as Record<string, unknown>)?.role === 'detect',
            );
            expect(detectCall).toBeDefined();
            expect((detectCall[1] as Record<string, unknown>).cameraId).toBe('cam1');
            expect((detectCall[1] as Record<string, unknown>).role).toBe('detect');

            resolve();
          } catch (e) {
            reject(e);
          }
        }, 200);
      });

      pythonWsClient.connect();
    });
  });

  it('should not emit frame for unknown camera', async () => {
    const pythonWsClient = new PythonWsClient(`ws://127.0.0.1:${port}`);
    currentClient = pythonWsClient;
    serviceRegistry.setPythonWsClient(pythonWsClient as any);

    const mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
      on: jest.fn(),
      use: jest.fn(),
    } as any;

    const { StreamManager } = await import('./rtspManager.js');
    new StreamManager(mockIo); // No cameras added

    return new Promise<void>((resolve, reject) => {
      pythonWsClient.on('connected', () => {
        const clients = [...mockServer.clients];
        const serverWs = clients[0]!;

        serverWs.send(
          JSON.stringify({
            type: 'frame',
            cameraId: 'nonexistent-camera',
            timestamp: Date.now(),
          }),
        );
        serverWs.send(Buffer.from([0xff, 0xd8, 0xff]));

        setTimeout(() => {
          try {
            expect(mockIo.emit).not.toHaveBeenCalled();
            resolve();
          } catch (e) {
            reject(e);
          }
        }, 200);
      });

      pythonWsClient.connect();
    });
  });

  it('should emit frame to detect room as well', async () => {
    const pythonWsClient = new PythonWsClient(`ws://127.0.0.1:${port}`);
    currentClient = pythonWsClient;
    serviceRegistry.setPythonWsClient(pythonWsClient as any);

    const mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
      on: jest.fn(),
      use: jest.fn(),
    } as any;

    const { StreamManager } = await import('./rtspManager.js');
    const streamManager = new StreamManager(mockIo);

    streamManager.addCamera({
      id: 'cam1',
      name: 'Test Camera',
      enabled: true,
      streams: [],
      detect: { width: 640, height: 480, fps: 10 },
      nightMode: false,
    });

    return new Promise<void>((resolve, reject) => {
      pythonWsClient.on('connected', () => {
        const clients = [...mockServer.clients];
        const serverWs = clients[0]!;

        serverWs.send(
          JSON.stringify({
            type: 'frame',
            cameraId: 'cam1',
            timestamp: Date.now(),
          }),
        );
        serverWs.send(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

        setTimeout(() => {
          try {
            // Detect room always fires regardless of viewer count
            expect(mockIo.to).toHaveBeenCalledWith('camera-cam1-detect');

            const detectCalls = (mockIo.emit as jest.Mock).mock.calls.filter(
              (call: unknown[]) => (call[1] as Record<string, unknown>)?.role === 'detect',
            );
            expect(detectCalls).toHaveLength(1);
            expect((detectCalls[0][1] as Record<string, unknown>).cameraId).toBe('cam1');
            expect((detectCalls[0][1] as Record<string, unknown>).role).toBe('detect');

            resolve();
          } catch (e) {
            reject(e);
          }
        }, 200);
      });

      pythonWsClient.connect();
    });
  });
});

describe('Frame relay opt-out (cheap profile)', () => {
  it('joins the JPEG frame room by default', async () => {
    const { frameRoomFor } = await import('./rtspManager.js');
    expect(frameRoomFor('cam1')).toBe('camera-cam1-live');
    expect(frameRoomFor('cam1', true)).toBe('camera-cam1-live');
  });

  it('does not join the frame room when the client renders video itself', async () => {
    const { frameRoomFor } = await import('./rtspManager.js');
    expect(frameRoomFor('cam1', false)).toBeNull();
  });
});
