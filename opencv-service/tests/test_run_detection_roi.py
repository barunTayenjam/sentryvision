"""_run_detection ROI crop-zoom contract — mock-detector, host-runnable.

The real-net version (test_qat_person_model.py::test_roi_shifts_boxes_to_full_frame)
is skipped on the host because it needs the ONNX model. This pins the same
contract against a mock detector so the wiring — crop, offset shift,
degenerate-ROI handling, and max-width rescale — is verified without it.
"""

import numpy as np
import pytest

from rtsp_ingestion.frame_pipeline import InProcessYOLO, FramePipeline


class _MockYOLO:
    """Records the frame it was given and returns a fixed box in its space."""

    def __init__(self):
        self.seen = None
        self.calls = 0

    def detect(self, frame):
        self.calls += 1
        self.seen = frame
        h, w = frame.shape[:2]
        return [{"bbox": [10, 10, 20, 20], "score": 0.9, "class": "person", "class_id": 0}]


def _pipeline_with(mock):
    p = FramePipeline.__new__(FramePipeline)
    p._yolo_detector = mock
    p._aux_detector = None
    p._yolo_max_input_width = 1280
    return p


def test_roi_crops_and_shifts_box_back():
    mock = _MockYOLO()
    p = _pipeline_with(mock)
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    res = p._run_detection(frame, roi=[100, 50, 200, 150])
    assert mock.calls == 1
    assert mock.seen.shape == (150, 200, 3)  # cropped to ROI
    assert res[0]["bbox"] == [110, 60, 20, 20]  # + off_x, off_y


def test_no_roi_runs_full_frame():
    mock = _MockYOLO()
    p = _pipeline_with(mock)
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    res = p._run_detection(frame)
    assert mock.calls == 1
    assert mock.seen.shape == (360, 640, 3)
    assert res[0]["bbox"] == [10, 10, 20, 20]  # no offset


def test_degenerate_roi_ignored():
    mock = _MockYOLO()
    p = _pipeline_with(mock)
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    # Width 8 < 16 minimum: crop skipped, full frame used
    res = p._run_detection(frame, roi=[0, 0, 8, 360])
    assert mock.calls == 1
    assert mock.seen.shape == (360, 640, 3)
    assert res[0]["bbox"] == [10, 10, 20, 20]


def test_roi_clamped_to_frame_bounds():
    mock = _MockYOLO()
    p = _pipeline_with(mock)
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    # ROI extends past the frame: clamped, offset still correct
    res = p._run_detection(frame, roi=[600, 300, 200, 200])
    assert mock.calls == 1
    assert mock.seen.shape == (60, 40, 3)  # min(rw, 640-600), min(rh, 360-300)
    assert res[0]["bbox"] == [610, 310, 20, 20]


def test_max_width_rescale_inverts_box():
    mock = _MockYOLO()
    p = _pipeline_with(mock)
    p._yolo_max_input_width = 100
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    # 640 > 100 -> downscaled to 100x56, inv scale 6.4 applied to all coords
    res = p._run_detection(frame)
    assert mock.seen.shape == (56, 100, 3)
    assert res[0]["bbox"] == [64, 64, 128, 128]


def test_max_width_rescale_with_roi():
    mock = _MockYOLO()
    p = _pipeline_with(mock)
    p._yolo_max_input_width = 100
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    res = p._run_detection(frame, roi=[100, 50, 200, 150])
    # Crop 200x150 -> downscaled to 100x75, inv scale 2.0, then + offset
    # (10,10,20,20)*2 = (20,20,40,40) + (100,50) = (120,70,40,40)
    assert mock.seen.shape == (75, 100, 3)
    assert res[0]["bbox"] == [120, 70, 40, 40]
class _MockAux:
    """Vehicle/animal aux detector: returns a car in its frame space."""

    def __init__(self):
        self.seen = None

    def detect(self, frame):
        self.seen = frame
        return [{"bbox": [50, 50, 30, 30], "score": 0.8, "class": "car", "class_id": 2}]


def test_aux_detector_merges_vehicle_detections():
    """Dual chain: primary persons + aux vehicles on the same crop."""
    mock, aux = _MockYOLO(), _MockAux()
    p = _pipeline_with(mock)
    p._aux_detector = aux
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    res = p._run_detection(frame, roi=[100, 50, 200, 150])
    assert aux.seen is mock.seen  # same inference frame
    classes = {d["class"] for d in res}
    assert classes == {"person", "car"}
    car = next(d for d in res if d["class"] == "car")
    # (50,50,30,30) + offset (100,50) = (150,100,30,30)
    assert car["bbox"] == [150, 100, 30, 30]


def test_aux_none_keeps_single_model_path():
    mock = _MockYOLO()
    p = _pipeline_with(mock)
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    res = p._run_detection(frame)
    assert all(d["class"] == "person" for d in res)
