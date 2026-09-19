"""The question every vision engine answers, and the shape of its answer."""
from __future__ import annotations

import base64
import io

from PIL import Image
from pydantic import BaseModel

PROMPT = """This is a photo taken by a teacher in a classroom. Somewhere in it there should be
a chalkboard or whiteboard with a few words written by hand.

Candidate words (the board may show some, all or none of them):
{candidates}

Report:
- words_on_board: every candidate word that is clearly handwritten on the board in this photo.
  Only use words from the candidate list, spelled exactly as listed. Do not guess words that
  are hidden, cut off or illegible.
- people: how many people (students and teachers) are visible.
- looks_like_screen: true if this is a photo OF a screen, monitor, phone or printed photo
  rather than a photo of a real room. Signs: a dark bezel or frame around the picture, a
  tilted rectangle inside the photo, wavy moire or rainbow interference patterns, a visible
  pixel grid, or screen glare.
- notes: one short sentence about anything unusual, or an empty string."""


class BoardReading(BaseModel):
    # No defaults: strict structured outputs (OpenAI) require every field.
    words_on_board: list[str]
    people: int
    looks_like_screen: bool
    notes: str


def prompt(candidates: list[str]) -> str:
    return PROMPT.format(candidates=", ".join(candidates))


def jpeg_b64(img: Image.Image, max_side: int) -> str:
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")
