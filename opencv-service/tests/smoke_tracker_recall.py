#!/usr/bin/env python3
"""Inline smoke-check for the track_buffer=240 recall fix (no pytest)."""
import sys

sys.path.insert(0, "/app")
from rtsp_ingestion.byte_tracker import ByteTracker


def det(x, score, cls="person"):
    return {"bbox": [float(x), 0.0, 50.0, 100.0], "score": float(score), "class": cls, "class_id": 0}


def live_ids(results):
    return {r["track_id"] for r in results if r["event"] != "track_ended"}


# Bug scenario: person seen once, YOLO throttled (empty run), re-seen.
t = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240)
t.update([det(100.0, 0.9)])
t.update([])  # empty run between throttle windows
ids = live_ids(t.update([det(100.0, 0.9)]))
assert ids == {1}, f"track churned across one gap: {ids}"
print("PASS: same track_id across one empty run")

# 3-hit short walk.
t2 = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240)
t2.update([det(100.0, 0.9)])
t2.update([det(102.0, 0.9)])
r3 = t2.update([det(104.0, 0.9)])
hits = [r for r in r3 if r["event"] != "track_ended"]
assert hits and hits[0]["tracklet_len"] >= 3, f"hits: {hits}"
print(f"PASS: tracklet_len={hits[0]['tracklet_len']} >= 3 after short walk")

# max_time_lost spans the 2s throttle gap at 4 fps.
t3 = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240, frame_rate=4)
assert t3.max_time_lost >= 8, f"max_time_lost={t3.max_time_lost}"
print(f"PASS: max_time_lost={t3.max_time_lost} >= 8 updates (2s @ 4fps)")
print("ALL PASS")
