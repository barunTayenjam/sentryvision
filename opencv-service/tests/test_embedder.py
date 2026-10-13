"""MiniLM embedder tests.

Skips when the ONNX model files are absent (constrained hosts, CI without
model downloads) — production degrades to the hash fallback in that case.
"""

import math
import os

import pytest

MODELS_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')
MODEL_PATH = os.path.join(MODELS_DIR, 'minilm_l6_int8.onnx')
TOKENIZER_PATH = os.path.join(MODELS_DIR, 'minilm_tokenizer.json')

pytestmark = pytest.mark.skipif(
    not (os.path.exists(MODEL_PATH) and os.path.exists(TOKENIZER_PATH)),
    reason='MiniLM ONNX model not downloaded',
)


@pytest.fixture(scope='module')
def embedder():
    from embedder import MiniLMEmbedder

    e = MiniLMEmbedder(MODEL_PATH, TOKENIZER_PATH)
    e.load()
    return e


def test_dimension_is_384(embedder):
    vec = embedder.embed('person walking to the front door')
    assert len(vec) == 384


def test_unit_normalized(embedder):
    vec = embedder.embed('red car parked in the driveway')
    norm = math.sqrt(sum(v * v for v in vec))
    assert abs(norm - 1.0) < 0.01


def test_deterministic(embedder):
    a = embedder.embed('dog in the yard')
    b = embedder.embed('dog in the yard')
    assert a == b


def test_similar_text_beats_dissimilar(embedder):
    """Core quality gate: cosine(text, paraphrase) > cosine(text, unrelated)."""

    def cos(a, b):
        return sum(x * y for x, y in zip(a, b))

    base = embedder.embed('a person standing at the front gate')
    similar = embedder.embed('someone waiting by the entrance gate')
    unrelated = embedder.embed('quarterly financial report spreadsheet numbers')

    assert cos(base, similar) > cos(base, unrelated)
