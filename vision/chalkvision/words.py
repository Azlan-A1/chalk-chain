"""Word lists, decoy selection and the shuffled candidate list."""
from __future__ import annotations

import json
import os
import pathlib
import random
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
