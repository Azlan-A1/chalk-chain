"""Photo reuse index: exact SHA-256 duplicates plus PDQ perceptual-hash near-duplicates.

Photos in the same group (one teacher's day) are never compared with each other,
because re-checks are expected to look like the first photo of the day.
"""
from __future__ import annotations

import json
import os
import pathlib
import threading

import numpy as np
import pdqhash
from PIL import Image

DEFAULT_PATH = pathlib.Path(__file__).resolve().parents[1] / "data" / "reuse.json"


def pdq_hex(img: Image.Image) -> str:
    rgb = np.asarray(img.convert("RGB"))
    bits, _quality = pdqhash.compute(rgb)
    return np.packbits(bits.astype(np.uint8)).tobytes().hex()


def hamming(a: str, b: str) -> int:
    return int.from_bytes(bytes.fromhex(a), "big").__xor__(int.from_bytes(bytes.fromhex(b), "big")).bit_count()


class ReuseIndex:
    def __init__(self, path: pathlib.Path | None = None, threshold: int | None = None):
        self.path = path or pathlib.Path(os.environ.get("CHALK_REUSE_DB", DEFAULT_PATH))
        self.threshold = int(os.environ.get("CHALK_REUSE_THRESHOLD", 31)) if threshold is None else threshold
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}
        if self.path.exists():
            try:
                self._entries = json.loads(self.path.read_text())
            except (OSError, ValueError):
                self._entries = {}

    def check_and_add(self, photo_id: str, group_id: str, sha256_hex: str, pdq: str) -> dict:
        with self._lock:
            best: tuple[int, str, bool] | None = None
            for pid, e in self._entries.items():
                if pid == photo_id or e["group"] == group_id:
                    continue
                exact = e["sha256"] == sha256_hex
                dist = 0 if exact else hamming(pdq, e["pdq"])
                if best is None or dist < best[0]:
                    best = (dist, pid, exact)
            self._entries[photo_id] = {"group": group_id, "sha256": sha256_hex, "pdq": pdq}
            self._save()
        if best is None:
            return {"is_reuse": False, "distance": None, "match_id": None, "exact_duplicate": False}
        dist, pid, exact = best
        is_reuse = exact or dist <= self.threshold
        return {
            "is_reuse": is_reuse,
            "distance": dist,
            "match_id": pid if is_reuse else None,
            "exact_duplicate": exact,
        }

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._entries))
        tmp.replace(self.path)
