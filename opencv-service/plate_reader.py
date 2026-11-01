"""PlateReader: two-stage LPR on vehicle tracks (Frigate parity #8).

Stage 1 (plate detect): locate a plate-like rectangle inside the vehicle
crop (aspect 1.5–8:1, contour-based via cv2 in the container).
Stage 2 (OCR): read text from the plate crop (PaddleOCR-class engine in
the container; injectable).

Emission gates — all must hold:
- track_class is a vehicle class (plates never run on person tracks)
- stage 1 finds a plate bbox, stage 2 returns text
- normalize_plate → valid_plate (alnum, len 4–10, ≥2 digits or letters)
- OCR confidence ≥ min_confidence

Output feeds detectionPersistence as an object_detections entry:
  {label: 'plate', plate: 'XY12AB3456', confidence: 0.87, source: 'lpr'}
Plates stay local-only (retention follows event retention; no cloud).

Engines are injectable fakes in tests; cv2 imports lazily so the module
loads on host (numpy-only) for pure-logic tests.
"""

import logging
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

VEHICLE_CLASSES = frozenset({"car", "truck", "bus", "vehicle", "motorcycle"})


def normalize_plate(raw: str) -> str:
    """Uppercase; strip everything except alphanumerics."""
    return "".join(ch for ch in (raw or "").strip() if ch.isalnum()).upper()


def valid_plate(plate: str) -> bool:
    """Region-agnostic plausibility: alnum, len 4–10, ≥2 digits or ≥2 letters."""
    if not plate or not (4 <= len(plate) <= 10) or not plate.isalnum():
        return False
    digits = sum(ch.isdigit() for ch in plate)
    letters = sum(ch.isalpha() for ch in plate)
    # Real plates mix letters and digits in every region; require ≥2 of each
    return digits >= 2 and letters >= 2


def _detect_plate_contour(crop: "np.ndarray") -> List[Tuple[int, int, int, int]]:
    """Default stage 1 (container): Otsu → dilate → contour; keep the best
    plate-aspect rectangle. Returns [] when nothing qualifies."""
    import cv2 as cv

    gray = cv.cvtColor(crop, cv.COLOR_BGR2GRAY)
    _, thresh = cv.threshold(gray, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    dilated = cv.dilate(thresh, None, iterations=2)
    contours, _ = cv.findContours(dilated, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    best = None
    best_area = 0
    crop_area = crop.shape[0] * crop.shape[1]
    for cnt in contours:
        x, y, w, h = cv.boundingRect(cnt)
        area = w * h
        if area < 200 or area > 0.6 * crop_area:
            continue
        asp = w / h if h > 0 else 0
        if not (1.5 <= asp <= 8.0):
            continue
        if area > best_area:
            best, best_area = (x, y, x + w, y + h), area
    return [best] if best else []


def _default_ocr(plate_crop: "np.ndarray") -> List[Tuple[str, float]]:
    """Default stage 2 (container): PaddleOCR when installed, else no-op.

    ponytail: swap for a bundled CRNN ONNX when on-device benchmarking
    shows PaddleOCR too heavy; the engine interface stays the same.
    """
    try:
        from paddleocr import PaddleOCR  # heavy import — lazy
    except ImportError:
        logger.warning("[PlateReader] PaddleOCR not installed — OCR disabled")
        return []
    engine = PaddleOCR(use_angle_cls=False, lang="en", show_log=False)
    result = engine.ocr(plate_crop, cls=False)
    if not result or not result[0]:
        return []
    out = []
    for line in result[0]:
        text, conf = line[1]
        out.append((text, float(conf)))
    return out


class PlateReader:
    def __init__(
        self,
        detect_engine: Optional[Callable] = None,
        ocr_engine: Optional[Callable] = None,
        *,
        min_confidence: float = 0.6,
    ):
        self.detect_engine = detect_engine or _detect_plate_contour
        self.ocr_engine = ocr_engine or _default_ocr
        self.min_confidence = float(min_confidence)

    def read(self, crop: np.ndarray, *, track_class: str) -> List[Dict[str, object]]:
        """Run both stages on a vehicle crop; gated emission. Never raises."""
        if track_class not in VEHICLE_CLASSES:
            return []

        try:
            boxes = self.detect_engine(crop)
        except Exception as e:
            logger.warning(f"[PlateReader] detect error: {e}")
            return []
        if not boxes:
            return []

        h, w = crop.shape[:2]
        best: Optional[Tuple[str, float]] = None
        for (x1, y1, x2, y2) in boxes:
            rx1, ry1 = max(0, x1), max(0, y1)
            rx2, ry2 = min(w, x2), min(h, y2)
            if rx2 <= rx1 or ry2 <= ry1:
                continue
            plate_crop = crop[ry1:ry2, rx1:rx2]
            if plate_crop.size == 0:
                continue
            try:
                results = self.ocr_engine(plate_crop)
            except Exception as e:
                logger.warning(f"[PlateReader] ocr error: {e}")
                continue
            for text, conf in results:
                norm = normalize_plate(text)
                if valid_plate(norm) and conf >= self.min_confidence:
                    if best is None or conf > best[1]:
                        best = (norm, conf)

        if best is None:
            return []
        return [
            {
                "label": "plate",
                "plate": best[0],
                "confidence": round(best[1], 4),
                "source": "lpr",
            }
        ]


def build_plate_reader(camera_id: str, camera_config: dict) -> Optional[PlateReader]:
    """Factory from cameras.json entry: {"lpr": {"enabled": true, ...}}.

    Default is DISABLED (privacy: plates only where explicitly opted in).
    Returns None on host (no cv2) — degrade, never crash.
    """
    lpr_cfg = (camera_config or {}).get("lpr") or {}
    if not lpr_cfg.get("enabled", False):
        return None

    try:
        import cv2  # noqa: F401
    except ImportError:
        logger.info(f"[PlateReader] {camera_id}: cv2 unavailable on host — disabled")
        return None

    reader = PlateReader(min_confidence=float(lpr_cfg.get("min_confidence", 0.6)))
    logger.info(f"[PlateReader] {camera_id}: enabled")
    return reader
