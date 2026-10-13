"""Small-box upscaled recheck kills person-hallucinations (e.g. a 68x50 dog
that YOLO scores 0.77 as person) while every real human survives the same
treatment.

This is the guard that stopped the 13:06 false "person" event (black dog,
score 0.77) from being published as a human.
"""

import os

import pytest
import numpy as np
import cv2

from rtsp_ingestion.frame_pipeline import FramePipeline, InProcessYOLO

# Container-only: needs the real YOLO weights baked into the image. The host
# Python (3.14) has no cv2/models either, so these tests cannot run there.
pytestmark = pytest.mark.skipif(
    not os.path.exists("/app/models/crowdhuman_qat_640x384.onnx"),
    reason="container-only: needs /app/models",
)


def _detector():
    det = InProcessYOLO("/app/models")
    ok = det.initialize()
    assert ok, "no YOLO model loaded"
    return det


def _make_dummy(detector):
    obj = object.__new__(FramePipeline)
    obj._yolo_detector = detector
    return obj


class TestSmallBoxRecheck:
    def test_dog_small_box_is_rejected(self):
        """A 68x50 dog box: upscaled crop yields no person -> recheck False."""
        detector = _detector()
        d = _make_dummy(detector)
        roi = cv2.imread(
            "/app/data/detections/2026-10/events/motion/motion_cam1_2026-10-09T07-36-58-305Z_t55.jpg"
        )[357:540, 1119:1363]
        roi = cv2.resize(roi, (64, 50), interpolation=cv2.INTER_AREA)
        assert d._confirm_small_person(roi) is False, "dog must fail recheck"

    def test_real_humans_survive_recheck(self):
        """4 confirmed humans, upscaled: all still detected as person."""
        detector = _detector()
        d = _make_dummy(detector)

        for tag, fn, box in [
            ("t86-0.87", "/app/data/detections/2026-10/events/motion/motion_cam2_2026-10-09T07-45-21-169Z_t86.jpg", [236, 92, 128, 258]),
            ("t89-0.92", "/app/data/detections/2026-10/events/motion/motion_cam2_2026-10-09T07-46-17-199Z_t89.jpg", [95, 189, 146, 170]),
            ("t33-0.80", "/app/data/detections/2026-10/events/motion/motion_cam2_2026-10-09T07-32-29-406Z_t33.jpg", [151, 97, 159, 261]),
            ("t63-0.69", "/app/data/detections/2026-10/events/motion/motion_cam1_2026-10-09T07-38-44-262Z_t63.jpg", [157, 156, 84, 133]),
        ]:
            full = cv2.imread(fn)
            sx = 2304 / 640
            x, y, w, h = [int(v * sx) for v in box]
            roi = full[max(0, y - h // 3) : y + h + h // 3, max(0, x - w // 3) : x + w + w // 3]
            assert d._confirm_small_person(roi) is True, f"{tag} must pass recheck"
