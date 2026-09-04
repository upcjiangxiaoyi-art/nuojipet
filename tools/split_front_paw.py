"""Widen the two near legs a little and split the near front paw off at the
wrist so it can be laid flat on touchdown and curled during the swing.
Reads the v4 near legs and writes v5 + paw."""
import os
import sys
from PIL import Image
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rebuild_far_legs import widen_rows, A  # noqa: E402
WRIST_Y = 880          # plate row of the wrist joint on the near front leg
LEG_KEEP = 22          # rows of forearm kept below the wrist (hidden under the paw)
FEATHER = 16


def load(name):
    return np.array(Image.open(A + name).convert('RGBA')).astype(np.float32)


def save(arr, name):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(A + name)
    print('wrote', name)


def trim_cap(leg, source, y_trim, grow=5, feather=6, blend=14):
    """Below `y_trim` (where the body plate no longer covers the leg) clip
    the v4 joint cap back to the true leg silhouette of the v2 plate, grown a
    few pixels and feathered. Above it the cap stays: it is hidden under the
    body and only fills the joint opening while the leg rotates."""
    true = widen_rows(load(source), 0, 1.08)[..., 3] > 40
    h, w = true.shape
    xs = np.arange(w, dtype=np.float32)
    out = leg.copy()
    for y in range(y_trim - blend, h):
        row = np.where(true[y])[0]
        if len(row) == 0:
            keep = np.zeros(w, dtype=np.float32)
        else:
            # distance from every column to the nearest true-silhouette column
            dist = np.abs(xs[:, None] - row[None, :]).min(axis=1)
            keep = np.clip(1 - (dist - grow) / feather, 0, 1)
        # ease the trim in over `blend` rows so nothing pops at y_trim
        mix = min(1.0, (y - (y_trim - blend)) / blend)
        out[y, :, 3] *= (1 - mix) + mix * keep
    return out


hind = widen_rows(load('nuoji-walk-leg-hind-near-v4.png'), 0, 1.08)
hind = trim_cap(hind, 'nuoji-walk-leg-hind-near-v2.png', y_trim=735)
save(hind, 'nuoji-walk-leg-hind-near-v5.png')

front = widen_rows(load('nuoji-walk-leg-front-near-v4.png'), 0, 1.08)
front = trim_cap(front, 'nuoji-walk-leg-front-near-v2.png', y_trim=738)
leg = front.copy()
paw = front.copy()
h = front.shape[0]
for y in range(h):
    # forearm: solid to WRIST_Y + LEG_KEEP, then fades out
    cut = y - (WRIST_Y + LEG_KEEP)
    if cut > 0:
        leg[y, :, 3] *= max(0.0, 1 - cut / FEATHER)
    # paw: fades in across the wrist, fully solid below it
    rise = (WRIST_Y - 4) - y
    if rise > 0:
        paw[y, :, 3] *= max(0.0, 1 - rise / FEATHER)
save(leg, 'nuoji-walk-leg-front-near-v5.png')
save(paw, 'nuoji-walk-paw-front-near-v1.png')
