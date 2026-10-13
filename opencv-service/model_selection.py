#!/usr/bin/env python3
"""Detection model selection.

`yolov8m.onnx` (104MB) has been sitting on disk unused: the chain in
`frame_pipeline.py` always started at `yolov8n.onnx` (12MB) and only reached the
medium model if nano *and* small both failed to load. Accuracy was never a
selection criterion.

This resolves the load order instead, so the model is a deliberate choice
(`YOLO_MODEL`) rather than an accident of file ordering. A preference is a
prioritisation, not a hard requirement — the chain still reaches a working model
if the requested file is missing or unloadable.

Measured on this host (CPU, 640x640, 12 cores, 2 cameras at <=1 inference/sec):

    yolov8n.onnx    47ms avg /  57ms p95      <- kept as default
    yolov8s.onnx   105ms avg / 112ms p95
    yolov8m.onnx   280ms avg / 322ms p95

**A bigger model is not an upgrade here, and the default should stay nano.**
Benchmarked over labelled frames (ghosts = parked jeep/motorcycle in an empty
courtyard; people = a visible human):

    model  ghost scores      person scores        ghost bbox h/w
    n      0.40, 0.30        0.72 0.13 0.74 0.67  0.93, 0.94
    s      0.73, 0.61        0.77 0.53 0.83 0.85  0.98, 0.95
    m      0.48, 0.59        0.82 0.25 0.87 0.84  1.85, 2.00

1. Score still does not separate: yolov8s scores the ghost at 0.73, *above* two
   real people (0.53, 0.68). So the earlier hope that better weights would make a
   higher confidence floor honest does not hold on this footage.
2. Bbox aspect ratio separates cleanly instead — ghosts stay square (0.93-0.98),
   real people are tall (1.6-2.7). yolov8m actively erases this by giving the
   ghost a tall box (h/w 1.85-2.00) for 6x the latency.

The working discriminator is the persistence gate in detectionPersistence.ts, not
model size or score. This knob exists so the experiment is reproducible, not
because the larger models help.

Pure module: no cv2, no model loading, no I/O.
"""

AVAILABLE_MODELS = {
    "yolov8m.onnx": "yolov8",
    "yolov8s.onnx": "yolov8",
    "yolov8n.onnx": "yolov8",
    "yolov5n.onnx": "yolov5",
    "yolov4-tiny.weights": "yolov4",
    # CrowdHuman-trained 1-class person detector, INT8 QAT (640x384, 16:9
    # friendly — no square-letterbox waste). Opt-in via YOLO_MODEL:
    # bigger-COCO models were benchmarked useless here (see docstring), but
    # person-specialised weights are a different axis: better recall on
    # people, zero classes lost that this pipeline actually alerts on.
    "crowdhuman_qat_640x384.onnx": "yolov8-qat",
    # Same QAT family, v8s backbone (11.5MB): opt-in accuracy variant at
    # ~3x v8n latency (112ms ORT vs 37ms). Same 640x384 input and decode.
    "crowdhuman_v8s_qat_640x384.onnx": "yolov8-qat",
    # COCO-trained QAT (3.5MB, 80 classes): restores vehicles/animals at
    # ~37ms ORT. Person recall TBD vs crowdhuman — benchmark before choosing.
    "coco_qat_640x384.onnx": "yolov8-qat",
}

_GPU_CHAIN = ["yolov8n.onnx", "yolov8s.onnx", "yolov8m.onnx", "yolov5n.onnx"]
_MEMORY_CHAIN = ["yolov8n.onnx", "yolov5n.onnx"]
_LOW_MEMORY_CHAIN = ["yolov5n.onnx", "yolov4-tiny.weights"]


def _default_chain(gpu_available: bool, free_memory_gb: float):
    if gpu_available:
        return _GPU_CHAIN
    if free_memory_gb > 2.0:
        return _MEMORY_CHAIN
    return _LOW_MEMORY_CHAIN


def _normalise(preferred):
    if not preferred:
        return None
    name = str(preferred).strip().lower()
    if not name:
        return None
    if name in AVAILABLE_MODELS:
        return name
    # Accept bare family names like "yolov8m" or "yolov8".
    for candidate in AVAILABLE_MODELS:
        if candidate.startswith(name):
            return candidate
    return None


def resolve_model_priority(preferred=None, gpu_available: bool = False, free_memory_gb: float = 8.0):
    """Return an ordered list of (filename, model_type) load attempts.

    Args:
        preferred: requested model — a filename or family prefix, case
            insensitive. Unrecognised values are ignored.
        gpu_available: CUDA device present.
        free_memory_gb: system memory available to the detector.

    Returns:
        list[tuple[str, str]], deduplicated, never empty.
    """
    chain = list(_default_chain(gpu_available, free_memory_gb))

    chosen = _normalise(preferred)
    if chosen:
        chain.insert(0, chosen)

    ordered = []
    for name in chain:
        if name in AVAILABLE_MODELS and name not in [n for n, _ in ordered]:
            ordered.append((name, AVAILABLE_MODELS[name]))
    return ordered