"""Rebuild the far-leg layers: keep the real shin/paw, replace the copied
parallelogram above it with a synthesized thigh column that runs up under
the body plate toward the shoulder/hip pivot."""
import os
from PIL import Image
import numpy as np

A = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets') + os.sep

def widen_rows(im, y_from, factor, alpha_min=8):
    """Scale every row's opaque span about its own centre by `factor`."""
    h, w, _ = im.shape
    xs = np.arange(w)
    out = im.copy()
    for y in range(y_from, h):
        cols = np.where(im[y, :, 3] > alpha_min)[0]
        if len(cols) == 0:
            continue
        c = (cols.min() + cols.max()) / 2
        sx = c + (xs - c) / factor
        sx0 = np.clip(np.floor(sx).astype(int), 0, w - 2)
        f = np.clip(sx - sx0, 0, 1)[:, None]
        valid = (sx >= 0) & (sx <= w - 1)
        row = im[y, sx0] * (1 - f) + im[y, sx0 + 1] * f
        row[~valid] = 0
        out[y] = row
    return out


def rebuild(src, dst, y_trusted, y_top, pivot_x, top_scale, curve=0.6, band=56, alpha_min=12, widen=1.0):
    im = np.array(Image.open(A + src).convert('RGBA')).astype(np.float32)
    h, w, _ = im.shape
    if widen != 1.0:
        im = widen_rows(im, y_trusted - 40, widen)
    out = im.copy()
    out[:y_trusted] = 0  # drop the whole copied slab above the trusted shin rows

    # Measure the shin at the trusted row: centre and half-width.
    def extent(row):
        xs = np.where(im[row, :, 3] > alpha_min)[0]
        return xs.min(), xs.max()
    xl0, xr0 = extent(y_trusted)
    c0 = (xl0 + xr0) / 2
    hw0 = (xr0 - xl0) / 2

    xs = np.arange(w)
    for y in range(y_top, y_trusted):
        t = (y_trusted - y) / (y_trusted - y_top)      # 0 at the shin, 1 at the top
        centre = c0 + (pivot_x - c0) * t
        # curve < 1 makes the thigh fill out soon after the shin instead of
        # only near the hidden top.
        hw = hw0 * (1 + (top_scale - 1) * t ** curve)
        # Mirror-tiled source row from the trusted band so the seam is continuous.
        k = (y_trusted - y) % (2 * band)
        sy = y_trusted + (k if k < band else 2 * band - k)
        sxl, sxr = extent(sy)
        # Resample the source row's own opaque span onto the target span.
        u = (xs - (centre - hw)) / (2 * hw)             # 0..1 across the target
        inside = (u >= 0) & (u <= 1)
        sx = sxl + u * (sxr - sxl)
        sx0 = np.clip(np.floor(sx).astype(int), 0, w - 2)
        f = np.clip(sx - sx0, 0, 1)[:, None]
        row = im[sy, sx0] * (1 - f) + im[sy, sx0 + 1] * f
        row[~inside] = 0
        out[y] = row

    # Soften the very top so a rotated column never shows a hard cap
    # even if it ever peeks past the body (it should not).
    for i in range(8):
        out[y_top + i, :, 3] *= (i + 1) / 9

    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(A + dst)
    print(dst, 'shin centre', c0, 'half width', hw0)

if __name__ == '__main__':
    rebuild('nuoji-walk-leg-front-far-v2.png', 'nuoji-walk-leg-front-far-v3.png',
            y_trusted=842, y_top=650, pivot_x=450, top_scale=1.8, widen=1.18)
    rebuild('nuoji-walk-leg-hind-far-v2.png', 'nuoji-walk-leg-hind-far-v3.png',
            y_trusted=846, y_top=640, pivot_x=800, top_scale=2.7, widen=1.18)
