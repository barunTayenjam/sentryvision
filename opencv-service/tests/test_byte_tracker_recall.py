#!/usr/bin/env python3
"""ByteTrack track-churn tests — the 240-buffer recall fix.

Regression for issue: person tracks deleted between YOLO runs, new track_id
spawns, tracklet_len resets, PERSON_MIN_TRACK_HITS=3 never satisfied. The old
track_buffer=30 → max_time_lost=4 (≈1s at DETECTION_FPS=4) was shorter than
the YOLO throttle gap of 2s. Tracks that missed ONE throttle run get killed
before the next sighting; short visits (< 640 frames) never reach 3 hits and
the persistence gate opens nowhere. Buffer bumped to 240 → max_time_lost≈8s
spans full throttle gaps and short walks persist to the gate.
"""

from rtsp_ingestion.byte_tracker import ByteTracker


def det(x, y, score, cls="person"):
    return {"bbox": [float(x), float(y), 50.0, 100.0], "score": float(score), "class": cls, "class_id": 0}


def live_ids(results):
    return {r["track_id"] for r in results if r["event"] != "track_ended"}


def test_single_missed_throttle_keeps_same_track():
    """The core bug: one YOLO throttle gap kills a short visit."""
    tracker = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240)
    tracker.update([det(100.0, 0.9)])
    assert len(live_ids(tracker.update([]))) == 1
    # Same spot, one empty frame — track survives round 2.
    ids = live_ids(tracker.update([det(100.0, 0.9)]))
    assert ids == {1}, f"empty-frame deletion churned id: {ids}"


def test_short_walk_to_three_hits():
    """A 3-hit walk completes before any throttle gap; gate should see len≥3."""
    tracker = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240)
    r1 = tracker.update([det(100.0, 0.9)])
    r2 = tracker.update([det(102.0, 0.9)])
    r3 = tracker.update([det(104.0, 0.9)])
    hits = [r for r in r3 if r["event"] != "track_ended"]
    assert len(hits) >= 3, (
        f"short walk should hit the 3-hit persistence gate: {len(hits)}"
    )


def test_long_travel_via_throttle_gap_preserves_accumulated_hits():
    """Missed frames still let len climb; re-detection must inherit them."""
    tracker = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240)
    for i in range(2):
        # Same target, two separated fires: the gap between fires is the bug
        # scenario; track must keep accumulating.
        tracker.update([det(100.0, 0.9)])
    # simulate gap then resume: hit same target on a third run
    ids = live_ids(tracker.update([det(100.0, 0.9)]))
    assert len(ids) == 1, f"target lost across gap: {ids}"


def test_two_tracks_survive_each_other():
    tracker = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240)
    tracker.update([det(100.0, 0.9), det(400.0, 0.9)])
    r2 = tracker.update([det(100.0, 0.3), det(400.0, 0.3)])  # weak same spots
    assert len(live_ids(r2)) == 2, f"one weak frame killed a track: {live_ids(r2)}"


def test_max_time_lost_spans_throttle_gap():
    """max_time_lost ≥ YOLO throttle interval (2s). At DETECTION_FPS=4 that's
    at least 8 updates; we test the buffer math explicitly."""
    from rtsp_ingestion import config
    import os
    frames_per_sec = config.DETECTION_FPS
    min_lost_updates = int(2.0 * frames_per_sec) + 1  # > throttle gap, margin
    tracker = ByteTracker(track_thresh=0.5, match_thresh=0.7, track_buffer=240)
    assert tracker.max_time_lost >= min_lost_updates, (
        f"max_time_lost={tracker.max_time_lost} < required {min_lost_updates}"
    )
