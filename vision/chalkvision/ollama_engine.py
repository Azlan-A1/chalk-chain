"""Local vision engine through Ollama: free, offline, no API key.

Enabled by setting CHALK_OLLAMA_MODEL (e.g. qwen2.5vl:7b) after `ollama pull`.
"""
from __future__ import annotations

import os

import httpx
from PIL import Image

from .reading import BoardReading, jpeg_b64, prompt

URL = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MAX_SIDE = 1536


def model() -> str | None:
    return os.environ.get("CHALK_OLLAMA_MODEL") or None


def read_board(img: Image.Image, candidates: list[str]) -> BoardReading:
    response = httpx.post(
        f"{URL}/api/chat",
        json={
            "model": model(),
            "stream": False,
            "format": BoardReading.model_json_schema(),  # Ollama structured output
            "options": {"temperature": 0},
            "keep_alive": "30m",  # keep the model loaded between check-ins
            "messages": [{"role": "user", "content": prompt(candidates), "images": [jpeg_b64(img, MAX_SIDE)]}],
        },
        timeout=120.0,  # the first call loads the model into memory
    )
    response.raise_for_status()
    return BoardReading.model_validate_json(response.json()["message"]["content"])
