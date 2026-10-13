"""MotionGate ROI output — Frigate-style crop-zoom region contract.

The ROI is what YOLO zooms into; a wrong pad, clamp, or union silently
crops the person out of the detection frame. These tests pin the exact
geometry so the crop-zoom contract cannot drift.
"""

import numpy as np
import pytest

from rtsp_ingestion.frame_pipeline import MotionGate


def _blank(size: int = 480) -> np.ndarray:
    return np.zeros((size, size, 3), dtype=np.uint8)


def _frame_with(boxes, size: int = 480) -> np.ndarray:
    f = _blank(size)
    for x, y, w, h in boxes:
        f[y:y + h, x:x + w] = 255
    return f


def _warmup(gate: MotionGate, n: int = 10) -> None:
    for _ in range(n):
        gate.detect(_blank())


def test_warmup_returns_none_roi_even_with_motion():
    gate = MotionGate(camera_id="t")
    res = gate.detect(_frame_with([(100, 100, 50, 50)]))
    assert res["roi"] is None
    assert res["motion_detected"] is False


def test_no_motion_returns_none_roi():
    gate = MotionGate(camera_id="t")
    _warmup(gate)
    res = gate.detect(_blank())
    assert res["motion_detected"] is False
    assert res["roi"] is None


def test_roi_pads_twenty_percent_plus_eight():
    gate = MotionGate(camera_id="t")
    _warmup(gate)
    res = gate.detect(_frame_with([(100, 100, 50, 50)]))
    assert res["roi"] is not None
    # pad = int(0.2 * 50) + 8 = 18 on the 50x50 union box
    assert res["roi"] == [100 - 18, 100 - 18, 50 + 36, 50 + 36]


def test_roi_clamps_to_frame_bounds():
    gate = MotionGate(camera_id="t")
    _warmup(gate)
    res = gate.detect(_frame_with([(0, 0, 30, 30)]))
    assert res["roi"] is not None
    x, y, w, h = res["roi"]
    assert x >= 0 and y >= 0
    assert x + w <= 480 and y + h <= 480


def test_roi_unions_all_motion_blobs():
    gate = MotionGate(camera_id="t")
    _warmup(gate)
    res = gate.detect(_frame_with([(50, 50, 40, 40), (200, 150, 30, 30)]))
    assert res["roi"] is not None
    x, y, w, h = res["roi"]
    # Union spans both blobs: x 50..230, y 50..180 before pad
    assert x <= 50 and (x + w) >= 230
    assert y <= 50 and (y + h) >= 180
