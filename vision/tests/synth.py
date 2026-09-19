"""Synthetic classroom photos for tests: a wall, a green board with chalk words, people blobs."""
from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def font(size: int = 72) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def classroom(words: list[str], seed: int = 0, size: tuple[int, int] = (1280, 960)) -> Image.Image:
    rng = np.random.default_rng(seed)
    w, h = size
    wall = tuple(int(c) for c in rng.integers(150, 230, 3))
    img = Image.new("RGB", size, wall)
    d = ImageDraw.Draw(img)
    bx0, by0 = int(rng.integers(40, 200)), int(rng.integers(30, 120))
    bx1, by1 = w - int(rng.integers(40, 200)), by0 + int(h * 0.5)
    d.rectangle((bx0 - 12, by0 - 12, bx1 + 12, by1 + 12), fill=(120, 90, 60))
    d.rectangle((bx0, by0, bx1, by1), fill=(28, 68, 44))
    y = by0 + 30
    for word in words:
        d.text((bx0 + 40 + int(rng.integers(0, 120)), y), word, fill=(240, 240, 235), font=font(80))
        y += 110
    for _ in range(int(rng.integers(4, 9))):
        cx, cy = int(rng.integers(0, w)), int(rng.integers(by1 + 40, h))
        col = tuple(int(c) for c in rng.integers(0, 255, 3))
        d.ellipse((cx - 60, cy - 90, cx + 60, cy + 90), fill=col)
        d.ellipse((cx - 30, cy - 150, cx + 30, cy - 90), fill=(200, 160, 130))
    arr = np.asarray(img, dtype=np.float64) + rng.normal(0, 4, (h, w, 3))
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def paste_word(img: Image.Image, word: str, xy: tuple[int, int] = (700, 200)) -> Image.Image:
    out = img.copy()
    ImageDraw.Draw(out).text(xy, word, fill=(240, 240, 235), font=font(80))
    return out


def add_moire(img: Image.Image, period: float = 7.0, angle_deg: float = 23.0, amp: float = 14.0) -> Image.Image:
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    t = np.deg2rad(angle_deg)
    wave = amp * np.sin(2 * np.pi * (xx * np.cos(t) + yy * np.sin(t)) / period)
    arr = np.asarray(img, dtype=np.float64) + wave[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def jpeg(img: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
