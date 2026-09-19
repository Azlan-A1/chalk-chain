"""Images for the stage demo (used by scripts/demo.sh and scripts/demo-cheats.ts).

  demo_images.py classroom OUT.jpg WORD...        a fresh synthetic class photo with WORDs on the board
  demo_images.py edit OLD.jpg OUT.jpg WORD...      an old photo with WORDs pasted on, like a cheater's edit
  demo_images.py screen IN.jpg OUT.jpg             IN as if photographed off a laptop screen
"""
from __future__ import annotations

import pathlib
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "tests"))

import synth  # noqa: E402


def classroom(words: list[str]) -> Image.Image:
    return synth.classroom(words, seed=random.randrange(2**31))


def edit(old: Image.Image, words: list[str]) -> Image.Image:
    """Paste the words onto the photo in chalk white, the way a quick edit or inpainting would."""
    out = old.convert("RGB").copy()
    w, h = out.size
    size = max(28, h // 12)
    draw = ImageDraw.Draw(out)
    y = int(h * 0.12)
    for word in words:
        draw.text((int(w * 0.18), y), word, fill=(240, 240, 235), font=synth.font(size))
        y += int(size * 1.35)
    return out


def screen(img: Image.Image) -> Image.Image:
    """Moiré from the screen's pixel grid, a dark bezel and a slight tilt."""
    shot = synth.add_moire(img.convert("RGB"), period=5.0, angle_deg=17.0, amp=26.0)
    shot = ImageOps.expand(shot, border=max(20, shot.width // 25), fill=(12, 12, 14))
    shot = shot.rotate(3.5, expand=True, fillcolor=(40, 38, 36), resample=Image.BICUBIC)
    arr = np.asarray(shot, dtype=np.float64) * 0.9 + 12  # washed-out screen glare
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        sys.exit(__doc__)
    mode = argv[0]
    if mode == "classroom" and len(argv) >= 3:
        img, out = classroom(argv[2:]), argv[1]
    elif mode == "edit" and len(argv) >= 4:
        img, out = edit(ImageOps.exif_transpose(Image.open(argv[1])), argv[3:]), argv[2]
    elif mode == "screen" and len(argv) == 3:
        img, out = screen(ImageOps.exif_transpose(Image.open(argv[1]))), argv[2]
    else:
        sys.exit(__doc__)
    img.convert("RGB").save(out, format="JPEG", quality=88)


if __name__ == "__main__":
    main(sys.argv[1:])
