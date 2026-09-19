"""The question every vision engine answers, and the shape of its answer.

We ask the model to TRANSCRIBE the board and match the words ourselves. Asking "which of these
words do you see?" biases the model towards yes: on real photos of busy boards it claimed to see
words that were not there, including our decoys. Transcribing invents far less.
"""
from __future__ import annotations

import base64
import io

from PIL import Image
from pydantic import BaseModel, Field

# A full day is 6 links x 3 words, and /verify sends every earlier link's words as `prior`,
# so the transcript has to be able to hold them all, plus a little stray board text.
MAX_WORDS = 24

PROMPT = """This is a photo taken by a teacher in a classroom. Somewhere in it there may be a
chalkboard or whiteboard with words written by hand.

Report:
- board_text: the words you can actually READ on the board, at most 24, one word per entry,
  spelled exactly as written. Only include words whose letters you can make out. Return an empty
  list if the board is empty or unreadable, or if there is no board. Never guess from context.
- people: how many people (students and teachers) are visible.
- looks_like_screen: true if this is a photo OF a screen, monitor, phone or printed photo rather
  than a photo of a real room. Signs: a dark bezel or frame around the picture, a tilted rectangle
  inside the photo, wavy moire or rainbow interference patterns, a visible pixel grid, or screen
  glare."""


class BoardReading(BaseModel):
    # No defaults: strict structured outputs (OpenAI) require every field.
    board_text: list[str] = Field(max_length=MAX_WORDS)
    people: int
    looks_like_screen: bool


def jpeg_b64(img: Image.Image, max_side: int) -> str:
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


def jpeg_bytes(img: Image.Image, max_side: int) -> bytes:
    return base64.b64decode(jpeg_b64(img, max_side))
