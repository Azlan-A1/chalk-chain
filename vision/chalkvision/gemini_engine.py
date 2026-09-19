"""Gemini vision engine (works on the free tier): same question and answer shape as the others."""
from __future__ import annotations

import base64
import os

from google import genai
from google.genai import types
from PIL import Image

from .reading import BoardReading, jpeg_b64, prompt

MODEL = os.environ.get("CHALK_GEMINI_MODEL", "gemini-3.8-flash")
# Gemini 3 thinking level; set CHALK_GEMINI_THINKING="" for models without it.
THINKING = os.environ.get("CHALK_GEMINI_THINKING", "low")
MAX_SIDE = 2048

_client: genai.Client | None = None


def api_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")


def client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=api_key(), http_options=types.HttpOptions(timeout=75_000))
    return _client


def read_board(img: Image.Image, candidates: list[str]) -> BoardReading:
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=BoardReading,
        thinking_config=types.ThinkingConfig(thinking_level=THINKING) if THINKING else None,
    )
    response = client().models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=base64.b64decode(jpeg_b64(img, MAX_SIDE)), mime_type="image/jpeg"),
            prompt(candidates),
        ],
        config=config,
    )
    parsed = response.parsed
    if not isinstance(parsed, BoardReading):  # blocked, empty or malformed
        raise RuntimeError(f"vision model gave no reading ({response.prompt_feedback or 'no parsed output'})")
    return parsed
