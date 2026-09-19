"""Claude vision engine: which candidate words are chalked on the board, how many people."""
from __future__ import annotations

import os

import anthropic
from PIL import Image

from .reading import PROMPT, BoardReading, jpeg_b64

MODEL = os.environ.get("CHALK_VLM_MODEL", "claude-opus-5")
MAX_SIDE = 1568

_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=75.0, max_retries=1)
    return _client


def read_board(img: Image.Image) -> BoardReading:
    response = client().beta.messages.parse(
        model=MODEL,
        max_tokens=4000,
        output_config={"effort": "low"},
        # Server-side fallback if the request is declined by a safety classifier.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_format=BoardReading,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(img, MAX_SIDE)},
                    },
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise RuntimeError(f"vision model gave no reading (stop_reason={response.stop_reason})")
    return response.parsed_output
