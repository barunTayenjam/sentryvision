"""AudioDetector: YAMNet ONNX alert-class detection over 16kHz mono waveform.

Contract (Frigate parity #6):
- 0.96s window (15600 samples @ 16kHz), RMS pre-gate skips silence
- 521 YAMNet classes collapse to ~10 alert labels (scream, glass_break,
  gunshot, explosion, siren, bang, knock, slam, bark, speech)
- Output feeds detectionPersistence as event_type 'audio' with
  [{label, confidence, source: 'audio'}] in object_detections
- Missing model or failed inference → detector disabled, never crashes

Host-runnable: ORT session is mocked; numpy is the only hard dep.
"""

import sys
from typing import List

import numpy as np
import pytest

sys.path.insert(0, "/app")

from audio_detector import AudioDetector, ALERT_LABELS  # noqa: E402


class FakeSession:
    """Stands in for ort.InferenceSession. Returns a scores array the
    caller treats as [1, 521]; we spike the 'screaming' class."""

    SCREAM_INDEX = 8  # arbitrary — mapping is by class name, not index

    def __init__(self, spike: int | None = None, score: float = 0.9):
        self.spike = spike
        self.score = score
        self.seen_shape = None

    def get_inputs(self):
        class _In:
            name = "waveform"
            shape = [None]
        return [_In()]

    def run(self, _, feed):
        wave = list(feed.values())[0]
        self.seen_shape = wave.shape
        scores = np.zeros((1, 521), np.float32)
        if self.spike is not None:
            scores[0, self.spike] = self.score
        return [scores]


def make_detector(spike=None, score=0.9, sensitivity=0.6, classes=None):
    det = AudioDetector("/nonexistent/yamnet.onnx", sensitivity=sensitivity)
    det._session = FakeSession(spike, score)
    det._session_ok = True  # simulate loaded model (host has no onnxruntime)
    det._class_names = classes or {8: "Screaming"}
    return det


class TestRmsGate:
    def test_silence_produces_no_event(self):
        det = make_detector(spike=8, score=0.99)
        silence = np.zeros(15600, np.float32)
        assert det.detect(silence) == []

    def test_quiet_noise_below_floor_produces_no_event(self):
        det = make_detector(spike=8, score=0.99)
        # amplitude 0.001 ≈ −60dB, well under any speech-level floor
        quiet = np.full(15600, 0.001, np.float32)
        assert det.detect(quiet) == []


class TestDetection:
    def test_loud_waveform_with_scream_class_emits_event(self):
        det = make_detector(spike=8, score=0.9)
        loud = np.random.uniform(-0.8, 0.8, 15600).astype(np.float32)
        events = det.detect(loud)
        assert len(events) == 1
        evt = events[0]
        assert evt["label"] == "scream"
        assert evt["confidence"] == pytest.approx(0.9, abs=1e-4)
        assert evt["source"] == "audio"

    def test_score_below_sensitivity_suppressed(self):
        det = make_detector(spike=8, score=0.5, sensitivity=0.6)
        loud = np.random.uniform(-0.8, 0.8, 15600).astype(np.float32)
        assert det.detect(loud) == []

    def test_non_alert_class_suppressed(self):
        # 'Music' is not an alert class — must not emit
        det = make_detector(spike=8, score=0.99, classes={8: "Music"})
        loud = np.random.uniform(-0.8, 0.8, 15600).astype(np.float32)
        assert det.detect(loud) == []

    def test_longer_waveform_is_windowed(self):
        det = make_detector(spike=8, score=0.9)
        loud = np.random.uniform(-0.8, 0.8, 15600 * 3).astype(np.float32)
        events = det.detect(loud)
        assert len(events) == 1
        # session saw multiple windows
        assert det._session.seen_shape is not None


class TestClassMapping:
    @pytest.mark.parametrize(
        "yamnet_name,alert",
        [
            ("Screaming", "scream"),
            ("Yell", "scream"),
            ("Shout", "scream"),
            ("Gunshot, gunfire", "gunshot"),
            ("Explosion", "explosion"),
            ("Siren", "siren"),
            ("Bang", "bang"),
            ("Knock", "knock"),
            ("Slam", "slam"),
            ("Glass", "glass_break"),
            ("Smash, crash", "glass_break"),
            ("Bark", "bark"),
            ("Speech", "speech"),
        ],
    )
    def test_alert_labels(self, yamnet_name, alert):
        assert alert in ALERT_LABELS
        det = make_detector(spike=8, score=0.99, classes={8: yamnet_name})
        loud = np.random.uniform(-0.8, 0.8, 15600).astype(np.float32)
        events = det.detect(loud)
        assert events and events[0]["label"] == alert


class TestDisabled:
    def test_missing_model_disables(self):
        det = AudioDetector("/nonexistent/yamnet.onnx")
        assert not det.enabled
        # detect() on disabled detector is a no-op, not a crash
        assert det.detect(np.ones(15600, np.float32)) == []

    def test_broken_session_disables(self):
        det = AudioDetector("/nonexistent/yamnet.onnx")
        det._class_names = {8: "Screaming"}

        class Broken:
            def run(self, *_):
                raise RuntimeError("corrupt model")

        det._session = Broken()
        loud = np.ones(15600, np.float32)
        # broken inference → empty result, no exception, detector self-disables
        assert det.detect(loud) == []
        assert not det._session_ok
