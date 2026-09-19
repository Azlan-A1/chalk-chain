"""Local vision engine through Ollama: free, offline, no API key.

Enabled by setting CHALK_OLLAMA_MODEL (e.g. qwen2.5vl:7b) after `ollama pull`.
"""
from __future__ import annotations

import logging
import os

import httpx
from PIL import Image

from .reading import PROMPT, BoardReading, jpeg_b64

log = logging.getLogger("chalkvision")

URL = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MAX_SIDE = 1792  # smaller loses distant or cursive handwriting; costs ~1 s
NUM_PREDICT = 250  # a long constrained answer can crash the runner; the schema caps words too
TRIES = 2


def model() -> str | None:
    return os.environ.get("CHALK_OLLAMA_MODEL") or None


def read_board(img: Image.Image) -> BoardReading:
    body = {
        "model": model(),
        "stream": False,
        "format": BoardReading.model_json_schema(),  # Ollama structured output
        "options": {"temperature": 0, "num_predict": NUM_PREDICT},
        "keep_alive": "30m",  # keep the model loaded between check-ins
        "messages": [{"role": "user", "content": PROMPT, "images": [jpeg_b64(img, MAX_SIDE)]}],
    }
    last: Exception | None = None
    for attempt in range(TRIES):
        try:
            # The first call loads the model into memory.
            response = httpx.post(f"{URL}/api/chat", json=body, timeout=120.0)
            response.raise_for_status()
            return BoardReading.model_validate_json(response.json()["message"]["content"])
        except Exception as e:  # noqa: BLE001 - the local runner occasionally dies mid-answer
            last = e
            log.warning("ollama attempt %d/%d failed: %s", attempt + 1, TRIES, e)
    raise RuntimeError(f"ollama failed after {TRIES} attempts: {last}")
