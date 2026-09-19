"""Compare vision engines on board photos: which words each one reads, decoys it falls for, and speed.

  .venv/bin/python bench.py                                 # synthetic boards, every configured engine
  .venv/bin/python bench.py photo.jpg lion cup rain          # a real photo and the words on its board
  .venv/bin/python bench.py --engine ollama photo.jpg lion cup rain

Engines are enabled by the same env vars as the service (see ../.env.example); run from vision/.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import pathlib
import sys
import time

from PIL import Image, ImageOps

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "tests"))

from chalkvision import app, words  # noqa: E402


def load_env() -> None:
    env = pathlib.Path(__file__).resolve().parents[1] / ".env"
    if not env.exists():
        return
    import os

    for line in env.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if "=" in line:
            k, v = (s.strip() for s in line.split("=", 1))
            if v:
                os.environ.setdefault(k, v)


def cases(args) -> list[tuple[str, Image.Image, list[str]]]:
    if args.photo:
        img = ImageOps.exif_transpose(Image.open(args.photo))
        return [(args.photo, img, [words.norm(w) for w in args.words])]
    import synth

    boards = [["lion", "cup", "rain"], ["eagle", "canoe", "box"], ["maji", "jua", "mti"], ["kite", "bread", "owl"]]
    return [(f"synthetic {i}", synth.classroom(b, seed=i), b) for i, b in enumerate(boards)]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("photo", nargs="?")
    p.add_argument("words", nargs="*")
    p.add_argument("--engine", action="append", help="engine(s) to test; default: every configured one")
    p.add_argument("--lang", default="en")
    args = p.parse_args()
    if args.photo and len(args.words) < 1:
        p.error("give the words written on the board after the photo")
    load_env()
    engines = args.engine or app.engines()
    if not engines:
        sys.exit("no engine configured: set an API key or CHALK_OLLAMA_MODEL (see ../.env.example)")

    for engine in engines:
        read = app._reader(engine)
        print(f"\n== {engine}")
        for name, img, expected in cases(args):
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="JPEG", quality=90)
            candidates, decoys = words.build_candidates(expected, [], hashlib.sha256(buf.getvalue()).digest(), args.lang)
            t0 = time.monotonic()
            try:
                r = read(img)
            except Exception as e:  # noqa: BLE001
                print(f"  {name}: FAILED {e}")
                continue
            ms = int((time.monotonic() - t0) * 1000)
            seen = words.find_words(candidates, words.transcript_tokens([words.norm(w) for w in r.board_text]))
            found = [w for w in expected if w in seen]
            fooled = sorted(d for d in decoys if d in seen)
            verdict = "PASS" if len(found) == len(expected) and not fooled else "FAIL"
            print(f"  {name}: {verdict}  words {len(found)}/{len(expected)}  decoys {fooled or 'none'}"
                  f"  people {r.people}  screen {r.looks_like_screen}  {ms} ms")
            print(f"     read: {r.board_text}")


if __name__ == "__main__":
    main()
