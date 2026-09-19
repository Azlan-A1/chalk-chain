"""OpenAI vision engine: the same question and answer shape as the Claude engine."""
from __future__ import annotations

import os

from openai import OpenAI
from PIL import Image

from .reading import BoardReading, jpeg_b64, prompt

MODEL = os.environ.get("CHALK_OPENAI_MODEL", "gpt-5.5")
# Reasoning effort for reasoning models; set CHALK_OPENAI_EFFORT="" for models without it.
EFFORT = os.environ.get("CHALK_OPENAI_EFFORT", "low")
MAX_SIDE = 2048

_client: OpenAI | None = None


def client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(timeout=75.0, max_retries=1)
    return _client


def read_board(img: Image.Image, candidates: list[str]) -> BoardReading:
    extra = {"reasoning": {"effort": EFFORT}} if EFFORT else {}
    response = client().responses.parse(
        model=MODEL,
        input=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_image",
                        "image_url": f"data:image/jpeg;base64,{jpeg_b64(img, MAX_SIDE)}",
                        "detail": "high",  # chalk words can be small in a class photo
                    },
                    {"type": "input_text", "text": prompt(candidates)},
                ],
            }
        ],
        text_format=BoardReading,
        **extra,
    )
    if response.output_parsed is None:  # refusal or incomplete output
        raise RuntimeError(f"vision model gave no reading (status={response.status})")
    return response.output_parsed
