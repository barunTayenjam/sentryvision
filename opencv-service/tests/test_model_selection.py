#!/usr/bin/env python3
"""Detection model selection. Pure: no cv2, no model loading, no I/O."""

import pytest

from model_selection import AVAILABLE_MODELS, resolve_model_priority


class TestDefaultPreference:
    def test_nano_is_chosen_by_default(self):
        """Unchanged default: fastest model, lowest latency."""
        order = resolve_model_priority(None, gpu_available=False, free_memory_gb=8)

        assert order[0][0] == "yolov8n.onnx"

    def test_gpu_gets_the_wider_fallback_chain(self):
        order = resolve_model_priority(None, gpu_available=True, free_memory_gb=8)

        assert [name for name, _ in order][:2] == ["yolov8n.onnx", "yolov8s.onnx"]

    def test_low_memory_avoids_the_large_models(self):
        order = resolve_model_priority(None, gpu_available=False, free_memory_gb=1)

        names = [name for name, _ in order]
        assert "yolov8m.onnx" not in names


class TestExplicitPreference:
    def test_medium_can_be_requested(self):
        order = resolve_model_priority("yolov8m", gpu_available=False, free_memory_gb=8)

        assert order[0][0] == "yolov8m.onnx"

    def test_a_requested_model_is_offered_a_working_fallback(self):
        """If the preferred file is missing or unloadable, the chain must still
        reach a model that works — a preference is not a hard requirement."""
        order = resolve_model_priority("yolov8m", gpu_available=False, free_memory_gb=8)

        assert len(order) > 1
        assert "yolov8n.onnx" in [name for name, _ in order]

    def test_the_requested_model_always_comes_first(self):
        order = resolve_model_priority("yolov8s", gpu_available=False, free_memory_gb=8)

        assert order[0][0] == "yolov8s.onnx"

    def test_every_entry_names_a_known_model_and_type(self):
        for name, model_type in resolve_model_priority("yolov8m", False, 8):
            assert name in AVAILABLE_MODELS
            assert model_type in ("yolov8", "yolov5", "yolov4", "yolov8-qat")

    def test_qat_model_opt_in_resolves_with_qat_type(self):
        """YOLO_MODEL=crowdhuman_qat_640x384 selects the person-specialised
        QAT model and its decoder type — the opt-in must actually switch
        the decode path, not just the weights."""
        order = resolve_model_priority("crowdhuman_qat_640x384", gpu_available=False, free_memory_gb=8)

        assert order[0] == ("crowdhuman_qat_640x384.onnx", "yolov8-qat")
        # Fallback chain still reaches the COCO models
        assert "yolov8n.onnx" in [name for name, _ in order]

    def test_qat_model_absent_from_default_chain(self):
        """Unset YOLO_MODEL must never pick QAT — the default stays COCO."""
        for pref in (None, ""):
            names = [name for name, _ in resolve_model_priority(pref, False, 8)]
            assert "crowdhuman_qat_640x384.onnx" not in names

    def test_case_and_extension_are_tolerated(self):
        assert resolve_model_priority("YOLOv8M.onnx", False, 8)[0][0] == "yolov8m.onnx"

    def test_an_unknown_preference_falls_back_to_the_default_chain(self):
        order = resolve_model_priority("yolov9x", gpu_available=False, free_memory_gb=8)

        assert order[0][0] == "yolov8n.onnx"

    def test_blank_preference_is_treated_as_unset(self):
        assert resolve_model_priority("  ", False, 8)[0][0] == "yolov8n.onnx"


class TestNoDuplicates:
    def test_the_chain_has_no_repeated_files(self):
        names = [name for name, _ in resolve_model_priority("yolov8m", False, 8)]

        assert len(names) == len(set(names))

    def test_requesting_the_default_still_deduplicates(self):
        names = [name for name, _ in resolve_model_priority("yolov8n", False, 8)]

        assert len(names) == len(set(names))