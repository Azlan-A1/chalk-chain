"""Screen/print recapture score from periodic peaks in the image spectrum.

A photo of a screen picks up moiré: narrow, strong peaks at mid/high spatial
frequencies. We whiten the log spectrum per radius (natural images fall off as
1/f), ignore the axes and JPEG 8x8/16x16 block harmonics, and score how far the
strongest remaining peaks rise above the noise floor.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

N = 512
RING = (0.12, 0.92)  # fraction of Nyquist
TOP_K = 8  # a windowed sinusoid spreads over a few bins, mirrored
Z0, Z1 = 7.0, 14.0  # peak z-score mapped linearly onto score 0..1
FLAG_AT = 0.6


def _crop(img: Image.Image) -> np.ndarray:
    g = img.convert("L")
    w, h = g.size
    n = min(N, (min(w, h) // 8) * 8)
    f = max(1, min(w, h) // n)
    side = n * f
    # Crop on the 8 px grid, then box-reduce by an integer factor, so JPEG
    # block harmonics land on multiples of n/16 where we notch them out.
    x0 = ((w - side) // 2) // 8 * 8
    y0 = ((h - side) // 2) // 8 * 8
    g = g.crop((x0, y0, x0 + side, y0 + side))
    if f > 1:
        g = g.reduce(f)
    return np.asarray(g, dtype=np.float64)


def moire_z(img: Image.Image) -> float:
    a = _crop(img)
    n = a.shape[0]
    if n < 64:
        return 0.0
    a = a - a.mean()
    win = np.hanning(n)
    a *= np.outer(win, win)
    spec = np.log1p(np.abs(np.fft.fftshift(np.fft.fft2(a))))

    ky, kx = np.indices((n, n)) - n // 2
    r = np.hypot(kx, ky) / (n / 2)
    step = max(4, n // 16)

    def near_grid(k: np.ndarray) -> np.ndarray:
        m = np.abs(k) % step
        return (m <= 1) | (m >= step - 1)

    mask = (r > RING[0]) & (r < RING[1]) & ~near_grid(kx) & ~near_grid(ky)
    vals = spec[mask]
    radii = np.round(r[mask] * n / 2).astype(np.int64)

    order = np.lexsort((vals, radii))
    vs, rs = vals[order], radii[order]
    counts = np.bincount(rs)
    starts = np.cumsum(counts) - counts
    med = np.zeros(len(counts))
    nz = counts > 0
    med[nz] = vs[(starts + counts // 2)[nz]]

    resid = vals - med[radii]
    noise = 1.4826 * np.median(np.abs(resid - np.median(resid))) + 1e-9
    top = np.partition(resid, -TOP_K)[-TOP_K:]
    return float(top.mean() / noise)


def moire_score(img: Image.Image) -> float:
    z = moire_z(img)
    return float(np.clip((z - Z0) / (Z1 - Z0), 0.0, 1.0))
