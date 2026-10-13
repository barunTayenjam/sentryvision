import pytest

from relation_analyzer import filter_relations, validate_detections


class FakeTriplet:
    def __init__(self, subject_idx, object_idx, predicate, score, subject_label=None, object_label=None):
        self.subject_idx = subject_idx
        self.object_idx = object_idx
        self.predicate = predicate
        self.score = score
        self.subject_label = subject_label
        self.object_label = object_label


DETECTIONS = [
    {"bbox": {"x": 100, "y": 200, "width": 300, "height": 400}, "class": "person"},
    {"bbox": {"x": 500, "y": 100, "width": 100, "height": 200}, "class": "person"},
    {"bbox": {"x": 0, "y": 0, "width": -3.2, "height": 362.8}, "class": "bicycle"},
    {"bbox": {"x": 2000, "y": 2000, "width": 500, "height": 500}, "class": "car"},
    {"bbox": {"x": 10, "y": 10, "width": 2, "height": 2}, "class": "cat"},
]


def test_validate_detections_clamps_and_drops_degenerate():
    kept = validate_detections(DETECTIONS, 1920, 1080)
    indices = [orig_index for orig_index, _, _ in kept]

    assert indices == [0, 1]
    boxes = {orig: box for orig, box, _ in kept}
    assert boxes[0] == [100.0, 200.0, 400.0, 600.0]
    assert boxes[1] == [500.0, 100.0, 600.0, 300.0]


def test_validate_detections_caps_at_max_boxes():
    many = [{"bbox": {"x": i * 100, "y": 0, "width": 50, "height": 50}, "class": "person"} for i in range(20)]
    kept = validate_detections(many, 4000, 2000)
    assert len(kept) == 10


def test_validate_detections_handles_malformed_entries():
    malformed = [{"bbox": None}, {"class": "person"}, {"bbox": {"x": "bad"}}, DETECTIONS[0], DETECTIONS[1]]
    kept = validate_detections(malformed, 1920, 1080)
    assert [orig for orig, _, _ in kept] == [3, 4]


def test_filter_relations_threshold_and_index_mapping():
    kept = validate_detections(DETECTIONS, 1920, 1080)
    raw = [
        FakeTriplet(0, 1, "looking at", 0.68, "person", "person"),
        FakeTriplet(1, 0, "near", 0.15),
        FakeTriplet(5, 0, "out of range", 0.9),
        FakeTriplet(0, 1, "carrying", 0.5, "person", "person"),
    ]

    relations = filter_relations(raw, kept, threshold=0.3)

    assert [(r["subjectIndex"], r["objectIndex"], r["score"]) for r in relations] == [
        (0, 1, 0.68),
        (0, 1, 0.5),
    ]
    assert relations[0]["predicate"] == "looking at"


def test_filter_relations_falls_back_to_kept_labels_and_sorts():
    kept = validate_detections(DETECTIONS, 1920, 1080)
    raw = [
        FakeTriplet(1, 0, "near", 0.75),
        FakeTriplet(0, 1, "near", 0.8),
    ]

    relations = filter_relations(raw, kept, threshold=0.3)

    assert [r["subject"] for r in relations] == ["person", "person"]
    assert [r["object"] for r in relations] == ["person", "person"]
    assert [r["score"] for r in relations] == [0.8, 0.75]


def test_filter_relations_skips_malformed_triplets():
    kept = validate_detections(DETECTIONS, 1920, 1080)
    raw = [FakeTriplet(0, 1, "near", "not-a-number"), None, FakeTriplet(0, 1, "near", 0.9)]

    relations = filter_relations(raw, kept, threshold=0.3)

    assert len(relations) == 1
    assert relations[0]["score"] == 0.9


def test_validate_detections_accepts_stored_track_payload():
    stored = [
        {
            "bbox": {"x": 1210.32, "y": 897.12, "width": 511.92, "height": 395.28},
            "class": "person",
            "trackState": "tracked",
        },
        {
            "bbox": {"x": 980.64, "y": 339.84, "width": 206.28, "height": 579.24},
            "class": "person",
            "trackState": "tracked",
        },
    ]
    kept = validate_detections(stored, 2304, 1296)
    assert len(kept) == 2
    assert kept[0][1] == [1210.32, 897.12, 1722.24, 1292.4]


def test_merge_scene_boxes_nms_and_tracked_priority():
    from relation_analyzer import merge_scene_boxes

    tracked = [{"x": 100, "y": 200, "width": 300, "height": 400, "class": "person"}]
    scene = [
        {"x": 105, "y": 205, "width": 290, "height": 390, "class": "person", "confidence": 0.9},
        {"x": 1200, "y": 300, "width": 400, "height": 500, "class": "water tank", "confidence": 0.8},
        {"x": 1230, "y": 320, "width": 380, "height": 460, "class": "water tank", "confidence": 0.6},
        {"x": 1800, "y": 200, "width": 300, "height": 400, "class": "bicycle", "confidence": 0.7},
        {"x": 0, "y": 0, "width": 0, "height": 0, "class": "rock", "confidence": 0.95},
    ]

    merged = merge_scene_boxes(tracked, scene)

    assert [b["class"] for b in merged] == ["person", "water tank", "bicycle"]
    assert merged[0]["x"] == 100


def test_merge_scene_boxes_caps_at_max():
    from relation_analyzer import merge_scene_boxes

    tracked = [{"x": i * 500, "y": 0, "width": 100, "height": 100, "class": "person"} for i in range(12)]
    merged = merge_scene_boxes(tracked, [])
    assert len(merged) == 10


def test_dominant_color_naming():
    from relation_analyzer import dominant_color_name

    assert dominant_color_name((10, 10, 12)) == "black"
    assert dominant_color_name((250, 250, 250)) == "white"
    assert dominant_color_name((120, 120, 125)) == "gray"
    assert dominant_color_name((200, 30, 30)) == "red"
    assert dominant_color_name((30, 30, 200)) == "blue"
    assert dominant_color_name((30, 160, 60)) == "green"
    assert dominant_color_name((120, 80, 40)) == "brown"
    assert dominant_color_name((230, 200, 40)) == "yellow"


def test_box_color_on_synthetic_image():
    from PIL import Image
    from relation_analyzer import box_color

    img = Image.new("RGB", (100, 100), (20, 60, 220))
    assert box_color(img, [10, 10, 90, 90]) == "blue"
    img2 = Image.new("RGB", (100, 100), (240, 240, 240))
    assert box_color(img2, [0, 0, 100, 100]) == "white"
