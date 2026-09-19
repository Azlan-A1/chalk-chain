"""Reference implementation of Chalk Chain word derivation (see SPEC.md §1).

Run this file to regenerate shared/vectors/derivation.json. The Rust program,
the TypeScript codec and the vision service must all reproduce these vectors.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOMAIN = b"chalk-chain"


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def prev0(teacher: bytes, day: int) -> bytes:
    assert len(teacher) == 32
    return sha256(DOMAIN, teacher, struct.pack("<I", day))


def seed(slot_hash: bytes, teacher: bytes, prev: bytes) -> bytes:
    assert len(slot_hash) == 32 and len(teacher) == 32 and len(prev) == 32
    return sha256(slot_hash, teacher, prev)


def word_indices(seed_bytes: bytes) -> list[int]:
    return [seed_bytes[0], seed_bytes[1], seed_bytes[2]]


def commit(photo_hash: bytes, seed_bytes: bytes) -> bytes:
    assert len(photo_hash) == 32
    return sha256(photo_hash, seed_bytes)


def load_wordlist(lang: str) -> list[str]:
    words = json.loads((ROOT / "wordlists" / f"{lang}.json").read_text())
    assert len(words) == 256
    return words


def chain(teacher: bytes, day: int, slot_hashes: list[bytes], photo_hashes: list[bytes]):
    """Yield one dict per link for a whole chain."""
    prev = prev0(teacher, day)
    for k, (sh, ph) in enumerate(zip(slot_hashes, photo_hashes)):
        s = seed(sh, teacher, prev)
        c = commit(ph, s)
        yield {"idx": k, "prev": prev, "seed": s, "words": word_indices(s), "commit": c}
        prev = c


def generate_vectors() -> dict:
    en, sw = load_wordlist("en"), load_wordlist("sw")
    cases = []
    for t in range(3):
        teacher = sha256(f"teacher-{t}".encode())
        day = 20715 + t  # 2026-09-19 is day 20715 since the Unix epoch
        slot_hashes = [sha256(f"slot-hash-{t}-{k}".encode()) for k in range(3)]
        photo_hashes = [sha256(f"photo-{t}-{k}".encode()) for k in range(3)]
        links = []
        for link in chain(teacher, day, slot_hashes, photo_hashes):
            k = link["idx"]
            links.append({
                "idx": k,
                "slot_hash": slot_hashes[k].hex(),
                "photo_hash": photo_hashes[k].hex(),
                "prev": link["prev"].hex(),
                "seed": link["seed"].hex(),
                "words": link["words"],
                "words_en": [en[i] for i in link["words"]],
                "words_sw": [sw[i] for i in link["words"]],
                "commit": link["commit"].hex(),
            })
        cases.append({
            "teacher": teacher.hex(),
            "day": day,
            "day_le": struct.pack("<I", day).hex(),
            "prev0": prev0(teacher, day).hex(),
            "links": links,
        })
    return {
        "about": "Chalk Chain derivation vectors. See SPEC.md §1. Hex is lowercase.",
        "domain": DOMAIN.decode(),
        "cases": cases,
    }


if __name__ == "__main__":
    out = ROOT / "vectors" / "derivation.json"
    out.write_text(json.dumps(generate_vectors(), indent=2) + "\n")
    print("wrote", out)
