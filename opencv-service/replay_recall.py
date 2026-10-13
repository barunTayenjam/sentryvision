#!/usr/bin/env python3
"""Replay stored event snapshots through the detector at old vs new
thresholds to measure human-recall change.

Pipeline simulates the real detect path: 2304x1296 snapshot -> 640x360 ->
InProcessYOLO -> HumanVerifier on the person ROI.

Usage: python /app/replay_recall.py <n_images> [camera_filter]
"""
import glob
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, "/app")
from rtsp_ingestion.frame_pipeline import InProcessYOLO  # noqa: E402
from person_verifier import HumanVerifier  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 8
CAM = sys.argv[2] if len(sys.argv) > 2 else ""

det = InProcessYOLO("/app/models")
det.initialize()
verifier = HumanVerifier()

old = {"person": 0.55, "side": 35, "area": 1500}


def box_kept(det_thr, min_side, min_area):
    det._class_thresholds["person"] = det_thr
    det._min_box_side = min_side
    det._min_box_area = min_area


files = sorted(
    glob.glob("/app/data/detections/*/events/motion/*.jpg"),
    key=os.path.getmtime,
    reverse=True,
)
if CAM:
    files = [f for f in files if CAM in f]
files = files[:N]

old_hits = new_hits = verified_new = 0
for path in files:
    img = cv2.imread(path)
    if img is None:
        continue
    small = cv2.resize(img, (640, 360), interpolation=cv2.INTER_AREA)
    box_kept(old["person"], old["side"], old["area"])
    old_dets = [d for d in det.detect(small) if d["class"] == "person"]
    box_kept(float(os.getenv("YOLO_PERSON_THRESHOLD", "0.35")), 20, 600)
    new_dets = [d for d in det.detect(small) if d["class"] == "person"]
    old_hits += len(old_dets)
    new_hits += len(new_dets)
    verdicts = []
    for d in new_dets:
        x, y, w, h = d["bbox"]
        roi = small[y:y + h, x:x + w]
        if roi.size > 0:
            v = verifier.verify_detailed(roi, d["score"])
            verdicts.append(f"{v['tier']}:{'pass' if v['verified'] else 'FAIL'}")
            verified_new += v["verified"]
    print(f"{os.path.basename(path)[:40]} old={len(old_dets)} new={len(new_dets)} verdicts={verdicts}")

print(f"images={len(files)} old_person_boxes={old_hits} new_person_boxes={new_hits} verifier_passes={verified_new}")