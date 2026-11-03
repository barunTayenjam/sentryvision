import cv2
import numpy as np
import os
import pickle
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any, Union


class ArcFaceRecognizer:
    """
    Face recognition using InsightFace ArcFace with RetinaFace detection.

    Primary: InsightFace arcface (buffalo_s) — 512-dim embeddings, RetinaFace detection
    Fallback: OpenCV DNN face detector + HOG/CNN (face_recognition lib)
    Legacy fallback: Haar cascade + histogram matching

    Dual-mode transition: stores both 128-dim (legacy) and 512-dim (ArcFace) embeddings
    side by side during migration.
    """

    def __init__(self):
        self.known_faces_dir = os.path.join(os.path.dirname(__file__), 'known_faces')
        self.models_dir = os.path.join(os.path.dirname(__file__), 'models')
        Path(self.known_faces_dir).mkdir(parents=True, exist_ok=True)
        Path(self.models_dir).mkdir(parents=True, exist_ok=True)

        # ArcFace model state
        self._app = None
        self._model_loaded = False
        self._model_name = 'buffalo_s'
        self._embedding_dim = 512
        self._gpu_available = False

        # Fallback detection
        self.dnn_face_detector = None
        self.haar_detector = None
        self.use_face_recognition_lib = self._check_face_recognition_lib()

        # Legacy embeddings (dual-mode — 128-dim)
        self.known_encodings_128 = []
        self.known_names_128 = []
        # ArcFace embeddings (512-dim)
        self.known_encodings_512 = []
        self.known_names_512 = []
        self.is_trained = False

        self._initialize_detectors()
        self._initialize_model()
        self._load_known_faces()

    def _check_face_recognition_lib(self) -> bool:
        try:
            import face_recognition
            return True
        except ImportError:
            return False

    def _initialize_detectors(self):
        try:
            prototxt_path = os.path.join(self.models_dir, 'deploy.prototxt')
            model_path = os.path.join(self.models_dir, 'res10_300x300_ssd_iter_140000_fp16.caffemodel')
            if os.path.exists(prototxt_path) and os.path.exists(model_path):
                self.dnn_face_detector = cv2.dnn.readNetFromCaffe(prototxt_path, model_path)
        except Exception:
            self.dnn_face_detector = None

        try:
            # Prefer the bundled cascade in models/ over cv2.data (missing in container)
            cascade_path = os.path.join(self.models_dir, 'haarcascade_frontalface_default.xml')
            if not os.path.exists(cascade_path):
                cascade_path = os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml')
            if os.path.exists(cascade_path):
                self.haar_detector = cv2.CascadeClassifier(cascade_path)
                if self.haar_detector.empty():
                    self.haar_detector = None
            else:
                self.haar_detector = None
        except Exception:
            self.haar_detector = None

        # YuNet — primary detector. InsightFace det_500m downscales frames to
        # 640x640 and misses small faces; YuNet runs at native input size.
        self.yunet_detector = None
        try:
            yunet_path = os.path.join(self.models_dir, 'face_detection_yunet_2023mar.onnx')
            if os.path.exists(yunet_path):
                self.yunet_detector = cv2.FaceDetectorYN.create(
                    yunet_path, '', (320, 320), score_threshold=0.5
                )
        except Exception:
            self.yunet_detector = None

    def _initialize_model(self):
        try:
            import insightface
            from insightface.app import FaceAnalysis
            self._app = FaceAnalysis(name=self._model_name, providers=['CPUExecutionProvider'])
            self._app.prepare(ctx_id=0, det_size=(640, 640))
            self._model_loaded = True
            try:
                import onnxruntime
                if 'CUDAExecutionProvider' in onnxruntime.get_available_providers():
                    self._app = FaceAnalysis(name=self._model_name, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
                    self._app.prepare(ctx_id=0, det_size=(640, 640))
                    self._gpu_available = True
                    print(f"[ArcFace] GPU (CUDA) — model: {self._model_name}")
                else:
                    print(f"[ArcFace] CPU — model: {self._model_name}")
            except Exception:
                print(f"[ArcFace] CPU — model: {self._model_name}")
        except ImportError:
            print("[ArcFace] insightface not available — fallback mode")
            self._model_loaded = False

    def _load_known_faces(self):
        legacy_emb_path = os.path.join(self.models_dir, 'face_embeddings_improved.pkl')
        legacy_labels_path = os.path.join(self.models_dir, 'face_labels_improved.pkl')
        if os.path.exists(legacy_emb_path) and os.path.exists(legacy_labels_path):
            try:
                with open(legacy_emb_path, 'rb') as f:
                    self.known_encodings_128 = pickle.load(f)
                with open(legacy_labels_path, 'rb') as f:
                    self.known_names_128 = pickle.load(f)
            except Exception as e:
                print(f"[ArcFace] Failed to load legacy embeddings: {e}")

        arcface_emb_path = os.path.join(self.models_dir, 'face_embeddings_512.pkl')
        arcface_labels_path = os.path.join(self.models_dir, 'face_labels_512.pkl')
        if os.path.exists(arcface_emb_path) and os.path.exists(arcface_labels_path):
            try:
                with open(arcface_emb_path, 'rb') as f:
                    self.known_encodings_512 = pickle.load(f)
                with open(arcface_labels_path, 'rb') as f:
                    self.known_names_512 = pickle.load(f)
            except Exception as e:
                print(f"[ArcFace] Failed to load arcface embeddings: {e}")

        self.is_trained = bool(self.known_encodings_128 or self.known_encodings_512)

    def detect_faces(self, image: np.ndarray, method: str = 'auto') -> List[Dict[str, Any]]:
        faces = []
        if image is None or image.size == 0:
            return faces

        if method == 'auto':
            if self.yunet_detector is not None:
                try:
                    faces = self._detect_with_yunet(image)
                    if faces:
                        return faces
                except Exception as e:
                    print(f"[ArcFace] YuNet detection error: {e}")

            if self._model_loaded and self._app is not None:
                try:
                    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
                    dets = self._app.get(rgb)
                    for det in dets:
                        bbox = det.bbox.astype(int)
                        x, y, x1, y1 = bbox[0], bbox[1], bbox[2], bbox[3]
                        x, y = max(0, x), max(0, y)
                        x1, y1 = min(image.shape[1], x1), min(image.shape[0], y1)
                        faces.append({
                            'x': int(x),
                            'y': int(y),
                            'width': int(x1 - x),
                            'height': int(y1 - y),
                            'method': 'retinaface',
                            'confidence': round(float(det.det_score) * 100, 2)
                        })
                    if faces:
                        return faces
                except Exception as e:
                    print(f"[ArcFace] RetinaFace detection error: {e}")

            if self.dnn_face_detector is not None:
                return self._detect_with_dnn(image)

            if self.haar_detector is not None:
                return self._detect_with_haar(image)

        if method == 'yunet' and self.yunet_detector is not None:
            try:
                return self._detect_with_yunet(image)
            except Exception:
                return []

        if method == 'dnn' and self.dnn_face_detector is not None:
            return self._detect_with_dnn(image)

        if method == 'haar' and self.haar_detector is not None:
            return self._detect_with_haar(image)

        if method == 'retinaface' and self._model_loaded and self._app is not None:
            try:
                rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
                dets = self._app.get(rgb)
                for det in dets:
                    bbox = det.bbox.astype(int)
                    x, y, x1, y1 = bbox[0], bbox[1], bbox[2], bbox[3]
                    x, y = max(0, x), max(0, y)
                    x1, y1 = min(image.shape[1], x1), min(image.shape[0], y1)
                    faces.append({
                        'x': int(x),
                        'y': int(y),
                        'width': int(x1 - x),
                        'height': int(y1 - y),
                        'method': 'retinaface',
                        'confidence': round(float(det.det_score) * 100, 2)
                    })
            except Exception:
                pass

        return faces

    def _detect_with_yunet(self, image: np.ndarray) -> List[Dict[str, Any]]:
        """YuNet at native resolution (capped for speed); bboxes scaled back."""
        h, w = image.shape[:2]
        max_dim = 1280
        scale = 1.0
        if max(h, w) > max_dim:
            scale = max_dim / max(h, w)
            image = cv2.resize(image, (int(w * scale), int(h * scale)))
        ih, iw = image.shape[:2]
        self.yunet_detector.setInputSize((iw, ih))
        _, faces = self.yunet_detector.detect(image)
        if faces is None:
            return []
        results = []
        for f in faces:
            x, y, bw, bh = f[:4]
            score = float(f[-1])
            if scale != 1.0:
                x, y, bw, bh = x / scale, y / scale, bw / scale, bh / scale
            x, y = max(0, int(x)), max(0, int(y))
            results.append({
                'x': x,
                'y': y,
                'width': int(min(bw, w - x)),
                'height': int(min(bh, h - y)),
                'method': 'yunet',
                'confidence': round(score * 100, 2)
            })
        return results

    def _detect_with_dnn(self, image: np.ndarray) -> List[Dict[str, Any]]:
        h, w = image.shape[:2]
        blob = cv2.dnn.blobFromImage(cv2.resize(image, (300, 300)), 1.0, (300, 300), (104.0, 177.0, 123.0))
        self.dnn_face_detector.setInput(blob)
        detections = self.dnn_face_detector.forward()
        faces = []
        for i in range(detections.shape[2]):
            confidence = float(detections[0, 0, i, 2])
            if confidence > 0.15:
                box = detections[0, 0, i, 3:7] * np.array([w, h, w, h])
                x, y, x1, y1 = box.astype(int)
                x, y = max(0, x), max(0, y)
                x1, y1 = min(w, x1), min(h, y1)
                faces.append({
                    'x': int(x),
                    'y': int(y),
                    'width': int(x1 - x),
                    'height': int(y1 - y),
                    'method': 'dnn',
                    'confidence': round(confidence * 100, 2)
                })
        return faces

    def _detect_with_haar(self, image: np.ndarray) -> List[Dict[str, Any]]:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        faces_rects = self.haar_detector.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
        return [
            {'x': int(x), 'y': int(y), 'width': int(w), 'height': int(h), 'method': 'haar', 'confidence': 70.0}
            for (x, y, w, h) in faces_rects
        ]

    def extract_face_embedding(self, face_image: np.ndarray) -> Optional[np.ndarray]:
        """Extract 512-dim ArcFace embedding from a face ROI.

        Expects a tight face crop (not a full scene image).
        Falls back to the recognition model directly when the detector
        fails — this happens when crops are too small or too close-up
        for RetinaFace (det_size=640).
        """
        if self._model_loaded and self._app is not None:
            # 20px floor: below this the crop is mostly noise. Above it,
            # upscaling to the 112x112 training size recovers surveillance
            # crops (37x45px is typical at distance) — the old 48px gate
            # rejected nearly every camera face before the upscale ran.
            h, w = face_image.shape[:2]
            if h < 20 or w < 20:
                return None

            # Upscale small faces so the recognizer sees detail —
            # ArcFace buffalo_s was trained on 112x112 aligned faces.
            if h < 160 or w < 160:
                scale = max(160 / h, 160 / w)
                face_image = cv2.resize(
                    face_image,
                    (min(320, int(w * scale)), min(320, int(h * scale))),
                    interpolation=cv2.INTER_CUBIC,
                )

            try:
                rgb = cv2.cvtColor(face_image, cv2.COLOR_BGR2RGB)
                dets = self._app.get(rgb)
                if dets and len(dets) > 0:
                    norm_embedding = dets[0].embedding / np.linalg.norm(dets[0].embedding)
                    return norm_embedding.astype(np.float64)
            except Exception as e:
                print(f"[ArcFace] ArcFace detector error: {e}")

            # Direct recognition: skip detector, run recognition model on
            # the pre-cropped face. Works when RetinaFace can't detect
            # faces in tight crops (common during training / live crops).
            try:
                recog_model = self._app.models.get('recognition') or self._app.models.get('recog')
                if recog_model is not None:
                    resized = cv2.resize(face_image, (112, 112), interpolation=cv2.INTER_LINEAR)
                    rgb_direct = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
                    feat = recog_model.get_feat(rgb_direct)
                    if feat is not None and len(feat) > 0 and len(feat[0]) == self._embedding_dim:
                        emb = feat[0]
                        norm_embedding = emb / np.linalg.norm(emb)
                        return norm_embedding.astype(np.float64)
            except Exception as e:
                print(f"[ArcFace] Direct recognition error: {e}")

        if self.use_face_recognition_lib:
            try:
                import face_recognition
                rgb_face = cv2.cvtColor(face_image, cv2.COLOR_BGR2RGB)
                rgb_face = cv2.resize(rgb_face, (150, 150))
                encodings = face_recognition.face_encodings(rgb_face, num_jitters=1)
                if len(encodings) > 0:
                    return encodings[0]
            except ImportError:
                pass

        try:
            face_resized = cv2.resize(face_image, (100, 100))
            gray = cv2.cvtColor(face_resized, cv2.COLOR_BGR2GRAY)
            hist = cv2.calcHist([gray], [0], None, [32], [0, 256])
            hist = cv2.normalize(hist, hist).flatten()
            return hist
        except Exception:
            return None

    def extract_embedding_robust(self, image: np.ndarray) -> Optional[np.ndarray]:
        """Extract embedding from any image, trying multiple strategies.

        For close-up face crops, extract_face_embedding works directly.
        For full-scene images (wide shots, surveillance frames) the face
        may be too small for RetinaFace — this method resizes aggressively
        to bring small faces to a detectable size.
        """
        if self._model_loaded and self._app is None:
            return None

        # Strategy 1: direct extraction (works for face crops)
        emb = self.extract_face_embedding(image)
        if emb is not None and len(emb) == self._embedding_dim:
            return emb

        # Strategy 2: resize image to boost small-face detection
        h, w = image.shape[:2]
        target_sizes = [1024, 640]
        for target in target_sizes:
            scale = target / max(h, w)
            if scale <= 1.0:
                continue
            resized = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_LINEAR)
            rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
            try:
                dets = self._app.get(rgb)
            except Exception:
                continue
            for det in dets:
                if det.embedding is not None:
                    norm_emb = det.embedding / np.linalg.norm(det.embedding)
                    return norm_emb.astype(np.float64)

        # Strategy 3: sliding window for very large images
        if h > 800 or w > 800:
            roi_size = 640
            best_emb = None
            best_score = -1.0
            for y in range(0, max(1, h - roi_size), roi_size // 2):
                for x in range(0, max(1, w - roi_size), roi_size // 2):
                    crop = image[y:y + roi_size, x:x + roi_size]
                    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                    try:
                        dets = self._app.get(rgb)
                    except Exception:
                        continue
                    for det in dets:
                        if det.det_score > best_score and det.embedding is not None:
                            best_score = det.det_score
                            best_emb = det.embedding
            if best_emb is not None:
                norm_emb = best_emb / np.linalg.norm(best_emb)
                return norm_emb.astype(np.float64)

        return None

    def get_appearance_signature(self, person_roi: np.ndarray) -> Optional[np.ndarray]:
        """Compute appearance signature (color histogram) for person re-ID.

        Works on any person crop, even tiny ones where face fails.
        Returns normalized HSV color histogram (clothing colors, skin tones).
        """
        try:
            h, w = person_roi.shape[:2]
            upper = person_roi[0:int(h * 0.6), :]
            upper_hsv = cv2.cvtColor(upper, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([upper_hsv], [0, 1], None, [18, 24], [0, 180, 0, 256])
            hist = cv2.normalize(hist, hist).flatten()
            return hist.astype(np.float32)
        except Exception:
            return None

    def compare_appearance(self, sig1: np.ndarray, sig2: np.ndarray) -> float:
        """Compare two appearance signatures. Returns similarity [0, 1]."""
        try:
            return float(cv2.compareHist(sig1, sig2, cv2.HISTCMP_CORREL))
        except Exception:
            return 0.0

    def match_embedding(self, embedding: np.ndarray, tolerance: float = 0.6) -> Tuple[str, float]:
        """Match a pre-extracted embedding against known faces (no re-detect).

        recognize_face() re-runs the detector to obtain an embedding; when the
        caller already has one (single-pass flow), this skips that second
        RetinaFace pass.
        """
        if not self.is_trained or embedding is None:
            return "unknown", 0.0

        ref_encodings, ref_names = (
            (self.known_encodings_512, self.known_names_512)
            if len(embedding) == 512 and self.known_encodings_512
            else (self.known_encodings_128, self.known_names_128)
            if self.known_encodings_128
            else ([], [])
        )
        distances = [
            np.linalg.norm(embedding - ke)
            for ke in ref_encodings
            if len(ke) == len(embedding)
        ]
        if not distances:
            return "unknown", 0.0
        min_distance = min(distances)
        if min_distance < tolerance:
            name = ref_names[distances.index(min_distance)]
            confidence = max(0, min(100, (1.0 - min_distance / tolerance) * 100))
            return name, round(confidence, 2)
        return "unknown", 0.0

    def recognize_face(self, face_image: np.ndarray, tolerance: float = 0.6) -> Tuple[str, float]:
        if not self.is_trained:
            return "unknown", 0.0

        embedding = self.extract_face_embedding(face_image)
        if embedding is None:
            return "unknown", 0.0

        embedding_dim = len(embedding)

        # Try ArcFace 512-dim first
        if embedding_dim == 512 and self.known_encodings_512:
            distances = []
            for known_encoding in self.known_encodings_512:
                if len(known_encoding) != 512:
                    continue
                distance = np.linalg.norm(embedding - known_encoding)
                distances.append(distance)
            if distances:
                min_distance = min(distances)
                min_index = np.argmin(distances)
                if min_distance < tolerance:
                    name = self.known_names_512[min_index]
                    confidence = max(0, min(100, (1.0 - min_distance / tolerance) * 100))
                    return name, round(confidence, 2)

        # Fallback to 128-dim legacy
        if embedding_dim == 128 and self.known_encodings_128:
            distances = []
            for known_encoding in self.known_encodings_128:
                if len(known_encoding) != 128:
                    continue
                distance = np.linalg.norm(embedding - known_encoding)
                distances.append(distance)
            if distances:
                min_distance = min(distances)
                min_index = np.argmin(distances)
                if min_distance < tolerance:
                    name = self.known_names_128[min_index]
                    confidence = max(0, min(100, (1.0 - min_distance / tolerance) * 100))
                    return name, round(confidence, 2)

        # Cross-dim fallback: compare against available embeddings
        if self.known_encodings_512:
            ref_encodings = self.known_encodings_512
            ref_names = self.known_names_512
        elif self.known_encodings_128:
            ref_encodings = self.known_encodings_128
            ref_names = self.known_names_128
        else:
            return "unknown", 0.0

        distances = []
        for known_encoding in ref_encodings:
            if len(embedding) != len(known_encoding):
                continue
            distance = np.linalg.norm(embedding - known_encoding)
            distances.append(distance)

        if distances:
            min_distance = min(distances)
            min_index = np.argmin(distances)
            if min_distance < tolerance:
                name = ref_names[min_index]
                confidence = max(0, min(100, (1.0 - min_distance / tolerance) * 100))
                return name, round(confidence, 2)

        return "unknown", 0.0

    def _detect_faces(self, image: np.ndarray) -> List[Dict[str, Any]]:
        results = []
        faces = self.detect_faces(image)
        for i, face in enumerate(faces):
            x, y, w, h = face['x'], face['y'], face['width'], face['height']
            x, y = max(0, min(x, image.shape[1])), max(0, min(y, image.shape[0]))
            w, h = min(w, image.shape[1] - x), min(h, image.shape[0] - y)
            if w <= 0 or h <= 0:
                continue

            face_roi = image[y:y + h, x:x + w]
            name, confidence = self.recognize_face(face_roi)
            results.append({
                'id': f'face_{i}',
                'name': name,
                'confidence': confidence,
                'isKnown': name != 'unknown',
                'bbox': {'x': int(x), 'y': int(y), 'width': int(w), 'height': int(h)},
                'detection_method': face.get('method', 'unknown')
            })
        return results

    def train_recognizer(self) -> bool:
        try:
            arcface_faces = []
            arcface_names = []
            for person_dir in os.listdir(self.known_faces_dir):
                person_path = os.path.join(self.known_faces_dir, person_dir)
                if not os.path.isdir(person_path):
                    continue
                for image_file in os.listdir(person_path):
                    if not image_file.lower().endswith(('.png', '.jpg', '.jpeg')):
                        continue
                    image_path = os.path.join(person_path, image_file)
                    image = cv2.imread(image_path)
                    if image is None:
                        continue
                    face_detections = self.detect_faces(image)
                    # If RetinaFace finds nothing (wide shots, small faces),
                    # try the robust extractor directly on the full image —
                    # it resizes + scans ROIs to locate faces.
                    if not face_detections:
                        embedding = self.extract_embedding_robust(image)
                        if embedding is not None and len(embedding) == 512:
                            arcface_faces.append(embedding)
                            arcface_names.append(person_dir)
                        continue
                    for face in face_detections:
                        x, y, w, h = face['x'], face['y'], face['width'], face['height']
                        if w < 20 or h < 20:
                            continue
                        face_roi = image[y:y + h, x:x + w]
                        embedding = self.extract_face_embedding(face_roi)
                        if embedding is not None and len(embedding) == 512:
                            arcface_faces.append(embedding)
                            arcface_names.append(person_dir)

            if arcface_faces:
                self.known_encodings_512 = arcface_faces
                self.known_names_512 = arcface_names
                arcface_emb_path = os.path.join(self.models_dir, 'face_embeddings_512.pkl')
                arcface_labels_path = os.path.join(self.models_dir, 'face_labels_512.pkl')
                with open(arcface_emb_path, 'wb') as f:
                    pickle.dump(self.known_encodings_512, f)
                with open(arcface_labels_path, 'wb') as f:
                    pickle.dump(self.known_names_512, f)
                self.is_trained = True
                return True
            return False
        except Exception as e:
            print(f"[ArcFace] Training error: {e}")
            return False


arcface_recognizer = ArcFaceRecognizer()
