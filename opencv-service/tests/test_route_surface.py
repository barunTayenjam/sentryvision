#!/usr/bin/env python3
"""
Route surface contract: the opencv Flask service exposes exactly the
endpoints the server backend consumes. Guards against dead HTTP surface
from the pre-Python-pipeline era (batch detect, HTTP motion, standalone
scene/threat analysis, face training) — live detection runs in the
rtsp_ingestion pipeline, not via these routes.

Consumers (server/src): detectionRedoRoutes.ts + relationAnalysisService.ts
(detect-objects), opencvMicroserviceClient pushDetectionConfig (api/config),
checkHealth/getStatus (health, status), eventSearchService (embed).
"""

import sys

import pytest

sys.path.insert(0, '/app')

from flask import Flask  # noqa: E402

DEAD_ROUTES = {
    '/detect-motion',
    '/detect-and-draw',
    '/recognize-faces',
    '/detect-batch',
    '/detect-batch-paths',
    '/analyze-scene',
    '/analyze-persons',
    '/analyze-threat',
    '/annotate-by-path',
    '/train-face',
    '/retrain-model',
    '/known-faces',
    '/api/rtsp/metrics',
}

LIVE_ROUTES = {
    '/detect-objects',
    '/api/config',
    '/health',
    '/status',
    '/embed',
}


def _registered_rules():
    app = Flask(__name__)
    import routes.detection as detection
    import routes.system as system
    app.register_blueprint(detection.detection_bp)
    app.register_blueprint(system.system_bp)
    try:
        import routes.face
        app.register_blueprint(routes.face.face_bp)
    except ImportError:
        pass
    return {r.rule for r in app.url_map.iter_rules()}


@pytest.fixture(scope='module')
def rules():
    return _registered_rules()


def test_live_routes_present(rules):
    missing = LIVE_ROUTES - rules
    assert not missing, f'live endpoints missing: {missing}'


def test_dead_routes_absent(rules):
    present = DEAD_ROUTES & rules
    assert not present, f'dead endpoints still registered: {present}'
