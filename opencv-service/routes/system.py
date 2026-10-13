from flask import Blueprint, jsonify, request
from datetime import datetime
import os

import state
from scene_analyzer import SceneAnalyzer

system_bp = Blueprint('system', __name__)


@system_bp.route('/api/rtsp/metrics', methods=['GET'])
def rtsp_metrics():
    if state._rtsp_service is None:
        return jsonify({'status': 'not_started'})
    try:
        return jsonify(state._rtsp_service.get_metrics_snapshot())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@system_bp.route('/health')
def health():
    model_type = 'YOLO'
    model_name = 'yolov8s'
    if state.detector and state.detector.model_type:
        model_name = f"yolov8{state.detector.model_type}" if state.detector.model_type in ('s', 'n', 'm') else state.detector.model_type
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'service': 'opencv-detection',
        'version': os.getenv('SERVICE_VERSION', '1.0.0'),
        'detectionMode': 'yolo',
        'model': {
            'type': model_type,
            'name': model_name,
            'initialized': state.detector.initialized if state.detector else False,
            'classCount': len(state.class_names) if state.class_names else 0
        },
        'sceneAnalysis': True,
        'personAnalysis': True,
        'threatDetection': True,
        'endpoints': [
            'POST /detect-objects',
            'POST /detect-motion',
            'POST /detect-and-draw',
            'POST /recognize-faces',
            'POST /detect-batch',
            'POST /analyze-scene',
            'POST /analyze-persons',
            'POST /analyze-threat',
            'GET /health',
            'GET /status',
        ],
        'cache': {
            'type': 'memory',
            'connected': True
        }
    })


@system_bp.route('/status')
def status():
    return jsonify({
        'status': 'ready',
        'initialized': state.detector.initialized,
        'service': 'opencv-detection',
        'detectionMode': 'yolo',
        'classNames': len(state.class_names)
    })


@system_bp.route('/embed', methods=['POST'])
def embed():
    """Text embedding endpoint for semantic search.

    384-dim all-MiniLM-L6-v2 ONNX vectors; deterministic hash fallback when
    the model files are absent (constrained hosts).
    """
    body = request.get_json(silent=True) or {}
    text = (body.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'text parameter required'}), 400

    try:
        from embedder import get_embedder

        embedder = get_embedder()
        if not embedder.loaded:
            embedder.load()
        return jsonify({'embedding': embedder.embed(text), 'dim': 384, 'model': 'minilm-l6-v2'})
    except Exception as e:
        # Hash fallback — stable per text, uncalibrated semantics.
        import hashlib
        import math

        seed = int(hashlib.sha256(text.encode('utf-8')).hexdigest()[:8], 16)
        vec = []
        norm_sq = 0.0
        for i in range(384):
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            val = (seed / 0x7FFFFFFF) * 2.0 - 1.0
            vec.append(val)
            norm_sq += val * val

        norm = math.sqrt(norm_sq) or 1.0
        normalized = [round(v / norm, 6) for v in vec]

        return jsonify({'embedding': normalized, 'dim': 384, 'model': 'hash-fallback'})
