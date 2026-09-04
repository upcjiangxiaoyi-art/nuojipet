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


hind = widen_rows(load('nuoji-walk-leg-hind-near-v4.png'), 0, 1.08)
save(hind, 'nuoji-walk-leg-hind-near-v5.png')

front = widen_rows(load('nuoji-walk-leg-front-near-v4.png'), 0, 1.08)
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
