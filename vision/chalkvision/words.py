"""Word lists, decoy selection and the shuffled candidate list."""
from __future__ import annotations

import json
import os
import pathlib
import random
import difflib
import re
import unicodedata
from functools import lru_cache

ROOT = pathlib.Path(__file__).resolve().parents[2]
N_DECOYS = 6
LANGS = ("en", "sw")


def norm(word: str) -> str:
    return unicodedata.normalize("NFC", str(word)).strip().lower()


def wordlist_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("CHALK_WORDLIST_DIR", ROOT / "shared" / "wordlists"))


@lru_cache(maxsize=None)
def load_wordlist(lang: str) -> tuple[str, ...]:
    lang = lang if lang in LANGS else "en"
    words = json.loads((wordlist_dir() / f"{lang}.json").read_text(encoding="utf-8"))
    return tuple(norm(w) for w in words)


def build_candidates(
    expected: list[str], prior_flat: list[str], image_sha256: bytes, lang: str
) -> tuple[list[str], list[str]]:
    """Return (shuffled candidates, decoys). Deterministic in the image hash."""
    rng = random.Random(int.from_bytes(image_sha256, "big"))
    known = set(expected) | set(prior_flat)
    pool = [w for w in dict.fromkeys(load_wordlist(lang)) if w not in known]
    decoys = rng.sample(pool, min(N_DECOYS, len(pool)))
    candidates = list(dict.fromkeys([*expected, *prior_flat, *decoys]))
    rng.shuffle(candidates)
    return candidates, decoys


def transcript_tokens(board_text: list[str]) -> set[str]:
    """Words the model read off the board, split and normalised for matching."""
    out: set[str] = set()
    for line in board_text or []:
        for tok in re.split(r"[^0-9a-z]+", norm(line)):
            if len(tok) >= 3:
                out.add(tok)
    return out


FUZZY_RATIO = 0.8
FUZZY_MIN_LEN = 5  # short words must match exactly: bat/boat, bowl/owl, car/card are too close


def find_words(candidates: list[str], tokens: set[str], ratio: float = FUZZY_RATIO) -> set[str]:
    """Candidates that appear in the transcript, allowing for small misreadings of longer words."""
    found = set()
    for word in candidates:
        if word in tokens:
            found.add(word)
        elif len(word) >= FUZZY_MIN_LEN and any(
            len(t) >= FUZZY_MIN_LEN and difflib.SequenceMatcher(None, word, t).ratio() >= ratio for t in tokens
        ):
            found.add(word)
    return found
