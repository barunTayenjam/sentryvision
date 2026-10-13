#!/usr/bin/env python3
"""Motion-class tracks must carry a snapshot path.

Regression: the person-verification snapshot gate (and the vehicle gate that
mirrored it) left every other tracked class without a snapshot. Those tracks
persist in Node as `motion` events with file_path NULL, and the events page
rendered "No image" for them. This pins the motion snapshot gate:
once per track, hit+confidence gated, person excluded.
"""

import numpy as np
import pytest

from rtsp_ingestion.frame_pipeline import FramePipeline

SNAP_PATH = "/app/data/detections/2026-10/events/motion/motion_cam1_x.jpg"


def make_pipeline(min_hits=3, min_conf=0.45):
    """Build a FramePipeline via __new__ — only the state _enrich_with_identity touches."""
    p = FramePipeline.__new__(FramePipeline)
    p._camera_id = "cam1"
    p._identity_cache = type("C", (), {"get": lambda self, t: None})()
    p._frame_counter = 0
    p._snapshotted_tracks = set()
    p._snapshot_paths = {}
    p._snapshot_dims = {}
    p._verify_cache = {}
    p._person_attrs_cache = {}
    p._recheck_cache = {}
    p._person_min_hits, p._person_min_conf = 3, 0.55
    p._vehicle_min_hits, p._vehicle_min_conf = 3, 0.45
    p._motion_min_hits, p._motion_min_conf = min_hits, min_conf
    p._person_attrs_ttl = 5.0
    p._person_analyzer = None
    p._face_recognition_fn = None
    p._saved = []
    p._save_snapshot = lambda tid, frame, fullres_frame=None: (
        p._saved.append(tid) or SNAP_PATH
    )
    return p


def dog_track(track_id=5, event="track_updated", tracklet_len=4, score=0.7):
    return {
        "event": event,
        "class": "dog",
        "track_id": track_id,
        "bbox": [10, 10, 50, 60],
        "score": score,
        "tracklet_len": tracklet_len,
    }


@pytest.fixture
def frame():
    return np.zeros((360, 640, 3), dtype=np.uint8)


def test_dog_track_gets_snapshot(frame):
    p = make_pipeline()
    out = p._enrich_with_identity([dog_track()], frame)
    assert out[0]["file_path"] == SNAP_PATH
    assert p._saved == [5]


def test_dog_track_below_hits_gate_no_snapshot(frame):
    p = make_pipeline(min_hits=3)
    out = p._enrich_with_identity([dog_track(tracklet_len=1)], frame)
    assert "file_path" not in out[0]
    assert p._saved == []


def test_dog_track_below_conf_gate_no_snapshot(frame):
    p = make_pipeline(min_conf=0.45)
    out = p._enrich_with_identity([dog_track(score=0.30)], frame)
    assert "file_path" not in out[0]
    assert p._saved == []


def test_snapshot_once_per_track(frame):
    p = make_pipeline()
    p._enrich_with_identity([dog_track()], frame)
    p._enrich_with_identity([dog_track()], frame)
    assert p._saved == [5]  # second event reuses the cached path


def test_person_not_snapshotted_by_motion_branch(frame, monkeypatch):
    """Person gating belongs to the verification gate — motion branch must skip persons."""
    p = make_pipeline()
    # Bypass the real HumanVerifier (MediaPipe, expensive); the assertion is
    # that the motion snapshot branch never fires for class=="person".
    monkeypatch.setattr(
        FramePipeline, "_get_human_verifier",
        lambda cls: type("V", (), {"verify_detailed": lambda self, roi, yolo_score: {"verified": False, "tier": "n/a", "yolo_score": 0, "keypoints": 0}})(),
    )
    out = p._enrich_with_identity(
        [{"event": "track_updated", "class": "person", "track_id": 9,
          "bbox": [10, 10, 60, 120], "score": 0.9, "tracklet_len": 4}], frame
    )
    # Verification failed → track dropped entirely (no snapshot, no event).
    assert out == []
    assert p._saved == []


def test_vehicle_still_snapshotted(frame):
    p = make_pipeline()
    out = p._enrich_with_identity(
        [{"event": "track_updated", "class": "car", "track_id": 7,
          "bbox": [10, 10, 80, 50], "score": 0.8, "tracklet_len": 4}], frame
    )
    assert out[0]["file_path"] == SNAP_PATH
    assert p._saved == [7]
