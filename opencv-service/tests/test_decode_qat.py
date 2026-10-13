"""_decode_qat contract: 6-head DFL decode, stride math, letterbox inverse.

Synthetic heads with a known DFL peak at a known grid cell — the decoded
box must land at the exact frame coordinates. Pins head layout (box/cls
interleaved per stride), grid-to-image mapping, and the letterbox
inverse, so a silent stride or axis mix-up cannot pass.

Supported head layouts (both pinned here):
  - batch-first:  (1, 64, gh, gw) / (1, 1, gh, gw)  — ndim-4 guard strips batch
  - channels-last grid: (gh, gw, 64) / (gh, gw, 1)  — ndim-3 transpose guard
Note: a flat (HW, C) layout would crash the ndim-3 transpose guard —
unsupported by design; real exports emit grid-shaped tensors.
"""

import numpy as np
import pytest

from rtsp_ingestion.frame_pipeline import InProcessYOLO


STRIDES = ((8, 48, 80), (16, 24, 40), (32, 12, 20))


def _make_det() -> InProcessYOLO:
    det = InProcessYOLO.__new__(InProcessYOLO)
    det._class_thresholds = {"person": 0.40}
    det._default_threshold = 0.50
    det._min_box_side = 35
    det._min_box_area = 1500
    det._class_names = ["person", "bicycle", "car"]  # COCO prefix used by yolo_classes.txt
    return det


def _head_pair(gh: int, gw: int, cell: int, ltrb: tuple, conf: float, batched: bool = True):
    """One (box, cls) head pair with a single DFL spike in one grid cell.

    box channels: 4 sides x 16 bins, side-major (side*16 + bin). All 16
    bins zero except a large logit on the bin matching the offset —
    softmax picks the ltrb value exactly.
    """
    if batched:
        box = np.zeros((1, 64, gh, gw), dtype=np.float32)
        cls = np.full((1, 1, gh, gw), -10.0, dtype=np.float32)
        for side, val in enumerate(ltrb):
            box[0, side * 16 + int(round(val)), cell // gw, cell % gw] = 20.0
        cls[0, 0, cell // gw, cell % gw] = np.log(conf / (1 - conf))
    else:
        box = np.zeros((gh, gw, 64), dtype=np.float32)
        cls = np.full((gh, gw, 1), -10.0, dtype=np.float32)
        for side, val in enumerate(ltrb):
            box[cell // gw, cell % gw, side * 16 + int(round(val))] = 20.0
        cls[cell // gw, cell % gw, 0] = np.log(conf / (1 - conf))
    return box, cls


def _heads(cell: int, ltrb: tuple, conf: float, batched: bool = True) -> list:
    heads = []
    for stride, gh, gw in STRIDES:
        c = conf if stride == 8 else 0.01
        cl = cell if stride == 8 else 0
        heads.extend(_head_pair(gh, gw, cl, ltrb, c, batched))
    return heads


def test_decodes_exact_box_at_known_cell():
    det = _make_det()
    # Stride-8 head is 48x80 for 384x640. Cell (10, 20): center (20.5, 10.5)
    # grid units -> letterbox px (164, 84). ltrb (8, 4, 8, 4) -> 64x64 box.
    heads = _heads(10 * 80 + 20, (8, 4, 8, 4), 0.9)
    lb = {"r": 1.0, "dw": 0, "dh": 12}
    boxes, confs, cids = det._decode_qat(heads, 640, 360, lb)
    assert len(boxes) == 1
    x, y, w, h = boxes[0]
    # x1 = (20.5-8)*8 = 100, x2 = (20.5+8)*8 = 228 -> w = 128
    # y1 = (10.5-4)*8 - 12 = 40, y2 = (10.5+4)*8 - 12 = 104 -> h = 64
    assert (x, y, w, h) == (100, 40, 128, 64)
    assert confs[0] == pytest.approx(0.9, abs=1e-3)
    assert cids == [0]


def test_letterbox_inverse_shifts_box_back():
    det = _make_det()
    # Same detection, but the frame was letterboxed with r=0.5, dw=64, dh=0
    heads = _heads(10 * 80 + 20, (8, 4, 8, 4), 0.9)
    lb = {"r": 0.5, "dw": 64, "dh": 0}
    boxes, _, _ = det._decode_qat(heads, 1280, 720, lb)
    assert len(boxes) == 1
    x, y, w, h = boxes[0]
    # x1 = ((20.5-8)*8 - 64)/0.5 = 72, y1 = ((10.5-4)*8)/0.5 = 104
    assert (x, y) == (72, 104)
    # Box size inverts the scale too: 128/0.5 = 256, 64/0.5 = 128
    assert (w, h) == (256, 128)


def test_below_threshold_head_ignored():
    det = _make_det()
    heads = _heads(0, (8, 4, 8, 4), 0.3)  # < person threshold 0.40
    boxes, _, _ = det._decode_qat(heads, 640, 360, {"r": 1.0, "dw": 0, "dh": 12})
    assert boxes == []


def test_min_box_side_filters_tiny_boxes():
    det = _make_det()
    # ltrb (2,1,2,1) -> 32x32 px at stride 8: below min_box_side 35
    heads = _heads(5 * 80 + 5, (2, 1, 2, 1), 0.9)
    boxes, _, _ = det._decode_qat(heads, 640, 360, {"r": 1.0, "dw": 0, "dh": 12})
    assert boxes == []


def test_clamps_to_frame_bounds():
    det = _make_det()
    # ltrb (16, 4, 8, 8): x1 = (1.5-16)*8 = -116 -> clipped to 0,
    # y1 = (2.5-4)*8 - 12 = -24 -> clipped to 0
    heads = _heads(2 * 80 + 1, (16, 4, 8, 8), 0.9)
    boxes, _, _ = det._decode_qat(heads, 640, 360, {"r": 1.0, "dw": 0, "dh": 12})
    assert len(boxes) == 1
    assert boxes[0][0] == 0 and boxes[0][1] == 0


def test_channels_last_grid_layout_decodes():
    det = _make_det()
    # (gh, gw, 64) / (gh, gw, 1) — the ndim-3 transpose guard path
    heads = _heads(10 * 80 + 20, (8, 4, 8, 4), 0.9, batched=False)
    boxes, _, _ = det._decode_qat(heads, 640, 360, {"r": 1.0, "dw": 0, "dh": 12})
    assert len(boxes) == 1
    assert boxes[0] == [100, 40, 128, 64]


def _heads_80cls(cell: int, ltrb: tuple, conf: float, cls_idx: int) -> list:
    """6 heads with an 80-channel cls head (COCO QAT export layout)."""
    heads = []
    for stride, gh, gw in STRIDES:
        box = np.zeros((1, 64, gh, gw), dtype=np.float32)
        cls = np.full((1, 80, gh, gw), -10.0, dtype=np.float32)
        c, conf_v = (cell, conf) if stride == 8 else (0, 0.01)
        for side, val in enumerate(ltrb):
            box[0, side * 16 + int(round(val)), c // gw, c % gw] = 20.0
        cls[0, cls_idx if stride == 8 else 0, c // gw, c % gw] = np.log(conf_v / (1 - conf_v))
        heads.extend([box, cls])
    return heads


def test_decodes_80class_head_returns_class_id():
    """COCO QAT export: cls head is (1,80,gh,gw); cell argmax = class id."""
    det = _make_det()
    det._class_thresholds = {"person": 0.40, "car": 0.35}
    # car = COCO id 2 in models/yolo_classes.txt
    heads = _heads_80cls(10 * 80 + 20, (8, 4, 8, 4), 0.9, cls_idx=2)
    boxes, confs, cids = det._decode_qat(heads, 640, 360, {"r": 1.0, "dw": 0, "dh": 12})
    assert len(boxes) == 1
    assert boxes[0] == [100, 40, 128, 64]
    assert confs[0] == pytest.approx(0.9, abs=1e-3)
    assert cids == [2]


def test_decodes_80class_head_respects_per_class_threshold():
    det = _make_det()
    det._class_thresholds = {"person": 0.40, "car": 0.85}
    # car conf 0.6 < car threshold 0.85 -> dropped
    heads = _heads_80cls(10 * 80 + 20, (8, 4, 8, 4), 0.6, cls_idx=2)
    boxes, _, _ = det._decode_qat(heads, 640, 360, {"r": 1.0, "dw": 0, "dh": 12})
    assert boxes == []


def test_qat_results_filtered_by_relevant_classes():
    """COCO QAT emits all 80 classes; only relevant ones reach events."""
    det = _make_det()
    det._relevant_classes = {"person", "car", "truck", "bus", "motorcycle",
                             "bicycle", "dog", "cat", "bird", "horse"}
    r = det._filter_qat_classes([
        {"class": "car", "score": 0.9, "bbox": [1, 2, 3, 4], "class_id": 2},
        {"class": "cell phone", "score": 0.9, "bbox": [1, 2, 3, 4], "class_id": 67},
    ])
    assert [d["class"] for d in r] == ["car"]