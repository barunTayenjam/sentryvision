#!/usr/bin/env python3
"""Compare COCO yolov8n vs CrowdHuman QAT person detector against AI truth.

Ground truth = detection_summary.has_person written by the vision-model AI
analysis (user-designated truth). Same post-filters for both models so the
comparison isolates the weights: person thresh 0.40, min side 20, min area 600,
detect at 640x360 (pipeline detect resolution).

Usage: python /app/compare_models_ai_truth.py [limit] [person_thresh min_side min_area]
"""
import csv
import os
import sys
import time

import cv2

sys.path.insert(0, "/app")
from rtsp_ingestion.frame_pipeline import InProcessYOLO  # noqa: E402

LABELS = "/app/data/detections/model_eval/labels.csv"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 0
PERSON_THRESH = float(sys.argv[2]) if len(sys.argv) > 2 else 0.40
MIN_SIDE = int(sys.argv[3]) if len(sys.argv) > 3 else 20
MIN_AREA = int(sys.argv[4]) if len(sys.argv) > 4 else 600


def load_detector():
    d = InProcessYOLO("/app/models")
    d.initialize()
    d._class_thresholds["person"] = PERSON_THRESH
    d._min_box_side = MIN_SIDE
    d._min_box_area = MIN_AREA
    return d


def person_boxes(det, img):
    small = cv2.resize(img, (640, 360), interpolation=cv2.INTER_AREA)
    t0 = time.perf_counter()
    dets = det.detect(small)
    ms = (time.perf_counter() - t0) * 1000
    return [d for d in dets if d["class"] == "person"], ms


def score_model(det, rows):
    tp = fp = fn = tn = 0
    missing = 0
    count_err = []  # (ai_count, det_count) where ai truth says persons present
    total_ms = 0.0
    disagreements = []
    for path, truth, ai_count, cam in rows:
        img = cv2.imread(path)
        if img is None:
            missing += 1
            continue
        boxes, ms = person_boxes(det, img)
        total_ms += ms
        pred = len(boxes) > 0
        if pred and truth:
            tp += 1
        elif pred and not truth:
            fp += 1
            disagreements.append(("FP", os.path.basename(path), len(boxes)))
        elif not pred and truth:
            fn += 1
            disagreements.append(("FN", os.path.basename(path), ai_count))
        else:
            tn += 1
        if truth and ai_count:
            count_err.append(abs(int(ai_count) - len(boxes)))
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn, "missing": missing,
        "precision": tp / max(1, tp + fp),
        "recall": tp / max(1, tp + fn),
        "f1": 2 * tp / max(1, 2 * tp + fp + fn),
        "accuracy": (tp + tn) / max(1, tp + tn + fp + fn),
        "count_mae": sum(count_err) / max(1, len(count_err)),
        "avg_ms": total_ms / max(1, tp + fp + fn + tn),
        "disagreements": disagreements,
    }


def main():
    with open(LABELS) as f:
        rows = [(p, t == "true", int(c or 0), cam)
                for p, t, c, cam in csv.reader(f) if p]
    if LIMIT:
        rows = rows[:LIMIT]
    print(f"labeled events: {len(rows)} "
          f"(person={sum(1 for r in rows if r[1])}, none={sum(1 for r in rows if not r[1])})")

    os.environ.pop("YOLO_MODEL", None)
    coco = load_detector()
    r_coco = score_model(coco, rows)
    print("\n=== COCO yolov8n (fp32, 640x640 stretch) ===")
    print(f"TP={r_coco['tp']} FP={r_coco['fp']} FN={r_coco['fn']} TN={r_coco['tn']} missing={r_coco['missing']}")
    print(f"precision={r_coco['precision']:.3f} recall={r_coco['recall']:.3f} "
          f"f1={r_coco['f1']:.3f} accuracy={r_coco['accuracy']:.3f}")
    print(f"person-count MAE (when AI says persons): {r_coco['count_mae']:.2f}")
    print(f"avg inference: {r_coco['avg_ms']:.1f} ms")

    os.environ["YOLO_MODEL"] = os.getenv("EVAL_QAT_MODEL", "crowdhuman_qat_640x384")
    qat = load_detector()
    r_qat = score_model(qat, rows)
    print("\n=== CrowdHuman QAT (int8-trained, 640x384 letterbox) ===")
    print(f"TP={r_qat['tp']} FP={r_qat['fp']} FN={r_qat['fn']} TN={r_qat['tn']} missing={r_qat['missing']}")
    print(f"precision={r_qat['precision']:.3f} recall={r_qat['recall']:.3f} "
          f"f1={r_qat['f1']:.3f} accuracy={r_qat['accuracy']:.3f}")
    print(f"person-count MAE (when AI says persons): {r_qat['count_mae']:.2f}")
    print(f"avg inference: {r_qat['avg_ms']:.1f} ms")

    for name, r in (("COCO", r_coco), ("QAT", r_qat)):
        fps = [d for d in r["disagreements"] if d[0] == "FP"][:8]
        fns = [d for d in r["disagreements"] if d[0] == "FN"][:8]
        print(f"\n{name} sample FPs: {fps}")
        print(f"{name} sample FNs: {fns}")


if __name__ == "__main__":
    main()