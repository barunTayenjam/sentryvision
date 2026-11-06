import { create } from 'zustand';
import { Camera } from '@/types/security';
import { cameraService } from '@/services/api/cameraService';
import socketService from '@/services/SocketService';

interface CameraState {
  cameras: Camera[];
  loading: boolean;
  error: string | null;
  selectedCameraId: string | null;
  streamingCameras: Set<string>;
  fetchCameras: () => Promise<void>;
  addCamera: (data: Omit<Camera, 'id' | 'status' | 'lastSeen' | 'thumbnail'>) => Promise<string>;
  updateCamera: (id: string, updates: Partial<Camera>) => Promise<void>;
  deleteCamera: (id: string) => Promise<void>;
  selectCamera: (id: string | null) => void;
  getCameraById: (id: string) => Camera | undefined;
  startCameraStream: (id: string) => Promise<void>;
  stopCameraStream: (id: string) => void;
}

export const useCameraStore = create<CameraState>((set, get) => ({
  cameras: [],
  loading: true,
  error: null,
  selectedCameraId: null,
  streamingCameras: new Set(),

  fetchCameras: async () => {
    set({ loading: true, error: null });
    try {
      const cameras = await cameraService.getCameras();
      set({ cameras, loading: false });
    } catch (err) {
      set({ error: 'Failed to load cameras', loading: false });
      console.error('Camera fetch failed:', err);
    }
  },

  addCamera: async (data) => {
    try {
      const cameraId = await cameraService.addCamera(data);
      const newCamera: Camera = {
        id: cameraId,
        ...data,
        status: 'offline',
        lastSeen: new Date(),
        thumbnail: '/placeholder-camera.svg',
      };
      set((state) => ({ cameras: [...state.cameras, newCamera] }));
      return cameraId;
    } catch (err) {
      console.error('Failed to add camera:', err);
      throw err;
    }
  },

  updateCamera: async (id, updates) => {
    const editableKeys = ['name', 'streamUrl', 'fps', 'resolution'];
    try {
      if (Object.keys(updates).some((k) => editableKeys.includes(k))) {
        await cameraService.updateCamera(id, updates);
      }
      set((state) => ({
        cameras: state.cameras.map((c) => (c.id === id ? { ...c, ...updates } : c)),
      }));
    } catch (err) {
      console.error('Failed to update camera:', err);
      throw err;
    }
  },

  deleteCamera: async (id) => {
    try {
      await cameraService.deleteCamera(id);
      set((state) => ({
        cameras: state.cameras.filter((c) => c.id !== id),
        selectedCameraId: state.selectedCameraId === id ? null : state.selectedCameraId,
      }));
    } catch (err) {
      console.error('Failed to delete camera:', err);
      throw err;
    }
  },

  selectCamera: (id) => set({ selectedCameraId: id }),

  getCameraById: (id) => get().cameras.find((c) => c.id === id),

  startCameraStream: async (id) => {
    if (get().streamingCameras.has(id)) return;
    if (!socketService.isConnected()) {
      await socketService.connect();
    }
    // No `frames: true` here: the tile decodes video via WebRTC/MSE/HLS, so
    // relayed JPEG frames would be ~4.5 Mbps of pixels nothing draws.
    socketService.requestStream(id, 'live', { frames: false });
    set((state) => {
      const next = new Set(state.streamingCameras);
      next.add(id);
      return { streamingCameras: next };
    });
    get().updateCamera(id, { status: 'online' });
  },

  stopCameraStream: (id) => {
    socketService.stopStream(id);
    set((state) => {
      const next = new Set(state.streamingCameras);
      next.delete(id);
      return { streamingCameras: next };
    });
  },
}));

// Wire socket events to update camera store
socketService.on('cameraStatus', (data: { cameraId: string; status: 'online' | 'offline' }) => {
  useCameraStore.setState((state) => ({
    cameras: state.cameras.map((c) =>
      c.id === data.cameraId ? { ...c, status: data.status } : c,
    ),
  }));
});

socketService.on('motionDetected', (event: { cameraId: string }) => {
  if (!event.cameraId) return;
  useCameraStore.setState((state) => ({
    cameras: state.cameras.map((c) =>
      c.id === event.cameraId ? { ...c, lastSeen: new Date() } : c,
    ),
  }));
});
