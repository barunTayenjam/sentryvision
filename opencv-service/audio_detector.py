"""AudioDetector: YAMNet ONNX alert-class detection over 16kHz mono waveform.

Frigate parity #6. Audio Reader (separate ffmpeg -vn s16le/16kHz/mono pipe,
opt-in per camera via cameras.json "audio": {"enabled": true, "sensitivity":
0.6}) feeds 0.96s windows into detect(). Alerts flow the existing WebSocket
event path; Node detectionPersistence stores them as event_type 'audio'
with [{label, confidence, source: 'audio'}] in object_detections JSONB.

Design:
- YAMNet ONNX (521 classes) baked at image build (download_all_models.py);
  class names from yamnet_class_map.csv mapped to ~12 alert labels by
  normalized substring match — robust to CSV naming variants.
- RMS pre-gate (0.01 ≈ -40dBFS) skips silence before inference.
- sensitivity gates the class score, NOT loudness (a quiet scream is still
  a scream; the RMS gate exists only to skip dead air).
- Longer waveforms slide 50% overlap; per-label MAX across windows emits at
  most one event per label.
- Missing model, missing ORT, or inference error → detector self-disables;
  detect() is always safe to call.

ponytail: label set and floors are single constants — promote to per-camera
config when a second deployment needs different alerts.
"""

import logging
import os
from typing import Dict, List, Optional

import numpy as np

try:
    import onnxruntime as ort
except ImportError:  # host test envs inject a fake session
    ort = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# Alert labels exposed to the event pipeline (subset of YAMNet's 521).
ALERT_LABELS = frozenset({
    "scream", "gunshot", "explosion", "siren", "bang",
    "knock", "slam", "glass_break", "bark", "speech",
})

# YAMNet display-name fragment → alert label. Matched by normalized
# substring (lower, strip punctuation) so "Screaming", "Scream", and
# "Child speech, kid speaking" variants all resolve.
_NAME_FRAGMENTS: List[tuple] = [
    ("scream", "scream"),
    ("yell", "scream"),
    ("shout", "scream"),
    ("gunshot", "gunshot"),
    ("gunfire", "gunshot"),
    ("explosion", "explosion"),
    ("siren", "siren"),
    ("bang", "bang"),
    ("knock", "knock"),
    ("slam", "slam"),
    ("smash", "glass_break"),
    ("crash", "glass_break"),
    ("glass", "glass_break"),
    ("shatter", "glass_break"),
    ("bark", "bark"),
    ("howl", "bark"),
    ("speech", "speech"),
]

DEFAULT_SENSITIVITY = 0.6
WINDOW_SAMPLES = 15600  # 0.975s @ 16kHz
RMS_FLOOR = 0.01        # -40dBFS: below this is dead air, skip inference

# Reverse-ordered fragments so longer/more-specific names win over
# shorter ones ("smash" before "speech"-irrelevant; "gunshot" before "gun").
_FRAGMENTS_ORDERED = sorted(_NAME_FRAGMENTS, key=lambda p: -len(p[0]))


def _normalize(name: str) -> str:
    return "".join(c for c in name.lower() if c.isalnum() or c.isspace()).strip()


def name_to_alert(yamnet_name: str) -> Optional[str]:
    """Map a YAMNet class display name to an alert label, or None."""
    norm = _normalize(yamnet_name)
    for frag, alert in _FRAGMENTS_ORDERED:
        if frag in norm:
            return alert
    return None


def _build_session(model_path: str):
    """Build ONNX session; None when model missing or load fails."""
    if ort is None:
        logger.warning("[AudioDetector] onnxruntime unavailable — detector disabled")
        return None
    try:
        return ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    except Exception as e:
        logger.warning(f"[AudioDetector] Failed to load YAMNet model {model_path}: {e}")
        return None


class AudioDetector:
    SAMPLE_RATE = 16000

    def __init__(
        self,
        model_path: str,
        sensitivity: float = DEFAULT_SENSITIVITY,
        *,
        class_map: Optional[Dict[int, str]] = None,
    ):
        self.sensitivity = float(sensitivity)
        self._class_names: Dict[int, str] = class_map or {}
        self._session = _build_session(model_path)
        self._session_ok = self._session is not None

        if self._session_ok:
            logger.info(
                f"[AudioDetector] loaded ({len(ALERT_LABELS)} alert classes, "
                f"sensitivity={self.sensitivity}, classes={len(self._class_names)})"
            )

    @property
    def enabled(self) -> bool:
        return self._session_ok and bool(self._class_names)

    def _load_class_map(self, csv_path: str) -> bool:
        """Load index→name from yamnet_class_map.csv (baked with model)."""
        try:
            with open(csv_path, encoding="utf-8") as f:
                next(f)  # header
                for line in f:
                    parts = line.strip().split(",", 2)
                    if len(parts) == 3:
                        self._class_names[int(parts[0])] = parts[2]
            return bool(self._class_names)
        except OSError as e:
            logger.warning(f"[AudioDetector] class map missing ({csv_path}): {e}")
            return False

    def detect(self, waveform_16k_mono: np.ndarray) -> List[Dict[str, object]]:
        """One pass over a 16kHz mono float32 waveform in [-1, 1].

        Returns at most one alert dict per label:
        [{label: str, confidence: float, source: 'audio'}]
        """
        if not self._session_ok or not self._class_names:
            return []

        wav = np.asarray(waveform_16k_mono, dtype=np.float32).ravel()
        if len(wav) < WINDOW_SAMPLES:
            return []

        rms = float(np.sqrt(np.mean(wav ** 2)))
        if rms < RMS_FLOOR:
            return []

        step = WINDOW_SAMPLES // 2  # 50% overlap
        best_per_label: Dict[str, float] = {}

        pos = 0
        while pos + WINDOW_SAMPLES <= len(wav):
            window = wav[pos : pos + WINDOW_SAMPLES]
            try:
                outputs = self._session.run(
                    None, {self._input_name(): window[np.newaxis, :]}
                )
            except Exception as e:
                logger.warning(f"[AudioDetector] inference error: {e}")
                self._session_ok = False
                return []
            scores = np.asarray(outputs[0]).reshape(1, -1)

            for idx, name in self._class_names.items():
                if idx >= scores.shape[1]:
                    continue
                alert = name_to_alert(name)
                if alert is None:
                    continue
                conf = float(scores[0, idx])
                if conf >= self.sensitivity and conf > best_per_label.get(alert, 0.0):
                    best_per_label[alert] = conf
            pos += step

        return [
            {"label": label, "confidence": round(conf, 4), "source": "audio"}
            for label, conf in sorted(best_per_label.items(), key=lambda kv: -kv[1])
        ]

    def _input_name(self) -> str:
        try:
            return self._session.get_inputs()[0].name
        except Exception:
            return "waveform"


def build_detector_from_config(camera_id: str, camera_config: dict) -> Optional[AudioDetector]:
    """Factory from cameras.json entry: audio.enabled + audio.sensitivity."""
    audio_cfg = (camera_config or {}).get("audio", {})
    if not audio_cfg.get("enabled", False):
        return None

    models_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    det = AudioDetector(
        model_path=os.path.join(models_dir, "yamnet.onnx"),
        sensitivity=float(audio_cfg.get("sensitivity", DEFAULT_SENSITIVITY)),
    )
    if det._session is None:
        return None
    if not det._load_class_map(os.path.join(models_dir, "yamnet_class_map.csv")):
        logger.warning(f"[AudioDetector] {camera_id}: model loaded but class map missing — disabled")
        return None
    logger.info(f"[AudioDetector] {camera_id}: enabled (sensitivity={det.sensitivity})")
    return det
