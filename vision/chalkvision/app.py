"""Chalk Chain vision service (SPEC.md §3).

Run: .venv/bin/uvicorn chalkvision.app:app --port 8001   (from vision/)
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from . import recapture, words
from .reading import MAX_WORDS, BoardReading
from .reuse import ReuseIndex, pdq_hex

log = logging.getLogger("chalkvision")

MAX_BYTES = 15 * 1024 * 1024


# Default order: hosted models first, the local model last as an offline safety net.
ENGINE_ORDER = ["claude", "openai", "gemini", "ollama"]
ENABLED_BY = {
    "claude": ("ANTHROPIC_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "ollama": ("CHALK_OLLAMA_MODEL",),
}


def engines() -> list[str]:
    """Model engines to try, in order; an empty list means mock.

    Every engine whose key (or, for Ollama, model name) is set is tried in ENGINE_ORDER, with
    the preferred one (CHALK_VISION_PROVIDER, or CHALK_VISION_MODE=<engine>) moved to the front.
    """
    mode = os.environ.get("CHALK_VISION_MODE", "auto").lower()
    if mode == "mock":
        return []
    preferred = mode if mode in ENABLED_BY else os.environ.get("CHALK_VISION_PROVIDER", "").lower()
    order = sorted(ENGINE_ORDER, key=lambda e: e != preferred)  # stable: keeps the rest in order
    return [e for e in order if any(os.environ.get(var) for var in ENABLED_BY[e])]


def engine_name() -> str:
    chain = engines()
    return chain[0] if chain else "mock"


def _reader(engine: str):
    # Imported lazily so mock mode needs neither SDK nor key.
    if engine == "openai":
        from .openai_engine import read_board
    elif engine == "gemini":
        from .gemini_engine import read_board
    elif engine == "ollama":
        from .ollama_engine import read_board
    else:
        from .claude import read_board
    return read_board


app = FastAPI(title="Chalk Chain vision")
reuse_index = ReuseIndex()


@app.get("/health")
def health() -> dict:
    return {"ok": True, "engine": engine_name(), "engines": engines()}


def _json_list(raw: str, field: str) -> list:
    try:
        v = json.loads(raw) if raw else []
    except ValueError:
        raise HTTPException(400, f"{field} must be JSON")
    if not isinstance(v, list):
        raise HTTPException(400, f"{field} must be a JSON array")
    return v


def _words(raw: str, field: str) -> list[str]:
    v = _json_list(raw, field)
    if not all(isinstance(w, str) for w in v):
        raise HTTPException(400, f"{field} must be a JSON array of words")
    return [words.norm(w) for w in v]


def _mock_reading(expected: list[str], prior_flat: list[str]) -> BoardReading:
    """Demo stand-in: reads exactly the words it was told to expect."""
    people = int(os.environ.get("CHALK_MOCK_HEADCOUNT", 7))
    text = [*expected, *prior_flat][:MAX_WORDS]  # a real engine cannot exceed the cap either
    return BoardReading(board_text=text, people=people, looks_like_screen=False)


@app.post("/verify")
def verify(  # sync on purpose: FastAPI runs it in a threadpool, so one slow model call
             # does not block every other phone's check
    image: UploadFile = File(...),
    expected: str = Form(...),
    prior: str = Form("[]"),
    photo_id: str = Form(...),
    group_id: str = Form(...),
    lang: str = Form("en"),
) -> dict:
    t0 = time.monotonic()
    data = image.file.read()
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(400, "image is empty or too large")
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        img.load()
    except Exception:  # noqa: BLE001 - truncated, hostile or exotic files are the caller's problem
        raise HTTPException(400, "image is not a readable JPEG/PNG")

    exp = _words(expected, "expected")
    pri = [_words(json.dumps(link), "prior") for link in _json_list(prior, "prior")]
    prior_flat = [w for link in pri for w in link]
    sha = hashlib.sha256(data).digest()
    candidates, decoys = words.build_candidates(exp, prior_flat, sha, lang)

    chain = engines()
    engine = "mock"
    reading = None
    failures = []
    for name in chain:
        try:
            reading = _reader(name)(img)
            engine = name
            break
        except Exception as e:  # noqa: BLE001 - any model/transport failure; try the next engine
            log.warning("%s engine failed: %s", name, e)
            failures.append(f"{name}: {e}")
    if reading is None:
        if chain and os.environ.get("CHALK_VISION_FALLBACK", "").lower() != "mock":
            raise HTTPException(502, f"vision model failed: {'; '.join(failures)}")
        if chain:
            engine = "mock-fallback"
        reading = _mock_reading(exp, prior_flat)

    # The model transcribes the board; we decide which candidate words that transcript contains.
    transcript = [words.norm(w) for w in reading.board_text]
    seen = words.find_words(candidates, words.transcript_tokens(transcript))
    people, screen_hint = reading.people, reading.looks_like_screen

    words_found = [w in seen for w in exp]
    prior_found = [[w in seen for w in link] for link in pri]
    decoys_flagged = sorted(d for d in decoys if d in seen)
    words_ok = bool(exp) and all(words_found) and not decoys_flagged
    chain_ok = all(all(link) for link in prior_found)

    try:
        score = recapture.moire_score(img)
    except Exception as e:  # noqa: BLE001 - a strange image must not take the service down
        log.warning("moire scoring failed: %s", e)
        score = 0.0
    is_recapture = score >= recapture.FLAG_AT or screen_hint

    reuse = reuse_index.check_and_add(photo_id, group_id, sha.hex(), pdq_hex(img))

    reasons = [
        f"{sum(words_found)} of {len(exp)} words found" if not all(words_found) else f"All {len(exp)} words found",
    ]
    if pri:
        reasons.append("Earlier words found" if chain_ok else "Some earlier words missing")
    if decoys_flagged:
        reasons.append(f"Extra words on the board: {', '.join(decoys_flagged)}")
    reasons.append(f"{people} people")
    reasons.append("Looks like a photo of a screen" if is_recapture else "Not a photo of a screen")
    reasons.append("Same photo seen before" if reuse["is_reuse"] else "New photo")

    return {
        "words_ok": words_ok,
        "words_found": words_found,
        "chain_ok": chain_ok,
        "prior_found": prior_found,
        "decoys_flagged": decoys_flagged,
        "headcount": int(people),
        "is_recapture": bool(is_recapture),
        "recapture_score": round(score, 3),
        "reuse": reuse,
        "board_text": transcript,
        "reasons": reasons,
        "engine": engine,
        "ms": int((time.monotonic() - t0) * 1000),
    }
