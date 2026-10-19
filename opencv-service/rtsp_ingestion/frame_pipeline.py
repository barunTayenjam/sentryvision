#!/usr/bin/env python3
"""
Per-camera frame processing pipeline.

    FFmpegReader (native main stream, up to 2K)
          │
          ├─→ resize(640x360) → JPEG → live_queue → WebSocket (always, zero-delay)
          │
          └─→ detection_queue (full-res frame)
                                             │
                                       DetectionThread:
                                             │
                                       MotionGate (MOG2, on 480x360 downsample)
                                             │  motion
                                             ▼
                                       YOLO Detection (full-res frame)
                                             ▼
                                       ByteTrack Tracking
                                             ▼
                                       Face Recognition (new tracks, identity cache TTL=30s)
                                             │
                                             ▼
                                       Full-res snapshot → event file + WebSocket Publisher

Live streaming is fully decoupled from detection — YOLO inference (1-4s on CPU)
never blocks the live frame path, eliminating stream latency.
"""

import time
import queue
import cv2
import numpy as np
import os
import hashlib
import threading
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False
    print("[FramePipeline] psutil not available, frame skipping disabled")

# Vehicle classes that receive dedicated event type with snapshots
VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "bicycle"}

from .config import (
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
    DEFAULT_FPS,
    DETECTION_FPS,
    DETECT_WIDTH,
    DETECT_HEIGHT,
    LIVE_WIDTH,
    LIVE_HEIGHT,
    MOG2_HISTORY,
    MOG2_VAR_THRESHOLD,
    MOTION_PIXEL_THRESHOLD,
    JPEG_QUALITY,
    EVENT_JPEG_QUALITY,
    INFERENCE_BACKEND,
    INFERENCE_TARGET,
    GO2RTC_RTSP_BASE,
    GO2RTC_HTTP_BASE,
)
from .queues import DropOldestQueue, DropIfFullQueue
from .ffmpeg_reader import FFmpegReader
from .websocket_publisher import WebSocketPublisher
from .byte_tracker import ByteTracker
from scene_analyzer import SceneAnalyzer
from person_analyzer import PersonAnalyzer
from threat_detector import ThreatDetector
from person_verifier import HumanVerifier
from model_selection import resolve_model_priority
from bbox_coords import align_event_bbox

try:
    import onnxruntime as _ort
except ImportError:
    _ort = None


class OrtRunner:
    """Quantized INT8 execution for QAT models, cv2.dnn fallback.

    OpenCV DNN dequantizes QDQ graphs to fp32; onnxruntime executes them
    natively quantized — 2.3x faster on this CPU host for identical boxes.
    """

    def __init__(self, model_path: str, fallback_net):
        self._session = None
        self._input_name = None
        self._fallback_net = fallback_net
        if _ort is None or not os.path.exists(model_path):
            return
        try:
            opts = _ort.SessionOptions()
            opts.intra_op_num_threads = 2
            self._session = _ort.InferenceSession(
                model_path, providers=["CPUExecutionProvider"], sess_options=opts
            )
            self._input_name = self._session.get_inputs()[0].name
        except Exception:
            self._session = None

    def is_ort(self) -> bool:
        return self._session is not None

    def forward(self, blob: np.ndarray):
        if self._session is not None:
            # These QAT exports take NCHW fp32 [1,3,384,640] — same layout as
            # the cv2.dnn blob. ponytail: if a future export wants NHWC,
            # branch on self._session.get_inputs()[0].shape[-1] == 3 here.
            return [np.asarray(o) for o in self._session.run(None, {self._input_name: blob})]
        return None


def _make_ort_runner(model_path: str) -> Optional["OrtRunner"]:
    if _ort is None:
        return None
    return OrtRunner(model_path, fallback_net=None)


class _QatAuxDetector:
    """Aux COCO-QAT InProcessYOLO for the dual chain.

    Shares QAT_ORT engine selection and decode with the primary detector.
    Vehicles/animals/cars only — persons come from the primary (v8s) so
    both detectors never double-report the same person.
    """

    def __init__(self, models_dir: str):
        self._det = InProcessYOLO(models_dir)
        # QAT_AUX=coco_qat enables the chain; the aux model file is fixed.
        self._model_name = "coco_qat_640x384"

    def initialize(self) -> bool:
        ok = self._det.initialize(preferred_model=self._model_name)
        if ok:
            print("[QatAux] aux detector initialized:", self._model_name)
        return ok

    def detect(self, frame):
        dets = self._det.detect(frame)
        return [d for d in dets if d.get("class") != "person"]


def _make_qat_aux(models_dir: str) -> Optional[_QatAuxDetector]:
    """Construct + init the aux detector, or None when disabled/missing."""
    aux = _QatAuxDetector(models_dir)
    return aux if aux.initialize() else None


class MotionGate:
    """Per-camera MOG2 background subtractor for motion gating."""

    def __init__(
        self,
        camera_id: str,
        history: int = MOG2_HISTORY,
        var_threshold: int = MOG2_VAR_THRESHOLD,
        pixel_threshold: int = MOTION_PIXEL_THRESHOLD,
    ):
        self.camera_id = camera_id
        self._bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=history,
            varThreshold=var_threshold,
            detectShadows=False,
        )
        self._pixel_threshold = pixel_threshold
        self._frame_count = 0
        self._warmup_frames = 10

    def detect(self, frame: np.ndarray) -> dict:
        self._frame_count += 1
        fg_mask = self._bg_subtractor.apply(frame)
        _, fg_mask = cv2.threshold(fg_mask, 250, 255, cv2.THRESH_BINARY)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, kernel, iterations=1)
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
        motion_pixels = cv2.countNonZero(fg_mask)
        total_pixels = fg_mask.shape[0] * fg_mask.shape[1]
        motion_percentage = (motion_pixels / total_pixels) * 100
        if self._frame_count < self._warmup_frames:
            return {"motion_detected": False, "motion_pixels": motion_pixels, "confidence": 0.0, "roi": None}
        motion_detected = motion_pixels > self._pixel_threshold
        confidence = min(100.0, motion_percentage * 10)
        roi = None
        if motion_detected:
            # Union of motion contours = the zoom region for YOLO (Frigate-
            # style crop-zoom). All contours unioned so a second mover just
            # outside the biggest blob is never cropped away. Coords are in
            # THIS frame's space (caller scales to its own frame size).
            contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            rects = [cv2.boundingRect(c) for c in contours if cv2.contourArea(c) >= 9]
            if rects:
                x0 = min(r[0] for r in rects)
                y0 = min(r[1] for r in rects)
                x1 = max(r[0] + r[2] for r in rects)
                y1 = max(r[1] + r[3] for r in rects)
                pad = int(0.2 * max(x1 - x0, y1 - y0)) + 8
                mh, mw = fg_mask.shape[:2]
                roi = [
                    max(0, x0 - pad), max(0, y0 - pad),
                    min(mw, x1 + pad) - max(0, x0 - pad),
                    min(mh, y1 + pad) - max(0, y0 - pad),
                ]
        return {"motion_detected": motion_detected, "motion_pixels": motion_pixels, "confidence": round(confidence, 2), "roi": roi}


class AdaptiveFrameProcessor:
    """Dynamically skip detection frames under high CPU load."""

    def __init__(self):
        self.cpu_threshold_high = 60
        self.cpu_threshold_low = 45
        self.skip_interval = 3
        self.frame_count = 0
        self.is_skipping = False
        self.resume_timer = 0
        # cache for non-blocking cpu usage sampling
        self._cpu_usage = 0.0
        self._cpu_sample_counter = 0
        self._cpu_sample_rate = 5  # sample every N frames


    def should_process_frame(self) -> bool:
        if not PSUTIL_AVAILABLE:
            return True

        # non-blocking sample; refresh every _cpu_sample_rate calls to keep the hot path cheap
        self._cpu_sample_counter += 1
        if self._cpu_sample_counter >= self._cpu_sample_rate:
            self._cpu_usage = psutil.cpu_percent(interval=None)
            self._cpu_sample_counter = 0

        cpu_usage = self._cpu_usage

        if cpu_usage > self.cpu_threshold_high:
            self.is_skipping = True
            self.resume_timer = 0
        elif cpu_usage < self.cpu_threshold_low:
            self.resume_timer += 1
            if self.resume_timer > 5:
                self.is_skipping = False

        if self.is_skipping:
            self.frame_count += 1
            return self.frame_count % self.skip_interval == 0

        return True


class InProcessYOLO:
    """YOLO object detector running in-process via cv2.dnn.

    Loads YOLOv8n.onnx > YOLOv5n.onnx > yolov4-tiny.
    Avoids the HTTP self-call overhead of the previous architecture.
    """

    _COCO_CLASSES: Optional[List[str]] = None

    def __init__(self, models_dir: str):
        self._models_dir = models_dir
        self._net = None
        self._model_type = None
        self._input_size = 640
        self._confidence_threshold = 0.15
        self._nms_threshold = 0.45
        # Expanded relevant classes for richer scene understanding.
        self._relevant_classes = {
            "person", "car", "truck", "bus", "motorcycle", "bicycle",
            "dog", "cat", "bird", "horse",
            "backpack", "umbrella", "handbag", "suitcase",
            "frisbee", "skateboard",
            "bottle", "cup", "cell phone",
            "chair", "couch", "potted plant", "bed", "dining table",
            "tv", "laptop", "keyboard", "mouse", "remote", "book",
            "vase", "clock", "teddy bear",
            "traffic light", "stop sign", "parking meter", "bench",
            "fire hydrant",
        }
        self._class_thresholds = {
            "person": 0.55, "car": 0.35, "truck": 0.40, "bus": 0.40,
            "motorcycle": 0.40, "bicycle": 0.40, "dog": 0.40, "cat": 0.40,
            "bird": 0.40, "horse": 0.40, "backpack": 0.40, "umbrella": 0.45,
            "handbag": 0.45, "suitcase": 0.45, "cell phone": 0.45,
            "chair": 0.45, "couch": 0.45, "potted plant": 0.50,
            "tv": 0.45, "laptop": 0.45, "book": 0.45, "clock": 0.45,
            "bowl": 0.35, "bottle": 0.45,
            "traffic light": 0.40, "stop sign": 0.40, "bench": 0.40,
        }
        self._default_threshold = 0.50
        self._min_box_area = 1500
        self._min_box_side = 35
        self._hog_supplement_enabled = os.getenv("HOG_PERSON_SUPPLEMENT", "false").strip().lower() in ("1", "true", "yes")
        self._initialized = False
        self._class_names = self._load_class_names()
        self._backend_label = 'CPU'
        self._last_inference_ms = 0.0
        self._inference_count = 0
        self._total_inference_ms = 0.0

    def _load_class_names(self) -> List[str]:
        for name in ("yolo_classes.txt", "coco.names"):
            p = os.path.join(self._models_dir, name)
            if os.path.exists(p):
                with open(p, "r") as f:
                    return [l.strip() for l in f if l.strip()]
        return ["person", "bicycle", "car", "motorcycle", "airplane", "bus",
                "train", "truck", "boat"]

    def _detect_backend(self) -> tuple:
        if INFERENCE_BACKEND == 'cpu':
            return (cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU, 'CPU')
        try:
            device_count = cv2.cuda.getCudaEnabledDeviceCount()
            if device_count > 0:
                return (cv2.dnn.DNN_BACKEND_CUDA, cv2.dnn.DNN_TARGET_CUDA, 'CUDA')
        except (AttributeError, cv2.error):
            pass
        return (cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU, 'CPU')

    def initialize(self, preferred_model: Optional[str] = None) -> bool:
        if self._initialized:
            return True

        free_memory_gb = 0
        if PSUTIL_AVAILABLE:
            free_memory_gb = psutil.virtual_memory().available / (1024**3)

        gpu_available = False
        try:
            device_count = cv2.cuda.getCudaEnabledDeviceCount()
            gpu_available = device_count > 0
        except (AttributeError, cv2.error):
            pass

        model_priority = resolve_model_priority(
            preferred_model or os.getenv("YOLO_MODEL"),
            gpu_available=gpu_available,
            free_memory_gb=free_memory_gb,
        )

        # A missing preferred model silently degrades detection (the
        # CrowdHuman-v8s outage fell back to yolov5n and evening humans
        # vanished from events). Make it impossible to miss in the logs.
        preferred_file = model_priority[0][0] if model_priority else None
        if preferred_file and not os.path.exists(os.path.join(self._models_dir, preferred_file)):
            print(
                f"[InProcessYOLO] !! REQUESTED MODEL MISSING: {preferred_file} not found in "
                f"{self._models_dir} — falling back down the chain; person recall will be degraded. "
                f"Run download_all_models.py or rebuild the image."
            )

        # A missing preferred model silently degrades detection (the
        # CrowdHuman-v8s outage fell back to yolov5n and evening persons
        # vanished from events). Make it impossible to miss in the logs.
        preferred_file = model_priority[0][0] if model_priority else None
        if preferred_file and not os.path.exists(os.path.join(self._models_dir, preferred_file)):
            print(
                f"[InProcessYOLO] !! REQUESTED MODEL MISSING: {preferred_file} not found in "
                f"{self._models_dir} — falling back down the chain; person recall will be degraded. "
                f"Run download_all_models.py or rebuild the image."
            )

        for filename, mtype in model_priority:
            if mtype == "yolov4":
                weights = os.path.join(self._models_dir, filename)
                cfg = os.path.join(self._models_dir, "yolov4-tiny.cfg")
                if os.path.exists(weights) and os.path.exists(cfg):
                    try:
                        self._net = cv2.dnn.readNet(weights, cfg)
                    except cv2.error as e:
                        print(f"[InProcessYOLO] corrupt model {filename}: {e}")
                        continue
                    self._model_type = mtype
                    backend, target, label = self._detect_backend()
                    self._net.setPreferableBackend(backend)
                    self._net.setPreferableTarget(target)
                    self._backend_label = label
                    self._initialized = True
                    print(f"[InProcessYOLO] {mtype} initialized with {label} backend (free RAM: {free_memory_gb:.1f}GB)")
                    return True
            else:
                path = os.path.join(self._models_dir, filename)
                if os.path.exists(path):
                    try:
                        self._net = cv2.dnn.readNet(path)
                    except cv2.error as e:
                        print(f"[InProcessYOLO] corrupt model {filename}: {e}")
                        continue
                    backend, target, label = self._detect_backend()
                    self._net.setPreferableBackend(backend)
                    self._net.setPreferableTarget(target)
                    self._backend_label = label
                    self._model_type = mtype
                    if mtype == "yolov8-qat":
                        # ponytail: 0.40 sits mid observed QAT confs (0.32
                        # hard/distant, 0.90 clear) — ceiling = untuned default;
                        # upgrade = calibrate on house footage (raise on ghosts,
                        # lower on misses). Persistence/aspect gates still own
                        # FP filtering downstream.
                        self._class_thresholds["person"] = float(os.getenv("YOLO_QAT_PERSON_THRESH", "0.40"))
                        # 20/600 benchmarked vs AI truth on 3115 events:
                        # recall 0.864 / F1 0.813 (compare_models_ai_truth.py).
                        # 35/1500 COCO defaults were tuned for that model's
                        # score distribution and cost QAT ~110 recalls.
                        self._min_box_side = int(os.getenv("YOLO_QAT_MIN_BOX_SIDE", "20"))
                        self._min_box_area = int(os.getenv("YOLO_QAT_MIN_BOX_AREA", "600"))
                    # INT8-native execution: onnxruntime runs QDQ models
                    # quantized (37ms v8n / 112ms v8s on this host); cv2.dnn
                    # dequantizes them to fp32 (83ms) for identical boxes.
                    # Disabled unless QAT_ORT=1 (env) — zero behaviour change.
                    self._ort_runner = None
                    if mtype == "yolov8-qat" and os.getenv("QAT_ORT", "0") == "1":
                        self._ort_runner = _make_ort_runner(path)
                    self._model_file = filename
                    self._initialized = True
                    print(f"[InProcessYOLO] {mtype} initialized with {label} backend (free RAM: {free_memory_gb:.1f}GB)")
                    return True

        return False

    _inference_lock = __import__("threading").Lock()

    def detect(self, frame: np.ndarray, roi: Optional[List[int]] = None) -> List[Dict[str, Any]]:
        if not self._initialized or self._net is None:
            return []

        # ROI zoom (Frigate-style): run on the motion region only, boxes are
        # shifted back to full-frame coords before return. A person at 8m
        # gets ~2x more input pixels than whole-frame detection gives.
        off_x = off_y = 0
        if roi is not None:
            fh, fw = frame.shape[:2]
            rx, ry, rw, rh = (int(v) for v in roi)
            rx, ry = max(0, rx), max(0, ry)
            rw, rh = min(rw, fw - rx), min(rh, fh - ry)
            if rw >= 16 and rh >= 16:
                frame = frame[ry:ry + rh, rx:rx + rw]
                off_x, off_y = rx, ry

        with self._inference_lock:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            orig_mean = np.mean(gray)
            if orig_mean < 120:
                if not hasattr(self, "_clahe_low") or self._clahe_low is None:
                    self._clahe_low = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
                clahe = self._clahe_low
                enhanced_gray = clahe.apply(gray)
                enhanced = cv2.cvtColor(enhanced_gray, cv2.COLOR_GRAY2BGR)
                frame = cv2.addWeighted(frame, 0.3, enhanced, 0.7, 0)

            h, w = frame.shape[:2]
            qat_lb = None
            if self._model_type == "yolov8-qat":
                # Letterbox (pad 114) to the model's 640x384 input. QAT
                # weights were trained on letterboxed frames — the whole-frame
                # stretch used for COCO models shifts every box.
                qat_lb = self._letterbox_qat(frame)
                blob = cv2.dnn.blobFromImage(qat_lb["canvas"], 1 / 255.0, (self.QAT_W, self.QAT_H), swapRB=True, crop=False)
            else:
                blob = cv2.dnn.blobFromImage(frame, 1 / 255.0, (self._input_size, self._input_size), swapRB=True, crop=False)
            self._net.setInput(blob)
            t_start = time.perf_counter()
            outputs = None
            runner = getattr(self, "_ort_runner", None)
            if runner is not None and runner.is_ort():
                outputs = runner.forward(blob)
            if outputs is None:
                try:
                    outputs = self._net.forward(self._net.getUnconnectedOutLayersNames()) if self._model_type in ("yolov4", "yolov8-qat") else [self._net.forward()]
                except cv2.error:
                    self._net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
                    self._net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
                    outputs = self._net.forward(self._net.getUnconnectedOutLayersNames()) if self._model_type in ("yolov4", "yolov8-qat") else [self._net.forward()]
        
        elapsed_ms = (time.perf_counter() - t_start) * 1000
        self._last_inference_ms = elapsed_ms
        self._inference_count += 1
        self._total_inference_ms += elapsed_ms
        if self._inference_count % 100 == 0:
            avg = self._total_inference_ms / self._inference_count
            print(f"[InProcessYOLO] inference={elapsed_ms:.1f}ms backend={self._backend_label} model={self._model_type} avg={avg:.1f}ms")

        boxes, confidences, class_ids = [], [], []
        if self._model_type == "yolov8-qat":
            boxes, confidences, class_ids = self._decode_qat(outputs, w, h, qat_lb)
        elif self._model_type in ("yolov8", "yolov5"):
            output = outputs[0]
            if len(output.shape) == 3 and output.shape[0] == 1:
                output = output[0]
            if self._model_type == "yolov8" and output.shape[0] < output.shape[1]:
                output = output.transpose()
            num_classes = output.shape[-1] - (4 if self._model_type == "yolov8" else 5)
            for det in output:
                if self._model_type == "yolov8":
                    scores = det[4:]
                else:
                    obj_conf = det[4]
                    scores = det[5:] * obj_conf
                cid = int(np.argmax(scores))
                conf = float(scores[cid])
                cname = self._class_names[cid] if cid < len(self._class_names) else f"obj_{cid}"
                if cname not in self._relevant_classes:
                    continue
                thresh = self._class_thresholds.get(cname, self._default_threshold)
                if conf < thresh:
                    continue
                cx, cy, bw, bh = det[0], det[1], det[2], det[3]
                sx, sy = w / self._input_size, h / self._input_size
                x = int((cx - bw / 2) * sx)
                y = int((cy - bh / 2) * sy)
                bw = int(bw * sx)
                bh = int(bh * sy)
                x, y = max(0, x), max(0, y)
                bw, bh = min(w - x, bw), min(h - y, bh)
                if bw >= self._min_box_side and bh >= self._min_box_side and bw * bh >= self._min_box_area:
                    boxes.append([x, y, bw, bh])
                    confidences.append(float(conf))
                    class_ids.append(cid)
        else:
            for out in outputs:
                for det in out:
                    obj_conf = float(det[4])
                    scores = det[5:]
                    cid = int(np.argmax(scores))
                    conf = float(scores[cid]) * obj_conf
                    cname = self._class_names[cid] if cid < len(self._class_names) else f"obj_{cid}"
                    thresh = self._class_thresholds.get(cname, self._default_threshold)
                    if conf < thresh:
                        continue
                    cx = int(det[0] * w)
                    cy = int(det[1] * h)
                    bw = int(det[2] * w)
                    bh = int(det[3] * h)
                    x = cx - bw // 2
                    y = cy - bh // 2
                    x, y = max(0, x), max(0, y)
                    bw, bh = min(w - x, bw), min(h - y, bh)
                    if bw >= self._min_box_side and bh >= self._min_box_side and bw * bh >= self._min_box_area:
                        boxes.append([x, y, bw, bh])
                        confidences.append(float(conf))
                        class_ids.append(cid)

        indices = cv2.dnn.NMSBoxes(boxes, confidences, self._confidence_threshold, self._nms_threshold)
        results = []
        if len(indices) > 0:
            for i in indices.flatten():
                cname = self._class_names[class_ids[i]] if class_ids[i] < len(self._class_names) else f"obj_{class_ids[i]}"
                results.append({
                    "bbox": [boxes[i][0], boxes[i][1], boxes[i][2], boxes[i][3]],
                    "score": round(confidences[i], 4),
                    "class": cname,
                    "class_id": class_ids[i],
                })
        if self._model_type == "yolov8-qat":
            # COCO QAT emits all 80 classes; keep only the ones events use.
            results = self._filter_qat_classes(results)

        # HOG people-detector supplement is DISABLED by default: on dim
        # (CLAHE-enhanced) frames it hallucinates static phantom "persons"
        # (fixed bboxes on bushes/shadows), and its clamped 0.99 score
        # auto-passes HumanVerifier's yolo_high tier — flooding the events
        # list with verified-looking false positives. Re-enable explicitly
        # via HOG_PERSON_SUPPLEMENT=true if night recall ever needs it.
        has_person = any(r["class"] == "person" for r in results)
        if self._hog_supplement_enabled and orig_mean < 120 and not has_person:
            hog_persons = self._hog_person_supplement(frame)
            for hp in hog_persons:
                bx, by, bw, bh = hp["bbox"]
                overlap = False
                for r in results:
                    rx, ry, rw, rh = r["bbox"]
                    ix1, iy1 = max(bx, rx), max(by, ry)
                    ix2, iy2 = min(bx + bw, rx + rw), min(by + bh, ry + rh)
                    if ix2 > ix1 and iy2 > iy1:
                        inter = (ix2 - ix1) * (iy2 - iy1)
                        union = bw * bh + rw * rh - inter
                        if union > 0 and inter / union > 0.3:
                            overlap = True
                            break
                if not overlap:
                    results.append(hp)
                    print(f"  [InProcessYOLO] HOG supplement: person at {hp['bbox']}")

        # Shift ROI-zoom boxes back to full-frame coordinates (crop bounds
        # already clamped them inside the frame, so they stay valid).
        if off_x or off_y:
            for res in results:
                res["bbox"][0] += off_x
                res["bbox"][1] += off_y
        return results

    def _filter_qat_classes(self, results: List[Dict]) -> List[Dict]:
        """Keep only classes events persist (drop toothbrushes, fridges).

        COCO QAT emits all 80 classes; the CrowdHuman export emits only
        person, so this is a no-op there.
        """
        return [r for r in results if r["class"] in self._relevant_classes]

    # CrowdHuman QAT int8 person model: 6-head DFL output, 1 class.
    QAT_W, QAT_H, QAT_PAD = 640, 384, 114

    def _letterbox_qat(self, frame):
        h, w = frame.shape[:2]
        r = min(self.QAT_W / w, self.QAT_H / h)
        nw, nh = int(round(w * r)), int(round(h * r))
        resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((self.QAT_H, self.QAT_W, 3), self.QAT_PAD, dtype=np.uint8)
        dw, dh = (self.QAT_W - nw) // 2, (self.QAT_H - nh) // 2
        canvas[dh:dh + nh, dw:dw + nw] = resized
        return {"canvas": canvas, "r": r, "dw": dw, "dh": dh}

    def _decode_qat(self, outputs, w: int, h: int, lb) -> tuple:
        """Decode 6 raw heads (box/cls pairs at strides 8/16/32) to frame boxes.

        box head = 4x16 DFL distribution. cls head = 1 person logit (sigmoid)
        for the CrowdHuman export, or C channels (argmax = class id) for the
        COCO export. Letterbox inverse applied here so callers get
        original-frame coords.
        """
        dfl_idx = np.arange(16, dtype=np.float32)
        boxes, confidences, class_ids = [], [], []
        for head, stride in enumerate((8, 16, 32)):
            box_out = np.asarray(outputs[2 * head], dtype=np.float32)
            cls_out = np.asarray(outputs[2 * head + 1], dtype=np.float32)
            if box_out.ndim == 4:
                box_out = box_out[0]
            if cls_out.ndim == 4:
                cls_out = cls_out[0]
            if box_out.shape[0] != 64 and box_out.shape[-1] == 64:
                box_out = box_out.transpose(2, 0, 1)
            if cls_out.shape[0] != 1 and cls_out.shape[-1] == 1:
                cls_out = cls_out.transpose(2, 0, 1)
            _, gh, gw = box_out.shape
            n_cls = cls_out.shape[0]
            dist = box_out.reshape(4, 16, gh * gw).transpose(2, 0, 1)
            e = np.exp(dist - dist.max(-1, keepdims=True))
            ltrb = (e / e.sum(-1, keepdims=True)) @ dfl_idx  # (HW, 4) grid units
            ys, xs = np.mgrid[0:gh, 0:gw].astype(np.float32)
            ax = (xs + 0.5).reshape(-1)
            ay = (ys + 0.5).reshape(-1)
            if n_cls == 1:
                # CrowdHuman single-person-logit export.
                conf = 1.0 / (1.0 + np.exp(-cls_out.reshape(-1)))
                best_cls = np.zeros(gh * gw, dtype=np.int64)
                cls_thresh = np.full(gh * gw, self._class_thresholds.get("person", self._default_threshold), dtype=np.float32)
            else:
                # COCO export: per-cell argmax over class logits (sigmoid).
                probs = 1.0 / (1.0 + np.exp(-cls_out.reshape(n_cls, -1)))
                best_cls = probs.argmax(0)
                conf = probs.max(0)
                thr_by_id = {
                    self._class_names.index(name): thr
                    for name, thr in self._class_thresholds.items()
                    if name in self._class_names
                }
                cls_thresh = np.array(
                    [thr_by_id.get(int(c), self._default_threshold) for c in best_cls],
                    dtype=np.float32,
                )
            keep = np.nonzero(conf > cls_thresh)[0]
            if keep.size == 0:
                continue
            x1 = np.clip(((ax[keep] - ltrb[keep, 0]) * stride - lb["dw"]) / lb["r"], 0, w)
            y1 = np.clip(((ay[keep] - ltrb[keep, 1]) * stride - lb["dh"]) / lb["r"], 0, h)
            x2 = np.clip(((ax[keep] + ltrb[keep, 2]) * stride - lb["dw"]) / lb["r"], 0, w)
            y2 = np.clip(((ay[keep] + ltrb[keep, 3]) * stride - lb["dh"]) / lb["r"], 0, h)
            for k in range(keep.size):
                bx, by = int(x1[k]), int(y1[k])
                bw, bh = int(x2[k] - x1[k]), int(y2[k] - y1[k])
                if bw >= self._min_box_side and bh >= self._min_box_side and bw * bh >= self._min_box_area:
                    boxes.append([bx, by, bw, bh])
                    confidences.append(float(conf[keep[k]]))
                    class_ids.append(int(best_cls[keep[k]]))
        return boxes, confidences, class_ids

    def _hog_person_supplement(self, frame: np.ndarray) -> List[Dict]:
        results = []
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if not hasattr(self, "_clahe_hog") or self._clahe_hog is None:
                self._clahe_hog = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            clahe = self._clahe_hog
            enhanced = clahe.apply(gray)

            hog = cv2.HOGDescriptor()
            hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

            for scale, stride in [(1.05, 8), (1.03, 4)]:
                rects, weights = hog.detectMultiScale(
                    enhanced, winStride=(stride, stride),
                    padding=(8, 8), scale=scale,
                )
                for (x, y, w, h), weight in zip(rects, weights):
                    score = min(0.99, max(0.15, float(weight)))
                    if score >= 0.60:
                        results.append({
                            "bbox": [int(x), int(y), int(w), int(h)],
                            "score": round(score, 4),
                            "class": "person",
                            "class_id": 0,
                        })

            deduped = []
            for r in results:
                bx, by, bw, bh = r["bbox"]
                dup = False
                for d in deduped:
                    dx, dy, dw, dh = d["bbox"]
                    ix, iy = max(bx, dx), max(by, dy)
                    ix2, iy2 = min(bx + bw, dx + dw), min(by + bh, dy + dh)
                    if ix2 > ix and iy2 > iy:
                        inter = (ix2 - ix) * (iy2 - iy)
                        union = bw * bh + dw * dh - inter
                        if union > 0 and inter / union > 0.5:
                            dup = True
                            break
                if not dup:
                    deduped.append(r)
            return deduped
        except Exception as e:
            print(f"[InProcessYOLO] HOG error: {e}")
            return []

    def get_metrics(self) -> dict:
        return {
            'backend': self._backend_label,
            'model_type': self._model_type,
            'model_file': getattr(self, '_model_file', None),
            'last_inference_ms': round(self._last_inference_ms, 1),
            'inference_count': self._inference_count,
            'avg_inference_ms': round(self._total_inference_ms / max(1, self._inference_count), 1),
        }


class IdentityCache:
    """TTL-based cache mapping track_id → identity.

    Prevents repeated face-recognition work on already-identified tracks.
    TTL = 30 seconds per ADR-003.
    """

    def __init__(self, ttl: float = 30.0):
        self._ttl = ttl
        self._store: Dict[int, tuple] = {}

    def get(self, track_id: int) -> Optional[Dict[str, Any]]:
        entry = self._store.get(track_id)
        if entry is None:
            return None
        identity, ts = entry
        if time.time() - ts > self._ttl:
            del self._store[track_id]
            return None
        return identity

    def put(self, track_id: int, identity: Dict[str, Any]) -> None:
        self._store[track_id] = (identity, time.time())

    def invalidate(self, track_id: int) -> None:
        self._store.pop(track_id, None)

    def cleanup(self) -> None:
        now = time.time()
        expired = [k for k, (_, ts) in self._store.items() if now - ts > self._ttl]
        for k in expired:
            del self._store[k]


class FramePipeline:
    """Per-camera pipeline with decoupled live streaming and detection.

    Architecture:
        FFmpegReader (native main stream, up to 2K)
              │
              ├─→ resize(640x360) → JPEG → live_queue → WebSocket (always, zero-delay)
              │
              └─→ detection_queue (full-res frame)
                                                     │
                                               DetectionThread:
                                                     │
                                               MotionGate (MOG2, on 480x360 downsample)
                                                     │  motion
                                                     ▼
                                               YOLO Detection (full-res frame)
                                                     ▼
                                               ByteTrack
                                                     ▼
                                               Face Recognition
                                                     ▼
                                               event_queue → WebSocket
    """

    _yolo_detector: Optional[InProcessYOLO] = None
    _aux_detector = None  # dual-chain COCO-QAT aux (vehicles/animals)
    _yolo_init_lock = __import__("threading").Lock()
    # 0 disables the recheck on bare-instance test objects (no __init__ call).
    _recheck_max_area: int = 0

    def __init__(
        self,
        camera_config: dict,
        publisher: WebSocketPublisher,
        frame_skip: int = 1,
    ):
        self._config = camera_config
        self._publisher = publisher
        self._frame_skip = frame_skip
        self._frame_counter = 0
        self._camera_id: str = camera_config["id"]

        self._live_queue: DropOldestQueue = publisher.add_frame_queue(self._camera_id)
        self._event_queue: DropOldestQueue = publisher.add_event_queue(self._camera_id)
        self._detection_queue: queue.Queue = queue.Queue(maxsize=2)

        self._motion_gate = MotionGate(camera_id=self._camera_id, pixel_threshold=MOTION_PIXEL_THRESHOLD)
        # max_time_lost must span the YOLO throttle gap: update() runs at
        # DETECTION_FPS but YOLO only fires every YOLO_MIN_INTERVAL_MS (2s),
        # so a person missed on ONE run gets 4 empty updates/sec. The old
        # track_buffer=30 → max_time_lost=4 ≈ 1s removed the track before
        # the next sighting, reset tracklet_len, and the PERSON_MIN_TRACK_HITS
        # gate never opened for short visits. 240 → 32 updates ≈ 8s.
        self._tracker = ByteTracker(
            track_thresh=0.25,
            match_thresh=0.8,
            track_buffer=int(os.getenv("TRACK_BUFFER_FRAMES", "240")),
            frame_rate=DETECTION_FPS,
        )
        self._identity_cache = IdentityCache(ttl=30.0)
        self._snapshotted_tracks: set = set()
        # Snapshot path per track: reattached to every subsequent WS event so
        # Node's filePath-based persistence gate survives a dropped message.
        self._snapshot_paths: dict = {}
        # Pixel size of that snapshot per track, needed to publish bboxes in
        # the image's coordinate space rather than the detect frame's.
        self._snapshot_dims: dict = {}
        # Verification verdict cache: (frame_seen, verdict) per track.
        # MediaPipe pose + face CNN are the expensive tiers of HumanVerifier;
        # re-running them on the same track every frame is wasted work, so a
        # pass is reused for 10 frames and a fail re-checked after 4 (the
        # bbox grows as a person walks closer, so fails must be retried).
        self._verify_cache: dict = {}
        self._person_attrs_cache: dict = {}
        self._person_attrs_ttl = float(os.getenv("PERSON_ATTRS_TTL", "5.0"))
        self._yolo_min_interval = float(os.getenv("YOLO_MIN_INTERVAL_MS", "2000")) / 1000.0
        self._last_yolo_time = 0.0
        self._yolo_max_input_width = int(os.getenv("YOLO_MAX_INPUT_WIDTH", "1280"))
        self._person_min_hits = int(os.getenv("PERSON_MIN_TRACK_HITS", "3"))
        self._person_min_conf = float(os.getenv("PERSON_MIN_CONFIDENCE", "0.55"))
        self._vehicle_min_hits = int(os.getenv("VEHICLE_MIN_TRACK_HITS", "3"))
        self._vehicle_min_conf = float(os.getenv("VEHICLE_MIN_CONFIDENCE", "0.45"))
        # Motion-only tracks (no class, no person/vehicle) are the common case
        # — a dog, a falling branch, a car pulling in. They carry no YOLO
        # confidence floor, so the snapshot gate below is what keeps them from
        # writing a JPEG every frame and flooding the events page with
        # near-duplicate stills. Defaults match the person/vehicle gates.
        self._motion_min_hits = int(os.getenv("MOTION_MIN_TRACK_HITS", "3"))
        self._motion_min_conf = float(os.getenv("MOTION_MIN_CONFIDENCE", "0.45"))
        self._recheck_max_area = int(os.getenv("YOLO_RECHECK_MAX_AREA", "5000"))
        self._recheck_cache: dict[int, tuple[int, bool]] = {}
        self._face_recognition_fn = None
        self._scene_analyzer = SceneAnalyzer()
        self._scene_analysis_interval = 60
        self._scene_frame_counter = 0
        self._last_scene_context = {}
        self._person_analyzer = PersonAnalyzer()
        self._threat_detector = ThreatDetector()
        self._threat_detector.set_camera_config(camera_config)
        self._last_threat: Dict[str, Any] = {}
        self._adaptive_frame_processor = AdaptiveFrameProcessor()

        live_cfg = self._config.get("live", {})
        self._live_width = live_cfg.get("width", LIVE_WIDTH)
        self._live_height = live_cfg.get("height", LIVE_HEIGHT)

        detect_cfg = self._config.get("detect", {})
        self._detect_width = detect_cfg.get("width", DETECT_WIDTH)
        self._detect_height = detect_cfg.get("height", DETECT_HEIGHT)

        # Single reader on the go2rtc-internal low stream (720p H.264).
        # The TP-Link cameras allow only ONE RTSP connection, which go2rtc
        # holds and re-streams internally — so we must stay inside go2rtc.
        # Detection runs at the low stream's native size (1280x720 via
        # go2rtc.yaml h264_low — YOLO accuracy is pixel-bound) and the live
        # preview is downscaled to LIVE_WIDTHxLIVE_HEIGHT inside
        # _on_live_frame, so reading the low stream (instead of native 2K)
        # still saves ~10x decode/pipe cost. A fixed output size is
        # required because the reader reads raw fixed-size frames off a
        # pipe; if the source resolution changed mid-stream the byte
        # stream would desync.
        self._live_reader = FFmpegReader(
            rtsp_url=f"{GO2RTC_RTSP_BASE}/{self._camera_id}_low",
            camera_id=self._camera_id,
            width=detect_cfg.get("width", DEFAULT_WIDTH),
            height=detect_cfg.get("height", DEFAULT_HEIGHT),
            fps=max(live_cfg.get("fps", DEFAULT_FPS), detect_cfg.get("fps", DEFAULT_FPS)),
            scale=False,
        )
        # Reader runs at live fps; detection consumes at detect.fps (time-based
        # throttle) so MOG2 history/tracker cadence stay as configured.
        self._detect_interval = 1.0 / max(detect_cfg.get("fps", DEFAULT_FPS), 0.5)
        self._last_detect_enqueue = 0.0

        self._detection_thread: Optional[threading.Thread] = None
        self._running = False

        self._init_yolo()

    @classmethod
    def _init_yolo(cls):
        with cls._yolo_init_lock:
            if cls._yolo_detector is not None:
                return
            models_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
            detector = InProcessYOLO(models_dir)
            ok = detector.initialize()
            if ok:
                cls._yolo_detector = detector
                print("[FramePipeline] In-process YOLO detector initialized")
                cls._aux_detector = None
                if os.getenv("QAT_AUX", "none") == "coco_qat":
                    cls._aux_detector = _make_qat_aux(models_dir)
            else:
                print("[FramePipeline] WARNING: No YOLO model could be loaded")

    def _confirm_small_person(self, roi: "np.ndarray") -> bool:
        """Re-run YOLO on an upscaled ROI crop.
        Returns True if a person is still detected at any confidence.
        Small, low-res boxes on the 640x360 feed can hallucinate (e.g. dog
        at 0.77); at 6x upscale the box vanishes while real humans survive.
        """
        scale = max(300 / max(roi.shape[0], roi.shape[1]), 1.0)
        up = cv2.resize(roi, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        dets = self._yolo_detector.detect(up)
        return any(d.get("class") == "person" for d in dets)

    def set_face_recognition(self, fn):
        self._face_recognition_fn = fn

    def _get_primary_stream(self) -> dict:
        streams = self._config.get("streams", [])
        for s in streams:
            if "detect" in s.get("roles", []):
                return s
        for s in streams:
            if "live" in s.get("roles", []):
                return s
        return streams[0] if streams else {}

    def _get_stream_by_role(self, role: str) -> Optional[dict]:
        streams = self._config.get("streams", [])
        for s in streams:
            if role in s.get("roles", []):
                return s
        return None

    @property
    def camera_id(self) -> str:
        return self._camera_id

    def start(self) -> None:
        self._running = True
        self._detection_thread = threading.Thread(
            target=self._detection_loop,
            name=f"detect-{self._camera_id}",
            daemon=True,
        )
        self._detection_thread.start()
        self._live_reader.log_fn = self._queue_pipeline_log
        self._live_reader.start(self._on_live_frame)
        print(f"[FramePipeline:{self._camera_id}] Started (main native + live preview {self._live_width}x{self._live_height})")
        self._queue_pipeline_log(
            "info", "FramePipeline",
            f"Pipeline started (live {self._live_width}x{self._live_height}, detect {self._detect_width}x{self._detect_height})",
        )

    def start_live(self) -> None:
        pass

    def stop_live(self) -> None:
        pass


    def stop(self) -> None:
        self._running = False
        self._live_reader.stop()
        if self._detection_thread:
            self._detection_thread.join(timeout=5)
        print(f"[FramePipeline:{self._camera_id}] Stopped")
        self._queue_pipeline_log("info", "FramePipeline", "Pipeline stopped")

    def _queue_pipeline_log(self, level: str, module: str, message: str, **meta) -> None:
        try:
            self._publisher.queue_log(level, module, message, camera_id=self._camera_id, **meta)
        except Exception:
            pass

    def _on_live_frame(self, frame_data: dict) -> None:
        self._frame_counter += 1
        frame: np.ndarray = frame_data["data"]

        if self._frame_counter % self._frame_skip == 0:
            # skip encode entirely when nobody is subscribed to this camera's live stream
            if self._publisher._subscriptions.get(self._camera_id):
                live = cv2.resize(frame, (self._live_width, self._live_height), interpolation=cv2.INTER_AREA)
                success, jpeg_buf = cv2.imencode(".jpg", live, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                if success:
                    self._live_queue.put(jpeg_buf.tobytes())

        now = frame_data.get("timestamp") or time.time()
        if now - self._last_detect_enqueue >= self._detect_interval:
            self._last_detect_enqueue = now
            try:
                self._detection_queue.put_nowait(frame)
            except queue.Full:
                pass

    def _detection_loop(self) -> None:
        print(f"[FramePipeline:{self._camera_id}] Detection thread started")
        frame_count = 0
        while self._running:
            try:
                frame = self._detection_queue.get(timeout=1.0)
            except queue.Empty:
                continue

            frame_count += 1
            if frame_count <= 5 or frame_count % 100 == 0:
                print(f"[FramePipeline:{self._camera_id}] Detection frame #{frame_count}, queue={self._detection_queue.qsize()}")

            try:
                self._process_detection(frame)
            except Exception as e:
                print(f"[FramePipeline:{self._camera_id}] Detection error: {e}")
                import traceback
                traceback.print_exc()

    def _apply_camera_filters(self, detections):
        objects_cfg = self._config.get("objects", {})
        track_classes = objects_cfg.get("track", [])
        filters = objects_cfg.get("filters", {})
        filtered = []
        for det in detections:
            cname = det.get("class")
            if track_classes and cname not in track_classes:
                continue
            f = filters.get(cname, {}) if cname else {}
            thresh = f.get("threshold")
            if thresh is not None and det.get("score", 0) < thresh:
                continue
            min_area = f.get("minArea", 0)
            bbox = det.get("bbox", [0, 0, 0, 0])
            area = bbox[2] * bbox[3] if isinstance(bbox, (list, tuple)) and len(bbox) == 4 else 0
            if min_area and area < min_area:
                continue
            filtered.append(det)
        return filtered

    def _process_detection(self, frame: np.ndarray) -> None:
        if not self._adaptive_frame_processor.should_process_frame():
            return

        small = cv2.resize(frame, (self._detect_width, self._detect_height), interpolation=cv2.INTER_AREA)
        motion_result = self._motion_gate.detect(small)
        self._detect_frame_count = getattr(self, '_detect_frame_count', 0) + 1
        if self._detect_frame_count <= 10 or self._detect_frame_count % 100 == 0:
            print(f"[FramePipeline:{self._camera_id}] MOG2 check #{self._detect_frame_count}: motion={motion_result['motion_detected']} pixels={motion_result['motion_pixels']} confidence={motion_result['confidence']}")

        if not motion_result["motion_detected"]:
            # Still age tracks out — without this, a motion drought freezes
            # track_ended forever and IdentityCache entries leak.
            self._tracker.update([])
            return

        now_ts = time.time()
        if now_ts - self._last_yolo_time < self._yolo_min_interval:
            return
        self._last_yolo_time = now_ts

        print(f"[FramePipeline:{self._camera_id}] MOTION DETECTED — running YOLO")
        roi_frame = motion_result.get("roi")
        if roi_frame:
            # MotionGate works on `small`; rescale its roi to full-frame px.
            sx = frame.shape[1] / max(small.shape[1], 1)
            sy = frame.shape[0] / max(small.shape[0], 1)
            roi_frame = [roi_frame[0] * sx, roi_frame[1] * sy,
                         roi_frame[2] * sx, roi_frame[3] * sy]
        raw_detections = self._run_detection(frame, roi=roi_frame)
        if raw_detections:
            for det in raw_detections:
                b = det.get("bbox", [0, 0, 0, 0])
                area = b[2] * b[3] if isinstance(b, (list, tuple)) and len(b) == 4 else 0
                print(
                    f"[FramePipeline:{self._camera_id}] raw det: {det.get('class')} "
                    f"score={det.get('score', 0):.2f} bbox={[int(v) for v in b]} area={int(area)}"
                )
        detections = self._apply_camera_filters(raw_detections)
        if not detections:
            print(f"[FramePipeline:{self._camera_id}] YOLO returned 0 detections after camera filters")
            # Still age tracks out — filters can drop all detections.
            self._tracker.update([])
            return

        self._scene_frame_counter += 1
        if self._scene_frame_counter % self._scene_analysis_interval == 0:
            self._last_scene_context = self._scene_analyzer.analyze(frame, detections)
            print(f"[FramePipeline:{self._camera_id}] Scene: {self._last_scene_context['scene_context']}")
            # Periodic cleanup: remove expired identity cache entries to bound memory growth.
            self._identity_cache.cleanup()

        print(f"[FramePipeline:{self._camera_id}] YOLO: {len(detections)} detections: {[d['class'] for d in detections]}")
        tracked = self._tracker.update(detections)
        events = self._enrich_with_identity(tracked, frame)

        person_attrs = []
        for ev in events:
            if ev.get("class") == "person" and ev.get("clothing"):
                person_attrs.append(ev)

        threat = self._threat_detector.assess(
            detections=tracked,
            scene_context=self._last_scene_context.get("scene_context", {}),
            person_attributes=person_attrs,
            camera_id=self._camera_id,
            frame=frame,
        )
        self._last_threat = threat

        if events:
            small_h, small_w = small.shape[:2]
            motion_stats = {
                "motion_pixels": int(motion_result.get("motion_pixels", 0)),
                "motion_percentage": round(
                    motion_result.get("motion_pixels", 0) / max(small_w * small_h, 1) * 100, 2
                ),
                "confidence": round(float(motion_result.get("confidence", 0)), 2),
            }
            for ev in events:
                ev["scene_context"] = self._last_scene_context.get("scene_context", {})
                ev["detection_summary"] = self._last_scene_context.get("detection_summary", {})
                ev["threat_assessment"] = threat
                ev["motion_stats"] = motion_stats
            if threat["level"] != "low":
                print(f"[FramePipeline:{self._camera_id}] THREAT: {threat['level']} ({threat['confidence']}%) — {threat['reasoning'][:100]}")
            print(f"[FramePipeline:{self._camera_id}] {len(detections)} detections → {len(tracked)} tracked → {len(events)} events")
        # YOLO ran on the low detect stream (go2rtc h264_low), the snapshot
        # is written from the full-res grab. Publish the bbox in the image's coordinate space
        # so the events page can scale it straight onto the rendered picture.
        detect_size = (frame.shape[1], frame.shape[0])
        for ev in events:
            align_event_bbox(ev, detect_size, self._snapshot_dims)
            self._event_queue.put(ev)

    def _run_detection(self, frame: np.ndarray, roi: Optional[List[int]] = None) -> List[Dict[str, Any]]:
        if self._yolo_detector is None:
            return []
        off_x = off_y = 0
        src = frame
        if roi is not None:
            fh, fw = frame.shape[:2]
            rx, ry, rw, rh = (int(v) for v in roi)
            rx, ry = max(0, rx), max(0, ry)
            rw, rh = min(rw, fw - rx), min(rh, fh - ry)
            if rw >= 16 and rh >= 16:
                src = frame[ry:ry + rh, rx:rx + rw]
                off_x, off_y = rx, ry
        h, w = src.shape[:2]
        max_w = self._yolo_max_input_width
        if max_w and w > max_w:
            scale = max_w / w
            inference_frame = cv2.resize(src, (max_w, max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
        else:
            scale = 1.0
            inference_frame = src
        detections = self._yolo_detector.detect(inference_frame)
        aux = getattr(self, "_aux_detector", None)
        if aux is not None:
            # Dual chain: aux (COCO QAT) adds vehicles/animals on the same
            # inference frame; rescale + ROI shift below apply to both.
            detections = detections + aux.detect(inference_frame)
        if scale != 1.0:
            inv = 1.0 / scale
            for det in detections:
                det["bbox"] = [int(det["bbox"][0] * inv), int(det["bbox"][1] * inv),
                               int(det["bbox"][2] * inv), int(det["bbox"][3] * inv)]
        if off_x or off_y:
            for det in detections:
                det["bbox"][0] += off_x
                det["bbox"][1] += off_y
        return detections

    def get_yolo_metrics(self) -> dict:
        if self._yolo_detector is None:
            return {}
        return self._yolo_detector.get_metrics()

    _uniface_analyzer = None
    _uniface_init_lock = __import__("threading").Lock()

    @classmethod
    def _get_uniface(cls):
        """Singleton FaceAnalyzer — model load is expensive, never per-call."""
        with cls._uniface_init_lock:
            if cls._uniface_analyzer is None:
                from uniface import FaceAnalyzer
                cls._uniface_analyzer = FaceAnalyzer()
            return cls._uniface_analyzer

    _human_verifier = None
    _human_verifier_init_lock = __import__("threading").Lock()

    @classmethod
    def _get_human_verifier(cls):
        with cls._human_verifier_init_lock:
            if cls._human_verifier is None:
                cls._human_verifier = HumanVerifier()
            return cls._human_verifier

    def _grab_fullres_frame(self) -> Optional[np.ndarray]:
        """Grab one full-res frame from the go2rtc main stream via its HTTP API.

        Used for person snapshots: 2304x1296 gives ~3.6x more pixels than
        detect stream, making faces identifiable (60px+ vs 13-44px).

        /api/frame.jpeg serves the latest keyframe from go2rtc's internal
        buffer: no ffprobe, no subprocess, no RTSP reconnect per event, and
        no fixed-size pipe reads that desync when resolutions shift. Latency
        (~1-2s) is go2rtc waiting for the next keyframe — same as ffmpeg
        startup, minus all the failure modes.

        Called once per person track (a few events/hour), so no impact on
        the continuous pipeline.
        """
        try:
            import urllib.request
            url = f"{GO2RTC_HTTP_BASE}/api/frame.jpeg?src={self._camera_id}"
            t0 = time.time()
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = resp.read()
            dt = time.time() - t0
            if not data:
                print(f"[FramePipeline:{self._camera_id}] Full-res grab empty response")
                return None
            buf = np.frombuffer(data, dtype=np.uint8)
            frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if frame is not None:
                h, w = frame.shape[:2]
                print(f"[FramePipeline:{self._camera_id}] Full-res grab {w}x{h} in {dt:.1f}s")
                return frame
            print(f"[FramePipeline:{self._camera_id}] Full-res grab JPEG decode failed")
            return None
        except Exception as e:
            print(f"[FramePipeline:{self._camera_id}] Full-res grab error: {e}")
            return None

    def _save_snapshot(self, track_id, frame, fullres_frame=None):
        """Save a full-resolution event snapshot; returns container path or None.

        For person events, grabs a full-res frame from the go2rtc main stream
        so faces are identifiable (3.6x more pixels than the detect stream).
        Falls back to the low-res frame if the grab fails.

        If fullres_frame is provided (pre-grabbed by the caller), it is used
        directly — avoiding a second ffprobe+ffmpeg pull for face recognition.
        """
        try:
            # Use pre-grabbed full-res if available, otherwise try a fresh grab.
            if fullres_frame is not None:
                save_frame = fullres_frame
            elif os.getenv("FULLRES_SNAPSHOTS", "1") == "1":
                _tmp = self._grab_fullres_frame()
                save_frame = _tmp if _tmp is not None else frame
            else:
                save_frame = frame

            detections_dir = os.getenv("DETECTIONS_DIR", "/app/data/detections")
            now = datetime.now(timezone.utc)
            ts = now.strftime("%Y-%m-%dT%H-%M-%S-") + f"{now.microsecond // 1000:03d}Z"
            filename = f"motion_{self._camera_id}_{ts}_t{track_id}.jpg"
            subdir = os.path.join(detections_dir, now.strftime("%Y-%m"), "events", "motion")
            os.makedirs(subdir, exist_ok=True)
            filepath = os.path.join(subdir, filename)
            ok, buf = cv2.imencode(".jpg", save_frame, [cv2.IMWRITE_JPEG_QUALITY, EVENT_JPEG_QUALITY])
            if ok:
                with open(filepath, "wb") as f:
                    f.write(buf.tobytes())
                self._snapshot_dims[track_id] = (save_frame.shape[1], save_frame.shape[0])
                return filepath
        except Exception as e:
            import traceback
            print(f"[FramePipeline:{self._camera_id}] Snapshot save failed: {e}")
            traceback.print_exc()
        return None

    def _enrich_with_identity(self, tracked: List[Dict], frame: np.ndarray) -> List[Dict]:
        results = []
        for obj in tracked:
            if obj.get("event") == "track_ended":
                self._identity_cache.invalidate(obj["track_id"])
                self._snapshotted_tracks.discard(obj["track_id"])
                self._snapshot_paths.pop(obj["track_id"], None)
                self._snapshot_dims.pop(obj["track_id"], None)
                self._verify_cache.pop(obj["track_id"], None)
                self._person_attrs_cache.pop(obj["track_id"], None)
                results.append(obj)
                continue
            tid = obj["track_id"]
            bbox = obj.get("bbox", [0, 0, 0, 0])
            if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                x, y, w_b, h_b = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
            else:
                x, y, w_b, h_b = 0, 0, 0, 0

            # --- HUMAN VERIFICATION ---
            # MediaPipe pose keypoints + face check (HumanVerifier) with
            # structured metadata: tier, keypoint count, latency — persisted
            # by Node into human_verifications for tuning/analytics.
            # Every person track is verified (no size bypass) and the
            # full-res snapshot is written only after verification passes,
            # so unverified persons leave no event row and no image.
            if obj.get("class") == "person":
                # ByteTracker can emit negative/zero width or height (smoothing
                # overshoot near frame edges). Normalize to a valid rect so the
                # ROI crop is non-empty and verification can actually run.
                rx, ry = x, y
                rw, rh = w_b, h_b
                if rw < 0:
                    rx, rw = x + w_b, -w_b
                if rh < 0:
                    ry, rh = y + h_b, -h_b
                rx, ry = max(0, rx), max(0, ry)
                rw, rh = max(1, min(rw, frame.shape[1] - rx)), max(1, min(rh, frame.shape[0] - ry))
                person_roi = frame[ry:ry + rh, rx:rx + rw]
                if person_roi.size <= 0:
                    self._queue_pipeline_log(
                        "warn",
                        "HumanVerifier",
                        f"Discarded person track {tid} with degenerate ROI (bbox={x},{y},{w_b},{h_b})",
                        track_id=tid,
                    )
                    continue
                # Upscaled recheck for small boxes. YOLO on the 640x360 feed
                # called a 68x50 black dog a person at 0.77 and that became a
                # false "person" event. Re-running on a blown-up crop of the
                # same pixels: the dog yields nothing, while all confirmed
                # humans (0.73-0.85) survive and score higher.
                if rw * rh < self._recheck_max_area:
                    cached_r = self._recheck_cache.get(tid)
                    if cached_r is not None and self._frame_counter < cached_r[0]:
                        confirmed = cached_r[1]
                    else:
                        confirmed = self._confirm_small_person(person_roi)
                        self._recheck_cache[tid] = (self._frame_counter + 10, confirmed)
                    if not confirmed:
                        self._queue_pipeline_log(
                            "warn",
                            "HumanVerifier",
                            f"Small box {rw}x{rh} failed upscaled person recheck — "
                            f"discarding track {tid} (score={obj.get('score', 0):.2f})",
                            track_id=tid,
                        )
                        self._verify_cache.pop(tid, None)
                        continue
                cached_v = self._verify_cache.get(tid)
                if cached_v is not None and self._frame_counter < cached_v[0]:
                    verdict = cached_v[1]
                else:
                    verdict = self._get_human_verifier().verify_detailed(
                        person_roi, yolo_score=obj.get("score", 0)
                    )
                    self._verify_cache[tid] = (
                        self._frame_counter + (10 if verdict["verified"] else 4),
                        verdict,
                    )
                verdict["track_id"] = tid
                if verdict["verified"]:
                    obj["human_verified"] = True
                    obj["human_verification"] = verdict
                    # Snapshot gate mirrors Node's persistence gates
                    # (PERSON_MIN_TRACK_HITS / PERSON_MIN_CONFIDENCE) so files
                    # are only written for events Node will actually persist.
                    # The full-res grab is shared: one ffmpeg pull serves both
                    # the snapshot file and HD face recognition.
                    gate_hits = obj.get("tracklet_len", 0) >= self._person_min_hits
                    gate_conf = obj.get("score", 0) >= self._person_min_conf
                    gate_once = tid not in self._snapshotted_tracks
                    if (
                        gate_hits
                        and gate_conf
                        and gate_once
                    ):
                        print(f"[FramePipeline:{self._camera_id}] Snapshot gate OPEN t{tid} (len={obj.get('tracklet_len')}, score={obj.get('score', 0):.2f}, face_fn={self._face_recognition_fn is not None})")
                        fullres = self._grab_fullres_frame()
                        snap = self._save_snapshot(tid, frame, fullres_frame=fullres)
                        if snap:
                            self._snapshotted_tracks.add(tid)
                            self._snapshot_paths[tid] = snap
                        # HD face recognition: faces on the detect stream are
                        # still too small for ArcFace. The main
                        # stream (2304x1296) gives ~3.6x more pixels, making
                        # faces identifiable. Scale bbox detect→full-res coords
                        # and recognize on the high-res person crop.
                        if fullres is not None and self._face_recognition_fn:
                            try:
                                det_h, det_w = frame.shape[:2]
                                full_h, full_w = fullres.shape[:2]
                                sx, sy = full_w / det_w, full_h / det_h
                                # Expand the bbox ~40% so the person (who moved
                                # ~1.6s between detect frame and fullres grab)
                                # is still inside the crop; ArcFace detects the
                                # face within the person crop itself.
                                pad_x, pad_y = int(w_b * sx * 0.4), int(h_b * sy * 0.4)
                                fx = max(0, int(x * sx) - pad_x)
                                fy = max(0, int(y * sy) - pad_y)
                                fx2 = min(full_w, int((x + w_b) * sx) + pad_x)
                                fy2 = min(full_h, int((y + h_b) * sy) + pad_y)
                                crop = fullres[fy:fy2, fx:fx2]
                                if crop.size > 0:
                                    res = self._face_recognition_fn(crop)
                                    if isinstance(res, (tuple, list)) and len(res) >= 2:
                                        name, conf = res[0], res[1]
                                        emb = res[2] if len(res) >= 3 else None
                                        self._identity_cache.put(
                                            tid, {"name": name, "confidence": conf}
                                        )
                                        obj["identity"] = name
                                        obj["identity_confidence"] = conf
                                        if emb is not None:
                                            obj["face_embedding"] = [float(v) for v in emb]
                                        print(
                                            f"[FramePipeline:{self._camera_id}] "
                                            f"HD face recog t{tid}: {name} ({conf:.1f}%)"
                                        )
                            except Exception as e:
                                print(f"[FramePipeline:{self._camera_id}] HD face recog error: {e}")
                    # Reattach so Node's filePath gate survives dropped messages
                    if tid in self._snapshot_paths:
                        obj["file_path"] = self._snapshot_paths[tid]
                else:
                    print(f"[FramePipeline] Discarding false positive person: {tid} (tier={verdict['tier']}, score={verdict['yolo_score']})")
                    self._queue_pipeline_log(
                        "warn",
                        "HumanVerifier",
                        f"Discarded unverified person track {tid} (tier={verdict['tier']}, score={verdict['yolo_score']}, kp={verdict['keypoints']})",
                        track_id=tid,
                        verification=verdict,
                    )
                    continue
            # ---------------------------

            # --- VEHICLE SNAPSHOT ---
            # Vehicles get their own event type with full-res snapshot; same
            # once-per-track gate as persons but keyed to vehicle thresholds.
            if obj.get("class") in VEHICLE_CLASSES:
                if (
                    obj.get("tracklet_len", 0) >= self._vehicle_min_hits
                    and obj.get("score", 0) >= self._vehicle_min_conf
                    and tid not in self._snapshotted_tracks
                ):
                    snap = self._save_snapshot(tid, frame)
                    if snap:
                        self._snapshotted_tracks.add(tid)
                        self._snapshot_paths[tid] = snap
                # Reattach cached snapshot path
                if tid in self._snapshot_paths:
                    obj["file_path"] = self._snapshot_paths[tid]
            # ------------------------

            # --- MOTION SNAPSHOT ---
            # All other tracked classes (dog, cat, bird, …) persist in Node as
            # `motion` events. Without a snapshot those rows carry file_path
            # NULL and the events page renders "No image" for every one of
            # them. Same once-per-track gate, keyed to motion thresholds.
            # Persons are excluded: they are snapshotted by the verification
            # gate above, which only fires once a track is confirmed human.
            elif obj.get("class") != "person":
                if (
                    obj.get("tracklet_len", 0) >= self._motion_min_hits
                    and obj.get("score", 0) >= self._motion_min_conf
                    and tid not in self._snapshotted_tracks
                ):
                    snap = self._save_snapshot(tid, frame)
                    if snap:
                        self._snapshotted_tracks.add(tid)
                        self._snapshot_paths[tid] = snap
                # Reattach cached snapshot path
                if tid in self._snapshot_paths:
                    obj["file_path"] = self._snapshot_paths[tid]
            # ------------------------

            if obj.get("event") == "track_started" and self._face_recognition_fn and w_b > 20 and h_b > 20:
                cached = self._identity_cache.get(tid)
                if cached:
                    obj["identity"] = cached.get("name")
                    obj["identity_confidence"] = cached.get("confidence", 0)

            if obj.get("class") == "person" and w_b > 20 and h_b > 20:
                cached_attrs = self._person_attrs_cache.get(tid)
                if cached_attrs is None or time.time() - cached_attrs[0] > self._person_attrs_ttl:
                    try:
                        person_roi = frame[max(0, y):min(frame.shape[0], y + h_b), max(0, x):min(frame.shape[1], x + w_b)]
                        if person_roi.size > 0:
                            analysis = self._person_analyzer.analyze_persons(frame, [obj])
                            if analysis["people"]:
                                cached_attrs = (time.time(), analysis["people"][0])
                                self._person_attrs_cache[tid] = cached_attrs
                    except Exception:
                        pass
                if cached_attrs is not None:
                    attrs = cached_attrs[1]
                    obj["person_attributes"] = attrs
                    obj["clothing"] = attrs.get("clothing", "unknown")
                    obj["clothing_colors"] = attrs.get("clothing_colors", [])
                    obj["facing"] = attrs.get("facing", "unknown")
                    obj["distance"] = attrs.get("distance", "unknown")
                    obj["carrying_item"] = attrs.get("carryingItem", "none")
                    obj["body_language"] = attrs.get("bodyLanguage", "neutral")

            elif obj.get("identity") is None:
                cached = self._identity_cache.get(tid)
                if cached:
                    obj["identity"] = cached.get("name")
                    obj["identity_confidence"] = cached.get("confidence", 0)
            results.append(obj)
        return results
