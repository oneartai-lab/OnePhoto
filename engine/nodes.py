from __future__ import annotations

import base64
import io
import os
import random
from datetime import datetime
from typing import Iterable, Tuple

import numpy as np
import piexif
import torch
from PIL import Image, ImageEnhance, ImageFilter

import folder_paths

from .presets import CAMERA_PRESETS

LUT_DIRECTORY = os.path.join(os.path.dirname(__file__), "luts")
os.makedirs(LUT_DIRECTORY, exist_ok=True)

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_SUPPORT = True
except Exception:
    HEIF_SUPPORT = False

try:
    import rawpy
    RAW_SUPPORT = True
except Exception:
    RAW_SUPPORT = False

_RESAMPLE = getattr(Image, "Resampling", Image)


def _tensor_to_pil(image_tensor: torch.Tensor) -> Image.Image:
    if image_tensor.is_cuda:
        image_tensor = image_tensor.detach().cpu()
    if image_tensor.ndim == 4:
        if image_tensor.shape[0] != 1:
            raise ValueError("Expected a single image tensor or batch size 1.")
        image_tensor = image_tensor[0]
    array = torch.clamp(image_tensor, 0.0, 1.0).numpy()
    return Image.fromarray((array * 255.0).round().astype(np.uint8), mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array)


def _encode_exif(exif_bytes: bytes) -> str:
    return base64.b64encode(exif_bytes).decode("utf-8") if exif_bytes else ""


def _decode_exif(exif_text: str) -> bytes:
    if not exif_text:
        return b""
    try:
        return base64.b64decode(exif_text)
    except Exception:
        return b""


def _write_jpeg_with_exif(image: Image.Image, path: str, quality: int, exif_bytes: bytes) -> None:
    save_kwargs = {
        "format": "JPEG",
        "quality": int(quality),
        "optimize": True,
        "subsampling": 0,
    }
    if exif_bytes:
        save_kwargs["exif"] = exif_bytes
    image.save(path, **save_kwargs)

    if exif_bytes:
        try:
            piexif.insert(exif_bytes, path)
        except Exception:
            # Pillow already wrote the file; this is a best-effort reinforcement step.
            pass


def _parse_rational(value: str) -> Tuple[int, int]:
    text = str(value).strip()
    if not text:
        return 0, 1
    if "/" in text:
        num, den = text.split("/", 1)
        return int(num), max(int(den), 1)
    number = float(text)
    if number.is_integer():
        return int(number), 1
    scaled = int(round(number * 1000))
    return scaled, 1000


def _normalize_datetime(value: str) -> str:
    text = str(value).strip()
    if not text:
        return datetime.now().strftime("%Y:%m:%d %H:%M:%S")
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M:%S"):
        try:
            return datetime.strptime(text, pattern).strftime("%Y:%m:%d %H:%M:%S")
        except Exception:
            pass
    return text[:19].replace("-", ":", 2)


def _parse_exposure_time(value: str) -> Tuple[int, int]:
    text = str(value).strip()
    if not text:
        return 1, 125
    if "/" in text:
        left, right = text.split("/", 1)
        try:
            left_v = float(left)
            right_v = float(right)
            if left_v == 0 or right_v == 0:
                return 0, 1
            return _parse_rational(str(left_v / right_v))
        except Exception:
            try:
                return int(left), max(int(right), 1)
            except Exception:
                return 1, 125
    try:
        numeric = float(text)
        if numeric > 1:
            return 1, int(round(numeric))
        return _parse_rational(text)
    except Exception:
        return 1, 125


def build_exif_bytes(
    preset_name: str,
    artist: str,
    software: str,
    copyright_text: str,
    body_serial: str,
    lens_serial: str,
    focal_length_mm: str,
    fnumber: str,
    exposure_1_over_s: str,
    iso: int,
    exposure_bias_ev: str,
    white_balance: int,
    datetime_original: str,
    lens_model_override: str = "",
    make_override: str = "",
    model_override: str = "",
) -> bytes:
    preset = CAMERA_PRESETS.get(preset_name, CAMERA_PRESETS["Canon"])
    make = make_override or preset["Make"]
    model = model_override or preset["Model"]
    lens_model = lens_model_override or preset["LensModel"]

    zeroth = {
        piexif.ImageIFD.Make: make.encode("utf-8"),
        piexif.ImageIFD.Model: model.encode("utf-8"),
        piexif.ImageIFD.Software: (software or preset["Software"]).encode("utf-8"),
        piexif.ImageIFD.Artist: (artist or preset["Artist"]).encode("utf-8"),
        piexif.ImageIFD.Copyright: copyright_text.encode("utf-8"),
        piexif.ImageIFD.XResolution: (300, 1),
        piexif.ImageIFD.YResolution: (300, 1),
        piexif.ImageIFD.ResolutionUnit: 2,
    }

    exif_ifd = {
        piexif.ExifIFD.DateTimeOriginal: _normalize_datetime(datetime_original).encode("ascii", errors="ignore"),
        piexif.ExifIFD.ExposureTime: _parse_exposure_time(exposure_1_over_s),
        piexif.ExifIFD.FNumber: _parse_rational(fnumber),
        piexif.ExifIFD.ISOSpeedRatings: int(iso),
        piexif.ExifIFD.FocalLength: _parse_rational(focal_length_mm),
        piexif.ExifIFD.LensModel: lens_model.encode("utf-8"),
        piexif.ExifIFD.BodySerialNumber: body_serial.encode("utf-8"),
        piexif.ExifIFD.LensSerialNumber: lens_serial.encode("utf-8"),
        piexif.ExifIFD.ExposureBiasValue: _parse_rational(exposure_bias_ev),
        piexif.ExifIFD.WhiteBalance: int(white_balance),
    }

    return piexif.dump({"0th": zeroth, "Exif": exif_ifd, "GPS": {}, "1st": {}, "Interop": {}})


def _ensure_batch(images: torch.Tensor) -> torch.Tensor:
    if images.ndim == 3:
        return images.unsqueeze(0)
    return images


def _stack_pils(images: Iterable[Image.Image]) -> torch.Tensor:
    tensors = [_pil_to_tensor(image) for image in images]
    return torch.stack(tensors, dim=0)


def _add_noise(array: np.ndarray, noise_level: float, blue_bias: float = 0.8) -> np.ndarray:
    noise = np.random.normal(0.0, 255.0 * noise_level, array.shape).astype(np.float32)
    if array.ndim == 3 and array.shape[2] >= 3:
        noise[:, :, 2] *= blue_bias
    return np.clip(array + noise, 0, 255)


def _apply_grain(image: Image.Image, strength: float, grain_size: int) -> Image.Image:
    if strength <= 0:
        return image
    width, height = image.size
    noise = np.random.normal(128.0, 50.0 * strength, (height, width)).astype(np.float32)
    grain = Image.fromarray(np.clip(noise, 0, 255).astype(np.uint8), mode="L")
    if grain_size > 1:
        small_w = max(1, width // grain_size)
        small_h = max(1, height // grain_size)
        grain = grain.resize((small_w, small_h), resample=_RESAMPLE.NEAREST)
        grain = grain.resize((width, height), resample=_RESAMPLE.NEAREST)
    base = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    layer = np.asarray(grain, dtype=np.float32) / 255.0
    layer = layer[..., None]
    mixed = np.clip(base * (0.85 + 0.3 * (layer - 0.5) * strength), 0, 1)
    return Image.fromarray((mixed * 255.0).astype(np.uint8), mode="RGB")


def _apply_tone_adjustment(
    image: Image.Image,
    brightness: float,
    contrast: float,
    light_balance: float,
    highlights: float,
    shadows: float,
    warmth: float,
) -> Image.Image:
    image = image.convert("RGB")

    if brightness != 1.0:
        image = ImageEnhance.Brightness(image).enhance(float(brightness))
    if contrast != 1.0:
        image = ImageEnhance.Contrast(image).enhance(float(contrast))

    arr = np.asarray(image, dtype=np.float32) / 255.0
    luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114

    if light_balance != 0.0:
        balance = float(light_balance)
        mid_mask = 1.0 - np.abs(luma - 0.5) * 2.0
        arr += balance * 0.10 * mid_mask[..., None]

    if highlights != 0.0:
        highlight_mask = np.clip((luma - 0.5) * 2.0, 0.0, 1.0)
        arr += float(highlights) * 0.18 * highlight_mask[..., None] * (1.0 - arr)

    if shadows != 0.0:
        shadow_mask = np.clip((0.5 - luma) * 2.0, 0.0, 1.0)
        arr += float(shadows) * 0.18 * shadow_mask[..., None] * (1.0 - arr)

    if warmth != 0.0:
        warm = float(warmth)
        red_gain = 1.0 + warm * 0.16
        green_gain = 1.0 + warm * 0.03
        blue_gain = 1.0 - warm * 0.16
        arr[..., 0] *= red_gain
        arr[..., 1] *= green_gain
        arr[..., 2] *= blue_gain

    arr = np.clip(arr, 0.0, 1.0)
    return Image.fromarray((arr * 255.0).round().astype(np.uint8), mode="RGB")


def _apply_vignette(image: Image.Image, outer_brightness: float, inner_brightness: float) -> Image.Image:
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    height, width = arr.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    nx = (xx - (width * 0.5)) / max(width * 0.5, 1.0)
    ny = (yy - (height * 0.5)) / max(height * 0.5, 1.0)
    radius = np.sqrt(nx * nx + ny * ny)
    radius = np.clip(radius, 0.0, 1.0)

    inner_mask = np.clip(1.0 - radius, 0.0, 1.0)
    inner_mask = inner_mask * inner_mask * (3.0 - 2.0 * inner_mask)
    outer_mask = 1.0 - inner_mask

    outer_gain = 1.0 + float(outer_brightness)
    inner_gain = 1.0 + float(inner_brightness)

    gain = outer_mask[..., None] * outer_gain + inner_mask[..., None] * inner_gain
    out = np.clip(arr * gain, 0.0, 1.0)
    return Image.fromarray((out * 255.0).round().astype(np.uint8), mode="RGB")


def _apply_style_fx(
    image: Image.Image,
    mode: str,
    strength: float,
    radius: float,
    threshold: float,
    seed: int,
) -> Image.Image:
    mode = str(mode)
    strength = float(np.clip(strength, 0.0, 1.0))
    radius = float(max(radius, 0.0))
    threshold = float(np.clip(threshold, 0.0, 1.0))
    rng = np.random.default_rng(None if int(seed) == 0 else int(seed))

    if mode == "GlitchArt":
        arr = np.asarray(image.convert("RGB"), dtype=np.float32)
        h, w = arr.shape[:2]
        out = arr.copy()
        max_shift = max(1, int(round((w * 0.03) * (0.35 + strength))))
        stripe_step = max(2, int(round(18 - strength * 12)))
        for y in range(0, h, stripe_step):
            band_h = int(rng.integers(1, max(2, int(4 + strength * 12))))
            y2 = min(h, y + band_h)
            shift = int(rng.integers(-max_shift, max_shift + 1))
            out[y:y2] = np.roll(out[y:y2], shift, axis=1)

        if strength > 0.2:
            block_count = int(2 + strength * 6)
            for _ in range(block_count):
                x0 = int(rng.integers(0, w))
                y0 = int(rng.integers(0, h))
                bw = int(rng.integers(max(4, w // 24), max(6, w // 8)))
                bh = int(rng.integers(max(4, h // 30), max(6, h // 10)))
                x1 = min(w, x0 + bw)
                y1 = min(h, y0 + bh)
                out[y0:y1, x0:x1] = np.roll(out[y0:y1, x0:x1], int(rng.integers(-max_shift, max_shift + 1)), axis=1)

        if strength > 0:
            out[..., 0] = np.roll(out[..., 0], int(round(max_shift * 0.6)), axis=1)
            out[..., 2] = np.roll(out[..., 2], -int(round(max_shift * 0.6)), axis=0)
            scanline = (np.sin(np.arange(h) * 1.25) > 0).astype(np.float32)
            out *= (1.0 - strength * 0.08 * scanline[:, None, None])
            noise = rng.normal(0.0, 255.0 * 0.06 * strength, out.shape).astype(np.float32)
            out = np.clip(out + noise, 0, 255)
        return Image.fromarray(out.astype(np.uint8), mode="RGB")

    if mode == "SoftPortrait":
        base = image.convert("RGB")
        blurred = base.filter(ImageFilter.GaussianBlur(radius=max(0.1, radius * (0.55 + strength * 0.9))))
        arr = np.asarray(base, dtype=np.float32) / 255.0
        blur = np.asarray(blurred, dtype=np.float32) / 255.0
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        saturation = arr.max(axis=2) - arr.min(axis=2)
        smooth_mask = np.clip(1.0 - saturation * 2.2, 0.0, 1.0)
        smooth_mask *= np.clip(1.0 - np.abs(luma - 0.5) * 1.6, 0.0, 1.0)
        smooth_mask = np.clip(smooth_mask * (0.35 + strength * 0.9), 0.0, 1.0)[..., None]
        lifted = arr + (0.03 + strength * 0.04) * np.clip(0.5 - luma, 0.0, 1.0)[..., None]
        warmth = np.array([1.0 + strength * 0.03, 1.0 + strength * 0.01, 1.0 - strength * 0.02], dtype=np.float32)
        lifted *= warmth
        out = np.clip(arr * (1.0 - smooth_mask) + blur * smooth_mask, 0.0, 1.0)
        out = np.clip(out * 0.88 + lifted * 0.12, 0.0, 1.0)
        return Image.fromarray((out * 255.0).round().astype(np.uint8), mode="RGB")

    if mode == "CinematicGrade":
        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        shadow = np.clip((0.5 - luma) * 2.0, 0.0, 1.0)[..., None]
        highlight = np.clip((luma - 0.5) * 2.0, 0.0, 1.0)[..., None]
        arr = np.clip((arr - 0.5) * (1.0 + 0.22 * strength) + 0.5, 0.0, 1.0)
        arr[..., 0] *= 1.0 + 0.10 * strength * highlight[..., 0]
        arr[..., 1] *= 1.0 + 0.02 * strength * highlight[..., 0]
        arr[..., 2] *= 1.0 - 0.08 * strength * highlight[..., 0]
        arr[..., 0] *= 1.0 - 0.07 * strength * shadow[..., 0]
        arr[..., 1] *= 1.0 + 0.05 * strength * shadow[..., 0]
        arr[..., 2] *= 1.0 + 0.11 * strength * shadow[..., 0]
        arr = np.clip(arr, 0.0, 1.0)
        arr = np.clip(arr * (1.0 - 0.10 * strength), 0.0, 1.0)
        return Image.fromarray((arr * 255.0).round().astype(np.uint8), mode="RGB")

    if mode == "Halation":
        base = image.convert("RGB")
        arr = np.asarray(base, dtype=np.float32) / 255.0
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        highlight_mask = np.clip((luma - threshold) / max(1e-4, 1.0 - threshold), 0.0, 1.0)
        highlight_mask = np.power(highlight_mask, 1.6)
        halo = Image.fromarray((highlight_mask * 255.0).astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=max(0.1, radius * (0.7 + strength)))
        )
        halo_mask = np.asarray(halo, dtype=np.float32) / 255.0
        glow = np.asarray(base.filter(ImageFilter.GaussianBlur(radius=max(0.1, radius))), dtype=np.float32) / 255.0
        out = np.clip(arr + glow * halo_mask[..., None] * (0.18 + 0.55 * strength), 0.0, 1.0)
        out[..., 0] = np.clip(out[..., 0] + halo_mask * (0.08 + 0.18 * strength), 0.0, 1.0)
        out[..., 1] = np.clip(out[..., 1] + halo_mask * (0.03 + 0.05 * strength), 0.0, 1.0)
        return Image.fromarray((out * 255.0).round().astype(np.uint8), mode="RGB")

    if mode == "Bloom":
        base = image.convert("RGB")
        arr = np.asarray(base, dtype=np.float32) / 255.0
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        bright_mask = np.clip((luma - threshold) / max(1e-4, 1.0 - threshold), 0.0, 1.0)
        bright_mask = np.power(bright_mask, 1.2)
        bloom = Image.fromarray((bright_mask * 255.0).astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=max(0.1, radius * (0.8 + strength)))
        )
        bloom_mask = np.asarray(bloom, dtype=np.float32) / 255.0
        glow = np.asarray(base.filter(ImageFilter.GaussianBlur(radius=max(0.1, radius * 1.15))), dtype=np.float32) / 255.0
        out = np.clip(arr * (1.0 - 0.20 * strength) + glow * bloom_mask[..., None] * (0.35 + 0.65 * strength), 0.0, 1.0)
        out += bloom_mask[..., None] * (0.05 + 0.08 * strength)
        return Image.fromarray((np.clip(out, 0.0, 1.0) * 255.0).round().astype(np.uint8), mode="RGB")

    return image


def _available_lut_files() -> list[str]:
    if not os.path.isdir(LUT_DIRECTORY):
        return []
    files = []
    for name in sorted(os.listdir(LUT_DIRECTORY)):
        path = os.path.join(LUT_DIRECTORY, name)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext in {".cube", ".png", ".jpg", ".jpeg", ".tif", ".tiff"}:
            files.append(name)
    return files


def _resolve_lut_path(lut_name: str) -> str:
    name = str(lut_name).strip().strip('"')
    if not name:
        raise FileNotFoundError("LUT file is empty.")
    path = os.path.join(LUT_DIRECTORY, name)
    if os.path.exists(path):
        return path
    raise FileNotFoundError(f"LUT file not found in LUT folder: {lut_name}")


def _load_cube_lut(path: str) -> np.ndarray:
    size = None
    values = []
    with open(path, "r", encoding="utf-8", errors="ignore") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            upper = line.upper()
            if upper.startswith("TITLE "):
                continue
            if upper.startswith("LUT_3D_SIZE"):
                parts = line.split()
                size = int(parts[-1])
                continue
            if upper.startswith("DOMAIN_"):
                continue
            parts = line.split()
            if len(parts) == 3:
                values.append([float(parts[0]), float(parts[1]), float(parts[2])])
    if size is None:
        raise ValueError("Invalid .cube file: missing LUT_3D_SIZE.")
    lut = np.asarray(values, dtype=np.float32)
    expected = size * size * size
    if lut.shape[0] < expected:
        raise ValueError(f"Invalid .cube file: expected {expected} entries, found {lut.shape[0]}.")
    return lut[:expected].reshape((size, size, size, 3))


def _load_image_lut(path: str) -> np.ndarray:
    image = Image.open(path).convert("RGB")
    arr = np.asarray(image, dtype=np.float32) / 255.0
    h, w = arr.shape[:2]
    size = int(round((w * h) ** (1.0 / 3.0)))
    if size < 2:
        raise ValueError("LUT image is too small.")
    if w == size * size and h == size:
        lut = arr.reshape(size, size * size, 3)
        lut = lut.reshape(size, size, size, 3)
        return lut
    if h == size * size and w == size:
        lut = arr.reshape(size * size, size, 3)
        lut = lut.reshape(size, size, size, 3)
        return np.transpose(lut, (1, 0, 2, 3))
    raise ValueError("Unsupported LUT image layout. Use a 3D strip PNG.")


def _sample_lut_cube(lut: np.ndarray, r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    size = lut.shape[0]
    r = np.clip(r, 0.0, 1.0) * (size - 1)
    g = np.clip(g, 0.0, 1.0) * (size - 1)
    b = np.clip(b, 0.0, 1.0) * (size - 1)

    r0 = np.floor(r).astype(np.int32)
    g0 = np.floor(g).astype(np.int32)
    b0 = np.floor(b).astype(np.int32)
    r1 = np.clip(r0 + 1, 0, size - 1)
    g1 = np.clip(g0 + 1, 0, size - 1)
    b1 = np.clip(b0 + 1, 0, size - 1)

    dr = r - r0
    dg = g - g0
    db = b - b0

    c000 = lut[r0, g0, b0]
    c100 = lut[r1, g0, b0]
    c010 = lut[r0, g1, b0]
    c110 = lut[r1, g1, b0]
    c001 = lut[r0, g0, b1]
    c101 = lut[r1, g0, b1]
    c011 = lut[r0, g1, b1]
    c111 = lut[r1, g1, b1]

    c00 = c000 * (1.0 - dr)[..., None] + c100 * dr[..., None]
    c10 = c010 * (1.0 - dr)[..., None] + c110 * dr[..., None]
    c01 = c001 * (1.0 - dr)[..., None] + c101 * dr[..., None]
    c11 = c011 * (1.0 - dr)[..., None] + c111 * dr[..., None]

    c0 = c00 * (1.0 - dg)[..., None] + c10 * dg[..., None]
    c1 = c01 * (1.0 - dg)[..., None] + c11 * dg[..., None]

    return c0 * (1.0 - db)[..., None] + c1 * db[..., None]


def _apply_lut(image: Image.Image, lut_path: str, intensity: float) -> Image.Image:
    path = _resolve_lut_path(lut_path)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".cube":
        lut = _load_cube_lut(path)
    else:
        lut = _load_image_lut(path)

    base = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    mapped = _sample_lut_cube(lut, base[..., 0], base[..., 1], base[..., 2])
    amount = float(np.clip(intensity, 0.0, 1.0))
    mixed = np.clip(base * (1.0 - amount) + mapped * amount, 0.0, 1.0)
    return Image.fromarray((mixed * 255.0).round().astype(np.uint8), mode="RGB")


def _load_via_pillow(path: str) -> tuple[torch.Tensor | None, bytes]:
    image = Image.open(path).convert("RGB")
    exif_bytes = image.info.get("exif", b"")
    return _pil_to_tensor(image).unsqueeze(0), exif_bytes


def _load_via_rawpy(path: str) -> torch.Tensor:
    if not RAW_SUPPORT:
        raise RuntimeError("rawpy is not installed.")
    with rawpy.imread(path) as raw:
        rgb = raw.postproc()
    return _pil_to_tensor(Image.fromarray(rgb)).unsqueeze(0)


class OneArtPhotoNoise:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "noise_level": ("FLOAT", {"default": 0.05, "min": 0.0, "max": 1.0, "step": 0.01}), "blue_bias": ("FLOAT", {"default": 0.8, "min": 0.1, "max": 2.0, "step": 0.01})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, noise_level, blue_bias):
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            array = np.asarray(_tensor_to_pil(images[index]), dtype=np.float32)
            output.append(_pil_to_tensor(Image.fromarray(_add_noise(array, noise_level, blue_bias).astype(np.uint8), mode="RGB")))
        return (torch.stack(output, dim=0),)


class OneArtPhotoToneAdjust:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "brightness": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "contrast": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "light_balance": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
                "highlights": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
                "shadows": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
                "warmth": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, brightness, contrast, light_balance, highlights, shadows, warmth):
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            adjusted = _apply_tone_adjustment(
                image=image,
                brightness=brightness,
                contrast=contrast,
                light_balance=light_balance,
                highlights=highlights,
                shadows=shadows,
                warmth=warmth,
            )
            output.append(_pil_to_tensor(adjusted))
        return (torch.stack(output, dim=0),)


class OneArtPhotoVignette:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "outer_brightness": ("FLOAT", {"default": -0.25, "min": -1.0, "max": 1.0, "step": 0.01}),
                "inner_brightness": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, outer_brightness, inner_brightness):
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            output.append(_pil_to_tensor(_apply_vignette(image, outer_brightness, inner_brightness)))
        return (torch.stack(output, dim=0),)


class OneArtPhotoStyleFX:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "mode": (["GlitchArt", "SoftPortrait", "CinematicGrade", "Halation", "Bloom"], {"default": "CinematicGrade"}),
                "strength": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 1.0, "step": 0.01}),
                "radius": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 64.0, "step": 0.1}),
                "threshold": ("FLOAT", {"default": 0.72, "min": 0.0, "max": 1.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2147483647, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, mode, strength, radius, threshold, seed):
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            styled = _apply_style_fx(image, mode, strength, radius, threshold, seed + index)
            output.append(_pil_to_tensor(styled))
        return (torch.stack(output, dim=0),)


class OneArtPhotoLUT:
    @classmethod
    def INPUT_TYPES(cls):
        lut_files = _available_lut_files()
        lut_choices = lut_files if lut_files else ["Drop LUT files into the luts folder"]
        return {
            "required": {
                "images": ("IMAGE",),
                "lut_name": (lut_choices, {"default": lut_choices[0]}),
                "intensity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, lut_name, intensity):
        images = _ensure_batch(images)
        if str(lut_name).startswith("Drop LUT files"):
            raise FileNotFoundError("No LUT files found in the luts folder.")
        output = []
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            output.append(_pil_to_tensor(_apply_lut(image, lut_name, intensity)))
        return (torch.stack(output, dim=0),)


class OneArtPhotoGrain:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "grain_strength": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01}), "grain_size": ("INT", {"default": 3, "min": 1, "max": 10, "step": 1})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, grain_strength, grain_size):
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            output.append(_pil_to_tensor(_apply_grain(_tensor_to_pil(images[index]), grain_strength, grain_size)))
        return (torch.stack(output, dim=0),)


class OneArtPhotoMetadata:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "preset": (list(CAMERA_PRESETS.keys()), {"default": "Canon"}),
                "artist": ("STRING", {"default": "OneArt"}),
                "software": ("STRING", {"default": ""}),
                "copyright": ("STRING", {"default": ""}),
                "body_serial": ("STRING", {"default": ""}),
                "lens_serial": ("STRING", {"default": ""}),
                "focal_length_mm": ("STRING", {"default": "50"}),
                "fnumber": ("STRING", {"default": "4.0"}),
                "exposure_1_over_s": ("STRING", {"default": "125"}),
                "iso": ("INT", {"default": 400, "min": 50, "max": 204800}),
                "exposure_bias_ev": ("STRING", {"default": "0"}),
                "white_balance": ("INT", {"default": 0, "min": 0, "max": 1}),
                "datetime_original": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("IMAGE", "EXIF_DATA")
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, preset, artist, software, copyright, body_serial, lens_serial, focal_length_mm, fnumber, exposure_1_over_s, iso, exposure_bias_ev, white_balance, datetime_original):
        if not body_serial.strip():
            body_serial = str(random.randint(1000000, 99999999))
        if not lens_serial.strip():
            lens_serial = str(random.randint(100000000, 999999999))
        exif_bytes = build_exif_bytes(preset, artist, software, copyright, body_serial, lens_serial, focal_length_mm, fnumber, exposure_1_over_s, iso, exposure_bias_ev, white_balance, datetime_original)
        return (images, _encode_exif(exif_bytes))


class OneArtPhotoLoad:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"source_path": ("STRING", {"multiline": False, "default": "path/to/image.DNG"})}}

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("IMAGE", "EXIF_DATA")
    FUNCTION = "load"
    CATEGORY = "oneart/photo"

    def load(self, source_path):
        path = source_path.strip()
        if not os.path.exists(path):
            alt = os.path.join(folder_paths.base_path, path)
            if os.path.exists(alt):
                path = alt
            else:
                raise FileNotFoundError(f"File not found: {source_path}")

        try:
            image, exif_bytes = _load_via_pillow(path)
            return (image, _encode_exif(exif_bytes))
        except Exception as error:
            if not RAW_SUPPORT:
                raise RuntimeError("Pillow could not open the file and rawpy is unavailable.") from error
            return (_load_via_rawpy(path), "")


class OneArtPhotoSaveJpeg:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "exif_data": ("STRING", {"default": ""}),
                "filename_prefix": ("STRING", {"default": "oneart_photo"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "oneart/photo"

    def save(self, images, exif_data, filename_prefix, quality):
        output_dir = folder_paths.get_output_directory()
        exif_bytes = _decode_exif(exif_data)
        images = _ensure_batch(images)
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            filename = f"{filename_prefix}_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}_{index:04d}.jpg"
            path = os.path.join(output_dir, filename)
            _write_jpeg_with_exif(image, path, quality, exif_bytes)
        return ()


class OneArtPhotoSaveJpegDirect:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "oneart_photo"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100}),
                "preset": (list(CAMERA_PRESETS.keys()), {"default": "Canon"}),
                "artist": ("STRING", {"default": "OneArt"}),
                "software": ("STRING", {"default": ""}),
                "copyright": ("STRING", {"default": ""}),
                "body_serial": ("STRING", {"default": ""}),
                "lens_serial": ("STRING", {"default": ""}),
                "focal_length_mm": ("STRING", {"default": "50"}),
                "fnumber": ("STRING", {"default": "4.0"}),
                "exposure_1_over_s": ("STRING", {"default": "125"}),
                "iso": ("INT", {"default": 400, "min": 50, "max": 204800}),
                "exposure_bias_ev": ("STRING", {"default": "0"}),
                "white_balance": ("INT", {"default": 0, "min": 0, "max": 1}),
                "datetime_original": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "oneart/photo"

    def save(self, images, filename_prefix, quality, preset, artist, software, copyright, body_serial, lens_serial, focal_length_mm, fnumber, exposure_1_over_s, iso, exposure_bias_ev, white_balance, datetime_original):
        output_dir = folder_paths.get_output_directory()
        if not body_serial.strip():
            body_serial = str(random.randint(1000000, 99999999))
        if not lens_serial.strip():
            lens_serial = str(random.randint(100000000, 999999999))
        exif_bytes = build_exif_bytes(
            preset_name=preset,
            artist=artist,
            software=software,
            copyright_text=copyright,
            body_serial=body_serial,
            lens_serial=lens_serial,
            focal_length_mm=focal_length_mm,
            fnumber=fnumber,
            exposure_1_over_s=exposure_1_over_s,
            iso=iso,
            exposure_bias_ev=exposure_bias_ev,
            white_balance=white_balance,
            datetime_original=datetime_original,
        )
        images = _ensure_batch(images)
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            filename = f"{filename_prefix}_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}_{index:04d}.jpg"
            path = os.path.join(output_dir, filename)
            _write_jpeg_with_exif(image, path, quality, exif_bytes)
        return ()


class OneArtPhotoSaveRaw:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "exif_data": ("STRING", {"default": ""}),
                "filename_prefix": ("STRING", {"default": "oneart_raw"}),
                "format": (["TIFF", "DNG"], {"default": "TIFF"}),
                "preset": (list(CAMERA_PRESETS.keys()), {"default": "Canon"}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "oneart/photo"

    def save(self, images, exif_data, filename_prefix, format, preset):
        try:
            import tifffile
        except Exception:
            tifffile = None

        output_dir = folder_paths.get_output_directory()
        exif_bytes = _decode_exif(exif_data) or None
        preset_data = CAMERA_PRESETS.get(preset, CAMERA_PRESETS["Canon"])
        images = _ensure_batch(images)

        for index in range(images.shape[0]):
            array = np.asarray(_tensor_to_pil(images[index]), dtype=np.uint8)
            extension = "dng" if format == "DNG" else "tif"
            filename = f"{filename_prefix}_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}_{index:04d}.{extension}"
            path = os.path.join(output_dir, filename)

            if tifffile is not None:
                save_kwargs = {"photometric": "rgb", "metadata": None}
                if exif_bytes:
                    save_kwargs["exif"] = exif_bytes
                try:
                    if format == "DNG":
                        save_kwargs.update({
                            "dng_version": (1, 4, 0, 0),
                            "color_matrix1": preset_data.get("ColorMatrix1"),
                            "color_matrix2": preset_data.get("ColorMatrix2"),
                            "neutral": preset_data.get("AsShotNeutral"),
                            "calibration_illuminant1": preset_data.get("CalibrationIlluminant1", 21),
                            "calibration_illuminant2": preset_data.get("CalibrationIlluminant2", 17),
                        })
                    tifffile.imwrite(path, array, **save_kwargs)
                    continue
                except Exception:
                    pass

            image = _tensor_to_pil(images[index])
            if exif_bytes:
                image.save(path, format="TIFF", exif=exif_bytes)
            else:
                image.save(path, format="TIFF")
        return ()


class OneArtPhotoSensorNoise:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "noise_strength": ("FLOAT", {"default": 0.008, "min": 0.0, "max": 0.5, "step": 0.001}),
                "color_correlation": ("BOOLEAN", {"default": True}),
                "grain_strength": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "grain_size": ("INT", {"default": 3, "min": 1, "max": 10, "step": 1}),
                "jpeg_quality": ("INT", {"default": 96, "min": 70, "max": 100, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, noise_strength, color_correlation, grain_strength, grain_size, jpeg_quality):
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            array = np.asarray(image, dtype=np.float32)
            shot = np.random.normal(0.0, 1.0, array.shape).astype(np.float32) * np.sqrt(np.maximum(array, 0.0) + 1.0)
            read = np.random.normal(0.0, 255.0 * noise_strength * 0.35, array.shape).astype(np.float32)
            if color_correlation and array.ndim == 3 and array.shape[2] >= 3:
                shot[:, :, 0] *= 1.20
                shot[:, :, 1] *= 0.92
                shot[:, :, 2] *= 1.35
            noisy = np.clip(array + shot * (255.0 * noise_strength * 0.20) + read, 0, 255).astype(np.uint8)
            image = Image.fromarray(noisy, mode="RGB")
            if grain_strength > 0:
                image = _apply_grain(image, grain_strength, grain_size)
            if jpeg_quality < 100:
                buffer = io.BytesIO()
                image.save(buffer, format="JPEG", quality=int(jpeg_quality), optimize=True, subsampling=0)
                buffer.seek(0)
                image = Image.open(buffer).convert("RGB")
            output.append(_pil_to_tensor(image))
        return (torch.stack(output, dim=0),)


class OneArtPhotoAllInOne:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "preset": (list(CAMERA_PRESETS.keys()), {"default": "Canon"}),
                "noise_level": ("FLOAT", {"default": 0.01, "min": 0.0, "max": 0.2, "step": 0.01}),
                "jpeg_quality_first": ("INT", {"default": 88, "min": 70, "max": 98, "step": 1}),
                "jpeg_quality_final": ("INT", {"default": 95, "min": 70, "max": 98, "step": 1}),
                "random_color_jitter": ("BOOLEAN", {"default": True}),
                "jitter_strength": ("FLOAT", {"default": 0.06, "min": 0.0, "max": 0.2, "step": 0.01}),
                "artist": ("STRING", {"default": "OneArt"}),
                "software": ("STRING", {"default": ""}),
                "copyright": ("STRING", {"default": ""}),
                "body_serial": ("STRING", {"default": ""}),
                "lens_serial": ("STRING", {"default": ""}),
                "focal_length_mm": ("STRING", {"default": "50"}),
                "fnumber": ("STRING", {"default": "4.0"}),
                "exposure_1_over_s": ("STRING", {"default": "125"}),
                "iso": ("INT", {"default": 400, "min": 50, "max": 204800, "step": 1}),
                "exposure_bias_ev": ("STRING", {"default": "0"}),
                "white_balance": ("INT", {"default": 0, "min": 0, "max": 1, "step": 1}),
                "datetime_original": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, preset, noise_level, jpeg_quality_first, jpeg_quality_final, random_color_jitter, jitter_strength, artist, software, copyright, body_serial, lens_serial, focal_length_mm, fnumber, exposure_1_over_s, iso, exposure_bias_ev, white_balance, datetime_original):
        if not body_serial.strip():
            body_serial = str(random.randint(1000000, 99999999))
        if not lens_serial.strip():
            lens_serial = str(random.randint(100000000, 999999999))
        if not datetime_original.strip():
            datetime_original = datetime.now().strftime("%Y:%m:%d %H:%M:%S")

        exif_bytes = build_exif_bytes(preset, artist, software, copyright, body_serial, lens_serial, focal_length_mm, fnumber, exposure_1_over_s, iso, exposure_bias_ev, white_balance, datetime_original)
        images = _ensure_batch(images)
        output = []

        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            if random_color_jitter and jitter_strength > 0:
                strength = float(jitter_strength)
                image = ImageEnhance.Brightness(image).enhance(random.uniform(1.0 - strength, 1.0 + strength))
                image = ImageEnhance.Color(image).enhance(random.uniform(1.0 - strength * 0.8, 1.0 + strength * 0.8))
                image = ImageEnhance.Contrast(image).enhance(random.uniform(1.0 - strength * 0.7, 1.0 + strength * 0.7))

            array = np.asarray(image, dtype=np.float32)
            noisy = _add_noise(array, noise_level)
            image = Image.fromarray(noisy.astype(np.uint8), mode="RGB")

            first = io.BytesIO()
            image.save(first, format="JPEG", quality=int(jpeg_quality_first), optimize=True, subsampling=0)
            first.seek(0)
            image = Image.open(first).convert("RGB")

            second = io.BytesIO()
            image.save(second, format="JPEG", quality=int(jpeg_quality_final), exif=exif_bytes, subsampling=0)
            second.seek(0)
            output.append(_pil_to_tensor(Image.open(second).convert("RGB")))

        return (torch.stack(output, dim=0),)


NODE_CLASS_MAPPINGS = {
    "OneArtPhotoNoise": OneArtPhotoNoise,
    "OneArtPhotoToneAdjust": OneArtPhotoToneAdjust,
    "OneArtPhotoVignette": OneArtPhotoVignette,
    "OneArtPhotoStyleFX": OneArtPhotoStyleFX,
    "OneArtPhotoLUT": OneArtPhotoLUT,
    "OneArtPhotoGrain": OneArtPhotoGrain,
    "OneArtPhotoMetadata": OneArtPhotoMetadata,
    "OneArtPhotoLoad": OneArtPhotoLoad,
    "OneArtPhotoSaveJpeg": OneArtPhotoSaveJpeg,
    "OneArtPhotoSaveJpegDirect": OneArtPhotoSaveJpegDirect,
    "OneArtPhotoSaveRaw": OneArtPhotoSaveRaw,
    "OneArtPhotoSensorNoise": OneArtPhotoSensorNoise,
    "OneArtPhotoAllInOne": OneArtPhotoAllInOne,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OneArtPhotoNoise": "OneArt Photo Noise",
    "OneArtPhotoToneAdjust": "OneArt Photo Tone Adjust",
    "OneArtPhotoVignette": "OneArt Photo Vignette",
    "OneArtPhotoStyleFX": "OneArt Photo Style FX",
    "OneArtPhotoLUT": "OneArt Photo LUT",
    "OneArtPhotoGrain": "OneArt Photo Grain",
    "OneArtPhotoMetadata": "OneArt Photo Metadata",
    "OneArtPhotoLoad": "OneArt Photo Load RAW / HEIC",
    "OneArtPhotoSaveJpeg": "OneArt Photo Save JPEG",
    "OneArtPhotoSaveJpegDirect": "OneArt Photo Save JPEG Direct",
    "OneArtPhotoSaveRaw": "OneArt Photo Save RAW",
    "OneArtPhotoSensorNoise": "OneArt Photo Sensor Noise",
    "OneArtPhotoAllInOne": "OneArt Photo All In One",
}
