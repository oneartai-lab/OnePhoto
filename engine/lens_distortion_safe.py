from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

_RESAMPLE = getattr(Image, "Resampling", Image)


def _sample_bilinear(array: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    height, width = array.shape[:2]
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = x0 + 1
    y1 = y0 + 1

    x0 = np.clip(x0, 0, width - 1)
    x1 = np.clip(x1, 0, width - 1)
    y0 = np.clip(y0, 0, height - 1)
    y1 = np.clip(y1, 0, height - 1)

    wa = (x1 - x) * (y1 - y)
    wb = (x1 - x) * (y - y0)
    wc = (x - x0) * (y1 - y)
    wd = (x - x0) * (y - y0)

    top_left = array[y0, x0]
    bottom_left = array[y1, x0]
    top_right = array[y0, x1]
    bottom_right = array[y1, x1]

    return (
        top_left * wa
        + bottom_left * wb
        + top_right * wc
        + bottom_right * wd
    )


def _warp(array: np.ndarray, distortion: float, aberration: float) -> np.ndarray:
    height, width = array.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    nx = (xx - width / 2.0) / (width / 2.0)
    ny = (yy - height / 2.0) / (height / 2.0)
    radius2 = nx * nx + ny * ny

    factor = 1.0 + distortion * radius2
    factor = np.where(np.abs(factor) < 1e-4, 1e-4, factor)

    base_x = nx / factor
    base_y = ny / factor
    source_x = (base_x * (width / 2.0)) + width / 2.0
    source_y = (base_y * (height / 2.0)) + height / 2.0

    warped = np.empty_like(array)
    channel_shift = aberration * 0.008
    for channel, shift in enumerate((-channel_shift, 0.0, channel_shift)):
        shifted_x = np.clip(source_x + shift * radius2 * width, 0, width - 1)
        shifted_y = np.clip(source_y, 0, height - 1)
        warped[..., channel] = _sample_bilinear(array[..., channel], shifted_x, shifted_y)

    return np.clip(warped, 0, 255).astype(np.uint8)


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
