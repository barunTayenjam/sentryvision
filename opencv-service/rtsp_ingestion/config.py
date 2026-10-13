#!/usr/bin/env python3
"""
RTSP Ingestion Configuration Constants
All config values as module-level constants (not inside a class).
"""

import os

# Default queue sizes
LIVE_QUEUE_MAXSIZE = 2
MOTION_QUEUE_MAXSIZE = 5
DETECTION_QUEUE_MAXSIZE = 10

# WebSocket
WS_HOST = os.getenv('WS_HOST', '0.0.0.0')
WS_PORT = int(os.getenv('WS_PORT', '9090'))

# Default camera settings
DEFAULT_WIDTH = 480
DEFAULT_HEIGHT = 480
DEFAULT_FPS = 5
DETECTION_FPS = 4

# MOG2 motion detection
MOG2_HISTORY = 200
MOG2_VAR_THRESHOLD = 16
# Recall-oriented: slow walkers register <150px on 640x360; the verifier
# (face/pose/score_floor) plus the 3-hit persistence gate re-filter ghosts.
MOTION_PIXEL_THRESHOLD = int(os.getenv("MOG2_PIXEL_THRESHOLD", "80"))

# JPEG encoding (live preview — small frames, higher quality keeps motion smooth)
JPEG_QUALITY = 75
JPEG_OPTIMIZE = 1

# FFmpeg default arguments for RTSP ingestion
# Simplified FFmpeg args for RTSP ingestion – reduces flags that caused permission issues
FFMPEG_DEFAULT_ARGS = [
    '-rtsp_transport', 'tcp',
    '-timeout', '5000000',
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32768',
    '-analyzeduration', '0',
    '-max_delay', '0',
]

LIVE_WIDTH = 640
LIVE_HEIGHT = 360
DETECT_WIDTH = 480
DETECT_HEIGHT = 480

# Event snapshot JPEG quality (2K evidence files — higher than live preview)
EVENT_JPEG_QUALITY = 85

# go2rtc RTSP proxy base URL
# Python reads from go2rtc instead of directly from cameras to respect
# the camera's single-RTSP-connection limit (TP-LINK). go2rtc already
# holds the one allowed connection and re-streams it internally.
GO2RTC_RTSP_BASE = "rtsp://go2rtc:8554"
# HTTP API base — used for one-shot snapshot pulls (/api/frame.jpeg).
# Serves the current frame from go2rtc's internal buffer: no ffprobe,
# no subprocess, no RTSP reconnect per event.
GO2RTC_HTTP_BASE = os.getenv("GO2RTC_HTTP_BASE", "http://go2rtc:1984")

# Metrics latency buckets (milliseconds)
METRICS_WS_LATENCY_BUCKETS = [10, 25, 50, 100, 200, 500]

# Inference backend selection: 'auto' (detect CUDA), 'cuda', 'cpu'
INFERENCE_BACKEND = os.getenv('INFERENCE_BACKEND', 'auto')
INFERENCE_TARGET = os.getenv('INFERENCE_TARGET', 'auto')
