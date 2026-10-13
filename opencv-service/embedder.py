"""MiniLM text embedder — all-MiniLM-L6-v2 ONNX, 384-dim sentence vectors.

Loads the quantized ONNX export (Xenova/all-MiniLM-L6-v2) plus its
tokenizer.json and produces unit-normalized 384-dim embeddings. Used by
`/embed` for semantic event search; the hash fallback in the route covers
hosts without the model files.
"""

import os

import numpy as np

MODELS_DIR = os.path.join(os.path.dirname(__file__), 'models')
DEFAULT_MODEL_PATH = os.path.join(MODELS_DIR, 'minilm_l6_int8.onnx')
DEFAULT_TOKENIZER_PATH = os.path.join(MODELS_DIR, 'minilm_tokenizer.json')

MAX_TOKENS = 256  # MiniLM context window


class MiniLMEmbedder:
    def __init__(self, model_path: str = DEFAULT_MODEL_PATH, tokenizer_path: str = DEFAULT_TOKENIZER_PATH):
        self._model_path = model_path
        self._tokenizer_path = tokenizer_path
        self._session = None
        self._tokenizer = None
        self._input_names: list[str] = []

    @property
    def loaded(self) -> bool:
        return self._session is not None and self._tokenizer is not None

    def load(self) -> None:
        if self.loaded:
            return
        import onnxruntime
        from tokenizers import Tokenizer

        opts = onnxruntime.SessionOptions()
        opts.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = 2
        self._session = onnxruntime.InferenceSession(self._model_path, sess_options=opts)
        self._input_names = [i.name for i in self._session.get_inputs()]
        self._tokenizer = Tokenizer.from_file(self._tokenizer_path)
        self._tokenizer.no_padding()
        self._tokenizer.enable_truncation(max_length=MAX_TOKENS)

    def embed(self, text: str) -> list[float]:
        """Return a unit-normalized 384-dim vector for `text` (mean-pooled)."""
        if not self.loaded:
            self.load()

        encoded = self._tokenizer.encode(text)
        input_ids = np.array([encoded.ids], dtype=np.int64)
        attention_mask = np.array([encoded.attention_mask], dtype=np.int64)
        token_type_ids = np.zeros_like(input_ids)

        feeds = {
            'input_ids': input_ids,
            'attention_mask': attention_mask,
            'token_type_ids': token_type_ids,
        }
        feeds = {k: v for k, v in feeds.items() if k in self._input_names}

        output = self._session.run(None, feeds)[0]  # (1, seq_len, 384)

        # Mean pooling over real tokens (ignore padding positions).
        mask = attention_mask[:, :, None].astype(np.float32)
        summed = (output * mask).sum(axis=1)
        counts = np.clip(mask.sum(axis=1), 1e-9, None)
        mean_pooled = summed / counts

        norm = np.linalg.norm(mean_pooled, axis=1, keepdims=True)
        normalized = mean_pooled / np.clip(norm, 1e-9, None)
        return [round(float(v), 6) for v in normalized[0]]


_singleton: MiniLMEmbedder | None = None


def get_embedder() -> MiniLMEmbedder:
    """Lazily loaded process-wide embedder (first /embed call pays the load)."""
    global _singleton
    if _singleton is None:
        _singleton = MiniLMEmbedder()
    return _singleton
