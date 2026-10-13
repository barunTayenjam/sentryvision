import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

MODEL_ID = "maelic/relsgg-vits16plus"

DEFAULT_VOCABULARY = [
    "next to",
    "near",
    "behind",
    "in front of",
    "carrying",
    "looking at",
    "interacting with",
    "walking toward",
    "walking away from",
    "holding",
]

SCORE_THRESHOLD = float(os.environ.get("RELATION_SCORE_THRESHOLD", "0.3"))
TOPK = int(os.environ.get("RELATION_TOPK", "8"))
MIN_BOX_SIZE_PX = 8.0
MAX_BOXES = 10
SCENE_NMS_IOU = 0.5
SAME_CLASS_NMS_IOU = 0.35


def _iou(a: Dict[str, float], b: Dict[str, float]) -> float:
    x1 = max(a["x"], b["x"])
    y1 = max(a["y"], b["y"])
    x2 = min(a["x"] + a["width"], b["x"] + b["width"])
    y2 = min(a["y"] + a["height"], b["y"] + b["height"])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def merge_scene_boxes(
    tracked: List[Dict[str, Any]],
    scene: List[Dict[str, Any]],
    max_boxes: int = MAX_BOXES,
) -> List[Dict[str, Any]]:
    kept: List[Dict[str, Any]] = [
        t for t in tracked if t.get("width", 0) > 0 and t.get("height", 0) > 0
    ][:max_boxes]
    for s in sorted(scene, key=lambda b: -float(b.get("confidence", 0))):
        if len(kept) >= max_boxes:
            break
        if s.get("width", 0) <= 0 or s.get("height", 0) <= 0:
            continue
        duplicate = any(
            _iou(m, s) > SCENE_NMS_IOU
            or (m.get("class") == s.get("class") and _iou(m, s) > SAME_CLASS_NMS_IOU)
            for m in kept
        )
        if not duplicate:
            kept.append(s)
    return kept


def dominant_color_name(rgb: Tuple[int, int, int]) -> str:
    """Name an average RGB pixel with a coarse color vocabulary."""
    import colorsys

    r, g, b = (v / 255.0 for v in rgb)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    hue = h * 360
    if v < 0.18:
        return "black"
    if s < 0.16:
        return "white" if v > 0.75 else "gray"
    if hue < 15 or hue >= 345:
        return "red"
    if hue < 40:
        return "orange" if s > 0.55 and v > 0.5 else "brown"
    if hue < 65:
        return "yellow"
    if hue < 165:
        return "green"
    if hue < 260:
        return "blue"
    if hue < 300:
        return "purple"
    return "pink"


def box_color(pil_image: Any, box: List[float]) -> Optional[str]:
    """Average-color name for a xyxy box region, downsampled for speed."""
    x1, y1, x2, y2 = (int(max(0, v)) for v in box)
    x2 = max(x1 + 1, x2)
    y2 = max(y1 + 1, y2)
    region = pil_image.crop((x1, y1, x2, y2)).resize((8, 8))
    pixels = list(region.getdata())
    avg = tuple(sum(c[i] for c in pixels) // len(pixels) for i in range(3))
    return dominant_color_name(avg)


def validate_detections(
    detections: List[Dict[str, Any]],
    width: int,
    height: int,
    min_box: float = MIN_BOX_SIZE_PX,
    max_boxes: int = MAX_BOXES,
) -> List[Tuple[int, List[float], str]]:
    kept: List[Tuple[int, List[float], str]] = []
    for i, det in enumerate(detections):
        if not isinstance(det, dict):
            continue
        bbox = det.get("bbox") or {}
        try:
            x = float(bbox.get("x", 0))
            y = float(bbox.get("y", 0))
            w = float(bbox.get("width", 0))
            h = float(bbox.get("height", 0))
        except (TypeError, ValueError):
            continue
        x1 = max(0.0, min(x, width - 1.0))
        y1 = max(0.0, min(y, height - 1.0))
        x2 = max(0.0, min(x + w, float(width)))
        y2 = max(0.0, min(y + h, float(height)))
        if x2 - x1 < min_box or y2 - y1 < min_box:
            continue
        kept.append((i, [x1, y1, x2, y2], str(det.get("class") or "object")))
        if len(kept) >= max_boxes:
            break
    return kept


def filter_relations(
    raw_triplets: List[Any],
    kept: List[Tuple[int, List[float], str]],
    threshold: float = SCORE_THRESHOLD,
) -> List[Dict[str, Any]]:
    position_to_original = {pos: orig for pos, (orig, _, _) in enumerate(kept)}
    relations: List[Dict[str, Any]] = []
    for triplet in raw_triplets:
        try:
            score = float(triplet.score)
            if score < threshold:
                continue
            subject_pos = int(triplet.subject_idx)
            object_pos = int(triplet.object_idx)
            if subject_pos not in position_to_original or object_pos not in position_to_original:
                continue
            relations.append(
                {
                    "subject": getattr(triplet, "subject_label", None) or kept[subject_pos][2],
                    "predicate": str(triplet.predicate),
                    "object": getattr(triplet, "object_label", None) or kept[object_pos][2],
                    "score": round(score, 3),
                    "subjectIndex": position_to_original[subject_pos],
                    "objectIndex": position_to_original[object_pos],
                }
            )
        except (TypeError, ValueError, AttributeError):
            continue
    relations.sort(key=lambda r: (-r["score"], r["subjectIndex"], r["objectIndex"]))
    return relations


class RelationAnalyzer:
    _lock = threading.Lock()
    _infer_lock = threading.Lock()
    _model: Optional[Any] = None
    _load_error: str = ""

    @classmethod
    def _load(cls) -> None:
        from relsgg import RelateAnything

        started = time.time()
        model = RelateAnything.from_pretrained(MODEL_ID, device="cpu")
        model.set_vocabulary(DEFAULT_VOCABULARY)
        cls._model = model
        print(f"[RelationAnalyzer] model '{MODEL_ID}' loaded in {time.time() - started:.1f}s", flush=True)

    @classmethod
    def available(cls) -> bool:
        with cls._lock:
            if cls._model is not None:
                return True
            try:
                cls._load()
                return True
            except Exception as exc:
                cls._load_error = str(exc)
                print(f"[RelationAnalyzer] model unavailable: {exc}", flush=True)
                return False

    @classmethod
    def load_error(cls) -> str:
        return cls._load_error

    @classmethod
    def analyze(cls, image_path: str, detections: List[Dict[str, Any]]) -> Dict[str, Any]:
        import numpy as np
        from PIL import Image

        with cls._lock:
            if cls._model is None:
                cls._load()
        model = cls._model

        started = time.time()
        with Image.open(image_path) as img:
            pil_image = img.convert("RGB")
            width, height = pil_image.size
            kept = validate_detections(detections, width, height)
            validated_boxes = [
                {
                    "x": box[0],
                    "y": box[1],
                    "width": box[2] - box[0],
                    "height": box[3] - box[1],
                    "class": label,
                    "color": box_color(pil_image, box),
                }
                for _, box, label in kept
            ]
            if len(kept) < 2:
                return {
                    "relations": [],
                    "boxes": validated_boxes,
                    "imageWidth": width,
                    "imageHeight": height,
                    "boxesTotal": len(detections),
                    "boxesValid": len(kept),
                    "processingTimeMs": 0,
                }
            boxes = np.array([box for _, box, _ in kept], dtype=np.float32)
            labels = [label for _, _, label in kept]
            with cls._infer_lock:
                raw = model.predict(pil_image, boxes, box_labels=labels, topk=TOPK)
        relations = filter_relations(raw, kept)
        return {
            "relations": relations,
            "boxes": validated_boxes,
            "imageWidth": width,
            "imageHeight": height,
            "boxesTotal": len(detections),
            "boxesValid": len(kept),
            "processingTimeMs": int((time.time() - started) * 1000),
        }
