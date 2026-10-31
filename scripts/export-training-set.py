#!/usr/bin/env python3
"""Export user-verified events as a YOLO-format training set.

Feedback loop Phase A (Frigate parity #7). Reads events with a user_feedback
verdict from PostgreSQL, dumps each event's snapshot crop + bounding boxes
(from object_detections JSONB) as YOLO-format labels into data/training/,
split train/val. Phase B (fine-tune) consumes this directory manually —
no automatic retraining (data sovereignty).

Usage:
    python3 scripts/export-training-set.py [--out data/training] [--val-frac 0.2]

Requires: psycopg2 (or psycopg), events table with user_feedback column
(migration 045).
"""
import argparse
import json
import os
import random
import shutil
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# COCO class ids shared by the pipeline's QAT/COCO models. Class names come
# from opencv-service/models/yolo_classes.txt when present.
DEFAULT_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
]


def load_env():
    env_path = BASE_DIR / ".env"
    if env_path.exists():
        for line in env_path.read_text().split("\n"):
            m = __import__("re").match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip()


def get_connection():
    try:
        import psycopg2
    except ImportError:
        sys.exit("psycopg2 required: pip install psycopg2-binary")
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "sentryvision"),
        user=os.getenv("DB_USER", "sentryvision"),
        password=os.getenv("DB_PASSWORD", ""),
    )


def fetch_events(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, image_path, object_detections, user_feedback, camera_id
            FROM events
            WHERE user_feedback IS NOT NULL
              AND image_path IS NOT NULL
            ORDER BY created_at
            """
        )
        return cur.fetchall()


def yolo_lines(object_detections, img_w, img_h):
    """Convert object_detections JSONB to YOLO label lines (class cx cy w h)."""
    if not object_detections:
        return []
    dets = object_detections if isinstance(object_detections, list) else []
    lines = []
    for det in dets:
        bbox = det.get("bbox") or det.get("position", {}).get("x")
        if not bbox or len(bbox) != 4:
            continue
        if isinstance(bbox[0], dict):  # position-style {x, y, width, height}
            x, y = bbox[0].get("x", 0), bbox[0].get("y", 0)
            w, h = bbox[0].get("width", 0), bbox[0].get("height", 0)
        else:
            x, y, w, h = bbox
        if w <= 0 or h <= 0 or img_w <= 0 or img_h <= 0:
            continue
        cls_name = det.get("class") or det.get("label") or "person"
        try:
            cls_id = DEFAULT_CLASSES.index(cls_name)
        except ValueError:
            continue
        cx, cy = (x + w / 2) / img_w, (y + h / 2) / img_h
        lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w / img_w:.6f} {h / img_h:.6f}")
    return lines


def export(out_dir: Path, val_frac: float):
    load_env()
    conn = get_connection()
    rows = fetch_events(conn)
    conn.close()

    if not rows:
        print("No events with user_feedback verdicts — nothing to export.")
        return

    for split in ("train", "val"):
        (out_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    exported = skipped = 0
    for event_id, image_path, detections, feedback, camera_id in rows:
        src = Path(image_path)
        if not src.is_absolute():
            src = BASE_DIR / image_path
        if not src.exists():
            skipped += 1
            continue

        import cv2  # after env check — optional dep for image dims

        img = cv2.imread(str(src))
        if img is None:
            skipped += 1
            continue
        h, w = img.shape[:2]

        lines = yolo_lines(detections, w, h)
        if not lines and feedback == "confirmed":
            # Confirmed events with no boxes still contribute a negative-free
            # image; label file stays empty (background image in YOLO terms).
            lines = []

        stem = f"{str(event_id)[:8]}_{camera_id or 'cam'}"
        split = "val" if random.random() < val_frac else "train"
        shutil.copy2(src, out_dir / "images" / split / f"{stem}{src.suffix}")
        (out_dir / "labels" / split / f"{stem}.txt").write_text("\n".join(lines))
        exported += 1

    (out_dir / "classes.txt").write_text("\n".join(DEFAULT_CLASSES))
    meta = {
        "exported": exported,
        "skipped_missing_image": skipped,
        "verdict_counts": {
            v: sum(1 for r in rows if r[3] == v) for v in ("false_positive", "false_negative", "confirmed")
        },
        "classes": len(DEFAULT_CLASSES),
    }
    (out_dir / "export_meta.json").write_text(json.dumps(meta, indent=2))
    print(f"Exported {exported} events ({skipped} skipped) to {out_dir}")
    print(json.dumps(meta["verdict_counts"], indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(BASE_DIR / "data" / "training"))
    parser.add_argument("--val-frac", type=float, default=0.2)
    args = parser.parse_args()
    random.seed(42)  # reproducible split
    export(Path(args.out), args.val_frac)
