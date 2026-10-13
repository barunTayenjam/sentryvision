#!/usr/bin/env python3
"""HumanVerifier — MediaPipe pose detector for human-presence verification.

Replaces face-only uniface (which discarded back-facing persons — 19/20
false-head in testing). Verified here: skeleton of a person exists even when
only the back or partial body is visible.

Config:
    HUMAN_VERIFIER_ENABLED    (default 1)  master switch
    HUMAN_VERIFIER_KEEP_BACK_FACING (default 1)  keep persons with no face
    HUMAN_VERIFIER_MIN_KEYPOINTS (default 3)  min pose keypoints to count as human
    HUMAN_VERIFIER_SCORE      (default 0.35) YOLO score floor when no face/pose evidence
    HUMAN_VERIFIER_NIGHT_SCORE (default 0.35) score floor during night hours
    HUMAN_VERIFIER_NIGHT_START (default 22)   night start hour, local time
    HUMAN_VERIFIER_NIGHT_END   (default 6)    night end hour, local time
"""

import os
import time
import threading
import cv2
import numpy as np

from pose_features import describe_pose


class HumanVerifier:
    def __init__(self):
        self._pose = None
        self._face_analyzer = None
        self._lock = threading.Lock()
        self.enabled = int(os.environ.get("HUMAN_VERIFIER_ENABLED", "1"))
        self.keep_back_facing = int(os.environ.get("HUMAN_VERIFIER_KEEP_BACK_FACING", "1"))
        self.min_keypoints = int(os.environ.get("HUMAN_VERIFIER_MIN_KEYPOINTS", "3"))
        self.score_floor = float(os.environ.get("HUMAN_VERIFIER_SCORE", "0.35"))
        self.night_score_floor = float(os.environ.get("HUMAN_VERIFIER_NIGHT_SCORE", "0.35"))
        self.night_start = int(os.environ.get("HUMAN_VERIFIER_NIGHT_START", "22"))
        self.night_end = int(os.environ.get("HUMAN_VERIFIER_NIGHT_END", "6"))

    def _effective_score_floor(self) -> float:
        """Night hours favor recall: IR footage scores lower and face/pose
        models see less, so the fallback floor is relaxed there."""
        hour = time.localtime().tm_hour
        if hour >= self.night_start or hour < self.night_end:
            return self.night_score_floor
        return self.score_floor

    @property
    def pts(self):
        with self._lock:
            if self._pose is None:
                try:
                    import mediapipe as mp
                    self._pose = mp.solutions.pose.Pose(
                        static_image_mode=False,
                        model_complexity=1,
                        smooth_landmarks=True,
                        min_detection_confidence=0.5,
                        min_tracking_confidence=0.5,
                    )
                except Exception:
                    self._pose = False
            return self._pose

    @property
    def face_analyzer(self):
        with self._lock:
            if self._face_analyzer is None:
                try:
                    from uniface import FaceAnalyzer
                    self._face_analyzer = FaceAnalyzer()
                except ImportError:
                    self._face_analyzer = False
            return self._face_analyzer

    def verify(self, roi: np.ndarray, yolo_score: float) -> bool:
        """Boolean wrapper around verify_detailed for backward compatibility."""
        return self.verify_detailed(roi, yolo_score)["verified"]

    def verify_detailed(self, roi: np.ndarray, yolo_score: float) -> dict:
        """Tiered human-presence check. Returns verification metadata:
        {verified, tier, keypoints, face_detected, yolo_score, roi_w, roi_h, elapsed_ms}
        tier: yolo_high | face | pose | score_floor | disabled
        """
        import time

        t0 = time.perf_counter()
        result = {
            "verified": True,
            "tier": "disabled",
            "keypoints": 0,
            "face_detected": False,
            "yolo_score": round(float(yolo_score), 4),
            "roi_w": int(roi.shape[1]) if roi is not None else 0,
            "roi_h": int(roi.shape[0]) if roi is not None else 0,
            "elapsed_ms": 0,
            # Measured, never guessed: absent landmarks report "unknown" so
            # consumers can tell "did not measure" from "measured as nothing".
            "pose": describe_pose([]),
        }

        def done(tier, verified, keypoints=0, face=False):
            result["tier"] = tier
            # Cast to native types: numpy comparisons yield np.bool_/np.int64
            # which json.dumps cannot serialize, killing the WS publish loop.
            result["verified"] = bool(verified)
            result["keypoints"] = int(keypoints)
            result["face_detected"] = bool(face)
            result["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
            return result

        if not self.enabled:
            return done("disabled", True)

        # Tier 1: High YOLO confidence → trust it completely.
        if yolo_score >= 0.9:
            return done("yolo_high", True)

        # Distant-person ROIs starve face/pose models — upscale small crops
        # to a workable height before running them.
        if roi.shape[0] > 0 and roi.shape[0] < 192:
            scale = 256.0 / roi.shape[0]
            roi = cv2.resize(
                roi,
                (max(1, int(roi.shape[1] * scale)), 256),
                interpolation=cv2.INTER_LINEAR,
            )

        # Tier 2: Face verification via uniface.
        fa = self.face_analyzer
        if fa is not False:
            try:
                if fa.analyze(roi):
                    return done("face", True, face=True)
            except Exception:
                pass

        # Tier 3: Pose keypoints via MediaPipe.
        mp = self.pts
        if mp is not False:
            rgb = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
            results = mp.process(rgb)
            if results and results.pose_landmarks:
                # MediaPipe already ran and paid for these 33 landmarks. Derive
                # stance/facing/arms from them instead of discarding them and
                # letting the enrichment layer guess from bbox geometry.
                result["pose"] = describe_pose(results.pose_landmarks.landmark)
                n = result["pose"]["keypoints"]
                if n >= self.min_keypoints or (not self.keep_back_facing and n >= 1):
                    return done("pose", True, keypoints=n)

        # Tier 4: Fallback to YOLO confidence threshold.
        # YOLO already applied NMS + class filtering, so a person score ≥ floor
        # is a real person in practice. Floor kept low (0.55) because distant/
        # back-facing persons land here after pose (kp=0) and face both fail —
        # those models "couldn't evaluate", not "found no human".
        return done("score_floor", yolo_score >= self._effective_score_floor())