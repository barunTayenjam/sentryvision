"""Detector backend selection: ORT (onnxruntime) vs DNN (cv2.dnn).

Backends are pure execution engines: same blob in, same head outputs out.
Selection must be config-driven (DETECTOR_BACKEND env) so swapping models
is a config change, not a code change. QAT_ORT remains as legacy alias.

cv2 is mocked so this suite runs on the host; real-model tests live in
the container (see test_qat_ort_execution.py convention).
"""

import os
import sys
from typing import List

import numpy as np
import pytest

sys.path.insert(0, "/app")

# cv2 is optional here — resolve_backend_engine() must not import cv2
# at module scope so ORT-only selection works without OpenCV DNN.
from model_selection import resolve_backend_engine  # noqa: E402


class TestResolveBackendEngine:
    """DETECTOR_BACKEND env resolves to engine, independent of model type."""

    def test_ort_forced(self):
        assert resolve_backend_engine("ort") == "ort"

    def test_dnn_forced(self):
        assert resolve_backend_engine("dnn") == "dnn"

    def test_auto_qat_with_qat_ort_enabled(self):
        assert resolve_backend_engine("auto", model_type="yolov8-qat", qat_ort="1") == "ort"

    def test_auto_qat_without_qat_ort(self):
        assert resolve_backend_engine("auto", model_type="yolov8-qat", qat_ort="0") == "dnn"

    def test_auto_non_qat_defaults_dnn(self):
        assert resolve_backend_engine("auto", model_type="yolov8", qat_ort="1") == "dnn"

    def test_auto_non_qat_with_ort_env(self):
        """DETECTOR_BACKEND=ort forces ORT for any model type."""
        assert resolve_backend_engine("ort", model_type="yolov8", qat_ort="0") == "ort"

    def test_invalid_env_falls_back_auto(self):
        assert resolve_backend_engine("gpu") == "dnn"

    def test_none_env_is_auto(self):
        assert resolve_backend_engine(None) == "dnn"

    def test_auto_qat_ort_one_is_ort(self):
        assert resolve_backend_engine("auto", model_type="yolov8-qat", qat_ort="1") == "ort"


class TestOrtRunnerUniversal:
    """OrtRunner works for any ONNX model, not just QAT.

    Container-only: OrtRunner lives in frame_pipeline which imports cv2.
    """

    def test_loads_coco_onnx_if_exists(self):
        pytest.skip("container-only: needs cv2 + models")

    def test_missing_model_returns_none(self):
        pytest.skip("container-only: needs cv2 + models")
