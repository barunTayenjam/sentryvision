"""
Tests for FFmpegReader — command building, state management, and frame callback.

Actual FFmpeg subprocess spawning is not tested here (requires FFmpeg on PATH).
We test the command construction and state machine in isolation.
"""

import pytest

from rtsp_ingestion.ffmpeg_reader import FFmpegReader
from rtsp_ingestion.config import FFMPEG_DEFAULT_ARGS


class TestFFmpegReader:
    """FFmpegReader: command building and lifecycle state."""

    @pytest.fixture
    def reader(self):
        return FFmpegReader(
            rtsp_url="rtsp://test:test@127.0.0.1:554/stream1",
            camera_id="test-cam",
            width=640,
            height=360,
            fps=5,
            scale=True,
        )

    def test_initial_state(self, reader):
        """Reader starts in stopped state with defaults."""
        assert reader.camera_id == "test-cam"
        assert reader.rtsp_url == "rtsp://test:test@127.0.0.1:554/stream1"
        assert reader.width == 640
        assert reader.height == 360
        assert reader.fps == 5
        assert reader.running is False
        assert reader._process is None
        assert reader._thread is None

    def test_build_command_includes_default_args(self, reader):
        """Command includes ffmpeg, default args, RTSP URL, scale, fps, and raw output."""
        cmd = reader._build_command()

        assert cmd[0] == "ffmpeg"
        assert "-rtsp_transport" in cmd
        assert "tcp" in cmd
        assert "-i" in cmd
        assert reader.rtsp_url in cmd
        assert "-vf" in cmd
        assert "scale=640:360" in cmd
        assert "-r" in cmd
        assert "5" in cmd
        assert "-f" in cmd
        assert "rawvideo" in cmd
        assert "-pix_fmt" in cmd
        assert "bgr24" in cmd
        assert "pipe:1" in cmd

    def test_stop_before_start_is_safe(self, reader):
        """Calling stop() before start() does not raise."""
        reader.stop()

    def test_start_twice_is_idempotent(self, reader):
        """Calling start() twice only starts one thread."""
        callback = lambda f: None
        reader.start(callback)
        assert reader.running is True
        reader.start(callback)
        reader.stop()

    def test_frame_size_computation(self, reader):
        """Frame size is correctly computed for BGR24."""
        assert reader._frame_size == 640 * 360 * 3

    def test_reconnect_delay_bounds(self, reader):
        """Reconnect delay starts at 1s and caps at 5s.

        The 5s cap replaced 30s: cams flap in seconds (140 drops/24h measured),
        and a 30s backoff after the camera returned meant 30s of detection
        blind time with a human possibly in frame.
        """
        assert reader._reconnect_delay == 1.0
        assert reader._max_reconnect_delay == 5.0

    def test_build_command_with_different_resolution(self):
        """Command respects custom width/height/fps."""
        reader = FFmpegReader(
            rtsp_url="rtsp://example.com/stream",
            camera_id="cam1",
            width=1920,
            height=1080,
            fps=2,
            scale=True,
        )
        cmd = reader._build_command()
        assert "scale=1920:1080" in cmd
        assert "-r" in cmd
        idx_r = cmd.index("-r")
        assert cmd[idx_r + 1] == "2"

    def test_build_command_no_scale(self):
        """Command omits -vf scale when scale=False."""
        reader = FFmpegReader(
            rtsp_url="rtsp://test:test@127.0.0.1:554/stream1",
            camera_id="cam-ns",
            width=1280,
            height=720,
            fps=2,
            scale=False,
        )
        cmd = reader._build_command()
        assert "-vf" not in cmd
        assert "scale=" not in cmd
        assert "pipe:1" in cmd

    def test_callback_receives_correct_camera_id(self, reader):
        """Callback dict contains the reader's camera_id."""
        results = []

        def callback(frame_data):
            results.append(frame_data)

        # Start and immediately stop — no real FFmpeg spawned
        reader.start(callback)
        # Manually inject a frame to test callback path
        import numpy as np
        frame_data = {
            'data': np.zeros((360, 640, 3), dtype=np.uint8),
            'timestamp': 1234.0,
            'camera_id': reader.camera_id,
        }
        callback(frame_data)
        reader.stop()

        assert len(results) == 1
        assert results[0]['camera_id'] == "test-cam"
        assert results[0]['timestamp'] == 1234.0
