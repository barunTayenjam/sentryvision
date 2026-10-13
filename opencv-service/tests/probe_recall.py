#!/usr/bin/env python3
"""Live recall probe: low-threshold YOLO on go2rtc frames, both cameras.

Prints timestamped person detections with scores (pipeline cutoff = 0.55)
and saves the 640x360 frame when any person is seen, so a missed walk-by
can be diffed against pipeline logs and the events DB.

Usage: python /app/probe_recall.py <seconds> [cam1 cam2 ...]
"""
import os
import sys
import time
import urllib.request

import cv2
import numpy as np

sys.path.insert(0, "/app")
from rtsp_ingestion.frame_pipeline import InProcessYOLO  # noqa: E402

SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 90
CAMS = sys.argv[2:] or ["cam1", "cam2"]
OUT = "/app/data/detections/probe"
os.makedirs(OUT, exist_ok=True)

det = InProcessYOLO("/app/models")
det.initialize()
det._class_thresholds["person"] = 0.10
det._min_box_area = 1
det._min_box_side = 1

t_end = time.time() + SECONDS
i = 0
while time.time() < t_end:
    i += 1
    for cam in CAMS:
        url = f"http://go2rtc:1984/api/frame.jpeg?src={cam}"
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                buf = np.frombuffer(r.read(), np.uint8)
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')} {cam} fetch-error {e}", flush=True)
            continue
        full = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        frame = cv2.resize(full, (640, 360), interpolation=cv2.INTER_AREA)
        mean = float(np.mean(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)))
        for d in det.detect(frame):
            if d["class"] != "person":
                continue
            x, y, w, h = d["bbox"]
            area = w * h
            kept = d["score"] >= 0.55 and area >= 1500 and w >= 35 and h >= 35
            print(
                f"{time.strftime('%H:%M:%S')} {cam} PERSON score={d['score']:.2f} "
                f"bbox={d['bbox']} area={area} frame_mean={mean:.0f} "
                f"pipeline_would_keep={kept}",
                flush=True,
            )
            tagged = frame.copy()
            cv2.rectangle(tagged, (x, y), (x + w, y + h), (0, 255, 0), 2)
            cv2.imwrite(f"{OUT}/{cam}_{i:04d}_{int(d['score']*100):03d}.jpg", tagged)
    time.sleep(2)
print("probe done", flush=True)
