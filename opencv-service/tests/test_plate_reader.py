"""PlateReader: two-stage LPR on vehicle tracks (Frigate parity #8).

Contract:
- Stage 1 (plate detect): returns plate bboxes within a vehicle crop
- Stage 2 (OCR): reads text from plate crops
- normalize_plate: uppercase, strip non-alphanumerics, length gate 4–10
- valid_plate: region-agnostic plausibility (alnum only, ≥2 digits OR
  ≥2 letters — plates everywhere mix both)
- Emission: only on vehicle-class tracks, only when both stages agree,
  per-camera opt-out via cameras.json "lpr": {"enabled": false}
- Output feeds detectionPersistence as an object_detections entry:
  {label: 'plate', plate: 'XY12AB3456', confidence: 0.87, source: 'lpr'}

Host-runnable: engines are injected fakes; no cv2/paddle import at module
scope (both load lazily in the container default path).
"""

import sys

import numpy as np
import pytest

sys.path.insert(0, "/app")

from plate_reader import (  # noqa: E402
    PlateReader,
    normalize_plate,
    valid_plate,
    build_plate_reader,
)


class TestNormalizePlate:
    def test_uppercases_and_strips_punctuation(self):
        assert normalize_plate("mh-12 ab, 3456") == "MH12AB3456"

    def test_empty_returns_empty(self):
        assert normalize_plate("---") == ""

    def test_strips_whitespace(self):
        assert normalize_plate("  ka 05 mj 9876 ") == "KA05MJ9876"


class TestValidPlate:
    @pytest.mark.parametrize(
        "plate",
        ["MH12AB3456", "KA05MJ9876", "DL8CAF1234", "GJ01DK9999", "AB123CD"],
    )
    def test_valid(self, plate):
        assert valid_plate(plate)

    @pytest.mark.parametrize(
        "plate",
        ["", "AB", "123", "ABCDEF", "123456", "ABCDEFGHIJKLMNOP"],
    )
    def test_invalid(self, plate):
        assert not valid_plate(plate)

    def test_all_letters_invalid(self):
        assert not valid_plate("ABCDEFGH")

    def test_all_digits_invalid(self):
        assert not valid_plate("12345678")

    def test_too_long_invalid(self):
        assert not valid_plate("MH12AB3456789X")


def fake_detect(crop):
    """One plate bbox covering the middle of the crop."""
    return [(10, 40, 200, 80)]


def fake_ocr(plate_crop):
    return [("MH12AB3456", 0.91)]


def make_reader(detect_fn=fake_detect, ocr_fn=fake_ocr, min_conf=0.6):
    return PlateReader(detect_engine=detect_fn, ocr_engine=ocr_fn, min_confidence=min_conf)


class TestPlateReaderEmission:
    def test_vehicle_crop_with_plate_emits_entry(self):
        r = make_reader()
        crop = np.zeros((120, 240, 3), np.uint8)
        entries = r.read(crop, track_class="car")
        assert len(entries) == 1
        e = entries[0]
        assert e["label"] == "plate"
        assert e["plate"] == "MH12AB3456"
        assert e["confidence"] == pytest.approx(0.91, abs=1e-4)
        assert e["source"] == "lpr"

    def test_person_track_never_emits(self):
        r = make_reader()
        crop = np.zeros((120, 240, 3), np.uint8)
        assert r.read(crop, track_class="person") == []

    def test_no_plate_detected_no_emission(self):
        r = make_reader(detect_fn=lambda crop: [])
        crop = np.zeros((120, 240, 3), np.uint8)
        assert r.read(crop, track_class="car") == []

    def test_ocr_below_confidence_no_emission(self):
        r = make_reader(ocr_fn=lambda pc: [("MH12AB3456", 0.3)])
        crop = np.zeros((120, 240, 3), np.uint8)
        assert r.read(crop, track_class="car") == []

    def test_garbage_ocr_text_no_emission(self):
        r = make_reader(ocr_fn=lambda pc: [("??", 0.95)])
        crop = np.zeros((120, 240, 3), np.uint8)
        assert r.read(crop, track_class="car") == []

    def test_engine_exception_never_crashes(self):
        def boom(crop):
            raise RuntimeError("paddle died")

        r = make_reader(detect_fn=boom)
        crop = np.zeros((120, 240, 3), np.uint8)
        assert r.read(crop, track_class="car") == []

    def test_multiple_plates_takes_best_confidence(self):
        r = make_reader(
            detect_fn=lambda crop: [(0, 0, 50, 30), (60, 60, 200, 90)],
            ocr_fn=lambda pc: [("MH12AB3456", 0.7)] if pc.shape[0] < 40 else [("KA05MJ9876", 0.95)],
        )
        crop = np.zeros((120, 240, 3), np.uint8)
        entries = r.read(crop, track_class="truck")
        assert len(entries) == 1
        assert entries[0]["plate"] == "KA05MJ9876"


class TestBuildFromConfig:
    def test_disabled_by_default(self):
        assert build_plate_reader("cam1", {}) is None

    def test_opt_out_explicit(self):
        assert build_plate_reader("cam1", {"lpr": {"enabled": False}}) is None

    def test_enabled_without_models_returns_none_not_crash(self):
        # host: no paddle/cv2 → factory must degrade to None
        assert build_plate_reader("cam1", {"lpr": {"enabled": True}}) is None
