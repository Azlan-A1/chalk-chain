"""Claude vision engine: which candidate words are chalked on the board, how many people."""
from __future__ import annotations

import base64
import io
import os

import anthropic
from PIL import Image
from pydantic import BaseModel, Field

MODEL = os.environ.get("CHALK_VLM_MODEL", "claude-opus-5")
MAX_SIDE = 1568

PROMPT = """This is a photo taken by a teacher in a classroom. Somewhere in it there should be
a chalkboard or whiteboard with a few words written by hand.

Candidate words (the board may show some, all or none of them):
{candidates}

Report:
- words_on_board: every candidate word that is clearly handwritten on the board in this photo.
  Only use words from the candidate list, spelled exactly as listed. Do not guess words that
  are hidden, cut off or illegible.
- people: how many people (students and teachers) are visible.
- looks_like_screen: true if this looks like a photo of a screen, monitor or printed photo
  rather than a real room.
- notes: one short sentence about anything unusual."""


class BoardReading(BaseModel):
    words_on_board: list[str] = Field(default_factory=list)
    people: int = 0
    looks_like_screen: bool = False
    notes: str = ""


def _jpeg_b64(img: Image.Image) -> str:
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=75.0, max_retries=1)
    return _client


def read_board(img: Image.Image, candidates: list[str]) -> BoardReading:
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
                        "source": {"type": "base64", "media_type": "image/jpeg", "data": _jpeg_b64(img)},
                    },
                    {"type": "text", "text": PROMPT.format(candidates=", ".join(candidates))},
                ],
            }
        ],
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise RuntimeError(f"vision model gave no reading (stop_reason={response.stop_reason})")
    return response.parsed_output
