#!/usr/bin/env python3
"""
person_analyzer guesses at things it cannot know, and the guesses are harmful.

Observed output from the live pipeline, 12h of detections:

    {"facing": "back_or_side", "actions": ["side_view_or_crouching"],
     "clothing": "blue clothing", "distance": "far",
     "bodyLanguage": "suspicious", "estimatedAge": "adult (far range)"}

Three defects, all traceable to `person_analyzer.py`:

1. `_estimate_action` emitted the single conflated string
   "side_view_or_crouching" whenever a bbox was wider than 0.8 of its height, so
   a person walking past at distance was tagged as crouching.
2. `_estimate_body_language` mapped anything containing "crouching" to
   "suspicious". Combined with (1), ordinary people standing at a distance were
   flagged suspicious in security data — and this field feeds threat_detector.
3. `estimatedAge` was a lookup from camera distance (`distance_to_age`), so
   "adult (far range)" was never an age estimate at all.
4. `_estimate_facing` fell back to "back_or_side" whenever no Haar face or
   profile matched, so 100% of real detections read as back_or_side.

MediaPipe Pose already measured stance and facing for every one of these people
(see pose_features.py) and the verifier now carries it on the detection. These
tests pin that the measurements win, and that the fabricated fields are gone.
"""

import numpy as np
import pytest

import cv2 as _cv2

from person_analyzer import PersonAnalyzer

# PersonAnalyzer lazily builds Haar cascades; the host wheels ship a headless
# cv2 without CascadeClassifier. Skip rather than fail — container has it.
pytestmark = pytest.mark.skipif(
    not hasattr(_cv2, "CascadeClassifier"),
    reason="container-only: host cv2 is headless (no CascadeClassifier)",
)

FRAME_H, FRAME_W = 360, 640


@pytest.fixture
def analyzer():
    return PersonAnalyzer()


def person_det(bbox, score=0.7, pose=None):
    det = {"class": "person", "bbox": list(bbox), "score": score}
    if pose is not None:
        det["human_verification"] = {"verified": True, "pose": pose}
    return det


def frame():
    return np.full((FRAME_H, FRAME_W, 3), 128, dtype=np.uint8)


def measured(**over):
    pose = {
        "stance": "standing", "arms_raised": False, "facing": "front",
        "torso_lean_deg": 0.0, "keypoints": 17,
        "visible_landmarks": 17, "mean_visibility": 0.9,
    }
    pose.update(over)
    return pose


class TestFabricatedAgeIsGone:
    def test_no_estimated_age_is_reported(self, analyzer):
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 40, 120))])

        assert "estimatedAge" not in result["people"][0]

    def test_no_age_wording_survives_anywhere(self, analyzer):
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 40, 120))])

        blob = str(result).lower()
        for fabricated in ("adult", "child", "distant)", "estimatedage", "far range"):
            assert fabricated not in blob, f"age wording {fabricated!r} still present"


class TestBodyLanguageIsNotInvented:
    def test_a_person_standing_at_distance_is_not_suspicious(self, analyzer):
        # 40x120 in a 360px frame -> distance "far"/"very_far", the case that
        # produced bodyLanguage: "suspicious" on an ordinary bystander.
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 40, 120))])

        assert result["people"][0]["bodyLanguage"] != "suspicious"

    def test_a_wide_bbox_is_not_crouching(self, analyzer):
        # aspect 100/110 = 0.91 > 0.8, previously "side_view_or_crouching".
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 100, 110))])

        actions = result["people"][0]["actions"]
        assert "side_view_or_crouching" not in actions
        assert not any("crouching" in a for a in actions)

    def test_body_language_defaults_to_neutral_without_a_real_signal(self, analyzer):
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 100, 110))])

        assert result["people"][0]["bodyLanguage"] == "neutral"


class TestFacingIsNotGuessed:
    def test_no_back_or_side_fallback(self, analyzer):
        """Every real detection used to read back_or_side because that was the
        fallback whenever no Haar cascade matched."""
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 40, 120))])

        assert result["people"][0]["facing"] != "back_or_side"

    def test_measured_facing_wins_over_the_cascade(self, analyzer):
        result = analyzer.analyze_persons(
            frame(), [person_det((100, 50, 40, 120), pose=measured(facing="side"))]
        )

        assert result["people"][0]["facing"] == "side"

    def test_measured_stance_wins_over_bbox_geometry(self, analyzer):
        result = analyzer.analyze_persons(
            frame(),
            [person_det((100, 50, 100, 110), pose=measured(stance="crouching"))],
        )

        assert result["people"][0]["actions"] == ["crouching"]

    def test_measured_arms_raised_is_reported(self, analyzer):
        result = analyzer.analyze_persons(
            frame(), [person_det((100, 50, 40, 120), pose=measured(arms_raised=True))]
        )

        assert result["people"][0]["armsRaised"] is True

    def test_absent_measurements_stay_unknown_rather_than_guessed(self, analyzer):
        result = analyzer.analyze_persons(
            frame(), [person_det((100, 50, 40, 120), pose=measured(stance="unknown", facing="unknown"))]
        )

        person = result["people"][0]
        assert person["facing"] == "unknown"
        assert "crouching" not in person["actions"]


class TestExistingContractHolds:
    def test_field_names_are_preserved_for_downstream_consumers(self, analyzer):
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 40, 120))])

        person = result["people"][0]
        assert set(person) >= {
            "position", "description", "clothing", "clothing_colors", "actions",
            "facing", "distance", "carryingItem", "bodyLanguage", "confidence",
            "bbox_original",
        }

    def test_clothing_colour_is_still_measured(self, analyzer):
        blue = np.zeros((FRAME_H, FRAME_W, 3), dtype=np.uint8)
        blue[:, :] = (200, 60, 30)  # BGR: blue-dominant

        result = analyzer.analyze_persons(blue, [person_det((100, 50, 40, 120))])

        assert result["people"][0]["clothing_colors"]

    def test_distance_band_is_unchanged(self, analyzer):
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 40, 250))])

        assert result["people"][0]["distance"] == "close"

    def test_scene_description_still_mentions_the_person(self, analyzer):
        result = analyzer.analyze_persons(frame(), [person_det((100, 50, 40, 120))])

        assert "person" in result["sceneDescription"].lower()