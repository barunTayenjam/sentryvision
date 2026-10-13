"""_letterbox_qat contract: 640x384 canvas, aspect-preserving scale.

The QAT model was trained on letterboxed 640x384 frames. A wrong scale
or pad shifts every box downstream — the decode step inverts these
values, so they must be exact.
"""

import numpy as np
import pytest

from rtsp_ingestion.frame_pipeline import InProcessYOLO


def _lb(detector: InProcessYOLO, frame: np.ndarray):
    return detector._letterbox_qat(frame)


def _make_canvas():
    """The QAT canvas is always 384x640x3 with pad value 114."""
    return np.full((384, 640, 3), 114, dtype=np.uint8)


def test_169_frame_scales_to_full_canvas():
    det = InProcessYOLO.__new__(InProcessYOLO)
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    lb = _lb(det, frame)
    assert lb["canvas"].shape == (384, 640, 3)
    assert lb["r"] == 1.0
    assert lb["dw"] == 0
    assert lb["dh"] == 12  # centered vertically in 384


def test_43_frame_pads_horizontally():
    det = InProcessYOLO.__new__(InProcessYOLO)
    frame = np.zeros((360, 480, 3), dtype=np.uint8)
    lb = _lb(det, frame)
    assert lb["canvas"].shape == (384, 640, 3)
    assert lb["r"] == pytest.approx(1.0666666666666667)
    assert lb["dw"] == 64  # (640 - round(480*1.0667))/2 == (640-512)/2 == 64
    assert lb["dh"] == 0  # height scales exactly


def test_916_frame_pads_vertically():
    det = InProcessYOLO.__new__(InProcessYOLO)
    frame = np.zeros((480, 240, 3), dtype=np.uint8)
    lb = _lb(det, frame)
    assert lb["canvas"].shape == (384, 640, 3)
    assert lb["r"] == 0.8  # min(384/480, 640/240) == 0.8
    assert lb["dw"] == 224  # (640 - round(240*0.8))/2 == (640-192)/2 == 224
    assert lb["dh"] == 0


def test_pad_value_is_constant():
    det = InProcessYOLO.__new__(InProcessYOLO)
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    lb = _lb(det, frame)
    assert int(lb["canvas"][0, 0, 0]) == 114  # constant pad value


def test_resized_content_is_centered():
    det = InProcessYOLO.__new__(InProcessYOLO)
    frame = np.full((100, 100, 3), 7, dtype=np.uint8)
    lb = _lb(det, frame)
    # Content sits at offset (dw, dh) on the 384x640 canvas
    _, dw, dh = lb["r"], lb["dw"], lb["dh"]
    nw, nh = int(round(100 * lb["r"])), int(round(100 * lb["r"]))
    # The exact top-left where content is placed
    assert np.all(lb["canvas"][dh:dh + nh, dw:dw + nw] == 7)


def test_content_surrounded_by_pad():
    det = InProcessYOLO.__new__(InProcessYOLO)
    frame = np.full((100, 100, 3), 7, dtype=np.uint8)
    lb = _lb(det, frame)
    assert np.all(lb["canvas"][0, 0] == 114)  # corner is always pad