"""Split the walking body plate into a tail-free body and a tail layer so the
tail can sway about its root while Nuoji walks.

The cut runs down the rump. The tail keeps everything right of the cut and is
fully opaque up to 20 px inside the body; the body keeps everything left of the
cut and fades out over 30 px past it. Tail is drawn first, body last, so the
overlap stays opaque and the body's own fur hides the tail's cut edge."""
import os
from PIL import Image
import numpy as np

A = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets') + os.sep

# Cut line through the rump: x = CUT_X0 + (y - CUT_Y0) * CUT_SLOPE.
CUT_X0, CUT_Y0, CUT_SLOPE = 858, 460, 0.17


def smoothstep(v):
    v = np.clip(v, 0, 1)
    return v * v * (3 - 2 * v)


def split(src, body_dst, tail_dst):
    img = np.array(Image.open(A + src).convert('RGBA')).astype(np.float32)
    h, w = img.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    cut = CUT_X0 + (ys - CUT_Y0) * CUT_SLOPE
    # Tail: opaque for x >= cut - 20, fading to nothing by cut - 40.
    tail_keep = smoothstep((xs - (cut - 40)) / 20)
    # Body: opaque for x <= cut, fading to nothing by cut + 30.
    body_keep = 1 - smoothstep((xs - cut) / 30)
    tail = img.copy()
    tail[..., 3] *= tail_keep
    body = img.copy()
    body[..., 3] *= body_keep
    Image.fromarray(np.uint8(np.clip(body, 0, 255))).save(A + body_dst)
    Image.fromarray(np.uint8(np.clip(tail, 0, 255))).save(A + tail_dst)
    print('wrote', body_dst, tail_dst)


if __name__ == '__main__':
    split('nuoji-walk-body-v2.png', 'nuoji-walk-body-v3.png', 'nuoji-walk-tail-v1.png')
