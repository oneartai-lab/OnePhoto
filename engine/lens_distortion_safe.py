from __future__ import annotations

import numpy as np
import torch
from PIL import Image, ImageFilter

_RESAMPLE = getattr(Image, "Resampling", Image)


def _tensor_to_pil(image_tensor: torch.Tensor) -> Image.Image:
    if image_tensor.is_cuda:
        image_tensor = image_tensor.detach().cpu()
    if image_tensor.ndim == 4:
        if image_tensor.shape[0] != 1:
            raise ValueError("Expected a batch of size 1 for lens warp.")
        image_tensor = image_tensor[0]
    array = torch.clamp(image_tensor, 0.0, 1.0).numpy()
    return Image.fromarray((array * 255.0).round().astype(np.uint8), mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    return torch.from_numpy(np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0)


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


class OneArtPhotoLensWarp:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "distortion": ("FLOAT", {"default": -0.18, "min": -1.0, "max": 1.0, "step": 0.01}),
                "chromatic_aberration": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01}),
                "edge_softness": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, distortion, chromatic_aberration, edge_softness):
        if images.ndim == 3:
            images = images.unsqueeze(0)
        output = []
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            array = np.asarray(image, dtype=np.float32)
            warped = _warp(array, distortion, chromatic_aberration)
            image = Image.fromarray(warped, mode="RGB")
            if edge_softness > 0:
                blurred = image.filter(ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 12.0)))
                mask = Image.new("L", image.size, 0)
                mask_array = np.zeros((image.size[1], image.size[0]), dtype=np.float32)
                yy, xx = np.mgrid[0:image.size[1], 0:image.size[0]].astype(np.float32)
                nx = (xx - image.size[0] / 2.0) / (image.size[0] / 2.0)
                ny = (yy - image.size[1] / 2.0) / (image.size[1] / 2.0)
                radius = np.sqrt(nx * nx + ny * ny)
                falloff = np.clip(1.0 - (radius ** 2) * (0.55 + edge_softness), 0.0, 1.0)
                mask = Image.fromarray((falloff * 255.0).astype(np.uint8), mode="L").filter(ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 20.0)))
                image = Image.composite(image, blurred, mask)
            output.append(_pil_to_tensor(image))
        return (torch.stack(output, dim=0),)


NODE_CLASS_MAPPINGS = {
    "OneArtPhotoLensWarp": OneArtPhotoLensWarp,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OneArtPhotoLensWarp": "OneArt Photo Lens Warp",
}
