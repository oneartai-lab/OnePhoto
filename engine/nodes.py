from __future__ import annotations

import base64
import io
import os
import random
from datetime import datetime
from typing import Iterable, Tuple

import numpy as np
import piexif
from PIL import Image, ImageEnhance, ImageFilter

# Minimal torch shim — ComfyUI node classes need torch at definition time,
# but start_app.py never calls them. Real torch is no longer required.
try:
    import torch as _torch_real
    import sys as _sys
    _sys.modules.setdefault("torch", _torch_real)
except ImportError:
    import sys as _sys, types as _types
    _t = _types.ModuleType("torch")
    class _Tensor: pass
    _t.Tensor = _Tensor
    _t.stack = lambda tensors, dim=0: tensors
    _t.no_grad = lambda: __import__("contextlib").nullcontext()
    _t.nn = _types.SimpleNamespace(functional=_types.SimpleNamespace(interpolate=lambda *a, **kw: a[0]))
    _sys.modules["torch"] = _t
import torch

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



def _add_noise(array: np.ndarray, noise_level: float, blue_bias: float = 0.8) -> np.ndarray:
    noise = np.random.normal(0.0, 255.0 * noise_level, array.shape).astype(np.float32)
    if array.ndim == 3 and array.shape[2] >= 3:
        noise[:, :, 2] *= blue_bias
    return np.clip(array + noise, 0, 255)


def _apply_grain(image: Image.Image, strength: float, grain_size: int, luminosity_mask: bool = False) -> Image.Image:
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
    
    if luminosity_mask:
        # Modulate grain by (1 - highlights^2) to restrict grain to shadows/midtones
        luma = base[..., 0] * 0.299 + base[..., 1] * 0.587 + base[..., 2] * 0.114
        grain_mask = (1.0 - luma * luma)[..., None]
        strength_map = strength * grain_mask
        mixed = np.clip(base * (0.85 + 0.3 * (layer - 0.5) * strength_map), 0, 1)
    else:
        mixed = np.clip(base * (0.85 + 0.3 * (layer - 0.5) * strength), 0, 1)
        
    return Image.fromarray((mixed * 255.0).astype(np.uint8), mode="RGB")


def _apply_sharpness(image: Image.Image, amount: float, radius: float, threshold: int) -> Image.Image:
    """Unsharp Mask sharpening. amount 0-2, radius 0.5-5px, threshold 0-10."""
    if amount <= 0:
        return image
    percent = int(amount * 150)   # 0–2 → 0–300%
    return image.filter(ImageFilter.UnsharpMask(
        radius=max(0.1, radius),
        percent=max(1, percent),
        threshold=max(0, int(threshold)),
    ))


def _apply_saturation_vibrance(image: Image.Image, saturation: float, vibrance: float) -> Image.Image:
    """Saturation: uniform chroma boost. Vibrance: smart boost for muted colors."""
    if saturation == 0.0 and vibrance == 0.0:
        return image

    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    luma = r * 0.299 + g * 0.587 + b * 0.114

    # --- Saturation (uniform) ---
    if saturation != 0.0:
        sat_factor = 1.0 + saturation        # -1..+1 → 0..2
        r = np.clip(luma + (r - luma) * sat_factor, 0, 1)
        g = np.clip(luma + (g - luma) * sat_factor, 0, 1)
        b = np.clip(luma + (b - luma) * sat_factor, 0, 1)

    # --- Vibrance (stronger on muted pixels, protects saturated ones) ---
    if vibrance != 0.0:
        cmax = np.maximum(np.maximum(r, g), b)
        cmin = np.minimum(np.minimum(r, g), b)
        s = np.where(cmax > 1e-6, (cmax - cmin) / cmax, 0.0)
        # Vibrance factor: strongest where saturation is lowest
        vib_factor = 1.0 + vibrance * (1.0 - s)
        r = np.clip(luma + (r - luma) * vib_factor, 0, 1)
        g = np.clip(luma + (g - luma) * vib_factor, 0, 1)
        b = np.clip(luma + (b - luma) * vib_factor, 0, 1)

    result = np.stack([r, g, b], axis=-1)
    return Image.fromarray((result * 255.0).round().astype(np.uint8), mode="RGB")


def _kelvin_to_rgb_gains(kelvin: float) -> tuple:
    """Tanner Helland algorithm: Kelvin → normalised (R,G,B) gains [0..1]."""
    import math
    t = max(1000.0, min(40000.0, kelvin)) / 100.0

    # Red
    if t <= 66.0:
        r = 1.0
    else:
        r = 329.698727446 * ((t - 60.0) ** -0.1332047592) / 255.0

    # Green
    if t <= 66.0:
        g = (99.4708025861 * math.log(t) - 161.1195681661) / 255.0
    else:
        g = 288.1221695283 * ((t - 60.0) ** -0.0755148492) / 255.0

    # Blue
    if t >= 66.0:
        bl = 1.0
    elif t <= 19.0:
        bl = 0.0
    else:
        bl = (138.5177312231 * math.log(t - 10.0) - 305.0447927307) / 255.0

    return (
        max(0.0, min(1.0, r)),
        max(0.0, min(1.0, g)),
        max(0.0, min(1.0, bl)),
    )


def _apply_color_temperature(
    image: Image.Image,
    temp_kelvin: float,
    tint: float,
    wb_mode: str = "manual"
) -> Image.Image:
    """White-balance correction via Kelvin + green/magenta tint, or Auto, or Smart modes."""
    if not wb_mode:
        wb_mode = "manual"

    if wb_mode == "manual":
        # 6500 K = D65 neutral daylight → no-op baseline
        if abs(temp_kelvin - 6500.0) < 10 and abs(tint) < 0.005:
            return image

        tr, tg, tb = _kelvin_to_rgb_gains(temp_kelvin)
        nr, ng, nb = _kelvin_to_rgb_gains(6500.0)

        rg = tr / max(nr, 1e-7)
        gg = tg / max(ng, 1e-7)
        bg = tb / max(nb, 1e-7)

        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        arr[..., 0] = np.clip(arr[..., 0] * rg, 0, 1)
        arr[..., 1] = np.clip(arr[..., 1] * gg, 0, 1)
        arr[..., 2] = np.clip(arr[..., 2] * bg, 0, 1)

        # Tint: green(+) ↔ magenta(-) axis
        if tint != 0.0:
            arr[..., 1] = np.clip(arr[..., 1] * (1.0 + tint * 0.14), 0, 1)
            arr[..., 0] = np.clip(arr[..., 0] * (1.0 - tint * 0.07), 0, 1)
            arr[..., 2] = np.clip(arr[..., 2] * (1.0 - tint * 0.07), 0, 1)

        return Image.fromarray((arr * 255.0).round().astype(np.uint8), mode="RGB")

    else:
        # Auto or Smart AWB using numpy
        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        r_ch, g_ch, b_ch = arr[..., 0], arr[..., 1], arr[..., 2]

        if wb_mode == "smart":
            # Compute luminance
            luma = 0.299 * r_ch + 0.587 * g_ch + 0.114 * b_ch
            # Compute saturation
            max_val = np.maximum(np.maximum(r_ch, g_ch), b_ch)
            min_val = np.minimum(np.minimum(r_ch, g_ch), b_ch)
            sat = np.zeros_like(max_val)
            mask_nonzero = max_val > 1e-5
            sat[mask_nonzero] = (max_val[mask_nonzero] - min_val[mask_nonzero]) / max_val[mask_nonzero]

            # Mask valid pixels: exclude too dark/bright and highly saturated pixels
            valid_mask = (luma > 0.06) & (luma < 0.94) & (sat < 0.35)

            if np.sum(valid_mask) > 100:
                avg_r = np.mean(r_ch[valid_mask])
                avg_g = np.mean(g_ch[valid_mask])
                avg_b = np.mean(b_ch[valid_mask])
            else:
                # Fallback to standard averages if too few valid pixels
                avg_r = np.mean(r_ch)
                avg_g = np.mean(g_ch)
                avg_b = np.mean(b_ch)
        else:
            # Standard Grey World
            avg_r = np.mean(r_ch)
            avg_g = np.mean(g_ch)
            avg_b = np.mean(b_ch)

        gray = (avg_r + avg_g + avg_b) / 3.0

        rg = gray / max(avg_r, 1e-5)
        gg = gray / max(avg_g, 1e-5)
        bg = gray / max(avg_b, 1e-5)

        if wb_mode == "smart":
            # Keep 80% correction to avoid clinical neutralizing
            rg = 1.0 + 0.8 * (rg - 1.0)
            gg = 1.0 + 0.8 * (gg - 1.0)
            bg = 1.0 + 0.8 * (bg - 1.0)
            # Clip gains to robust range
            rg = np.clip(rg, 0.65, 1.5)
            gg = np.clip(gg, 0.65, 1.5)
            bg = np.clip(bg, 0.65, 1.5)
        else:
            # Clip gains to standard range
            rg = np.clip(rg, 0.5, 2.0)
            gg = np.clip(gg, 0.5, 2.0)
            bg = np.clip(bg, 0.5, 2.0)

        arr[..., 0] = np.clip(r_ch * rg, 0, 1)
        arr[..., 1] = np.clip(g_ch * gg, 0, 1)
        arr[..., 2] = np.clip(b_ch * bg, 0, 1)

        return Image.fromarray((arr * 255.0).round().astype(np.uint8), mode="RGB")


def _generate_luminosity_masks(arr: np.ndarray, levels: int = 3) -> list[np.ndarray]:
    """
    Generate smooth overlapping luminosity masks.
    For levels=3, returns [shadows, midtones, highlights].
    """
    luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
    if levels == 3:
        shadows = (1.0 - luma) * (1.0 - luma)
        highlights = luma * luma
        midtones = 4.0 * luma * (1.0 - luma)
        return [shadows, midtones, highlights]
    else:
        centers = np.linspace(0.0, 1.0, levels)
        variance = 1.0 / (2.0 * (levels - 1)) if levels > 1 else 0.5
        masks = []
        for center in centers:
            mask = np.exp(-((luma - center) ** 2) / (2.0 * (variance ** 2)))
            masks.append(mask)
        return masks


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

    if light_balance != 0.0 or highlights != 0.0 or shadows != 0.0:
        sh_mask, mid_mask, hl_mask = _generate_luminosity_masks(arr, levels=3)
        
        if light_balance != 0.0:
            arr += float(light_balance) * 0.10 * mid_mask[..., None]

        if highlights != 0.0:
            arr += float(highlights) * 0.18 * hl_mask[..., None] * (1.0 - arr)

        if shadows != 0.0:
            arr += float(shadows) * 0.18 * sh_mask[..., None] * (1.0 - arr)

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

    if mode == "RetroFilm":
        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        highlight_mask = np.clip((luma - 0.4) * 1.66, 0.0, 1.0)[..., None]
        arr[..., 0] += strength * 0.15 * highlight_mask[..., 0]
        arr[..., 1] += strength * 0.07 * highlight_mask[..., 0]
        arr[..., 2] -= strength * 0.08 * highlight_mask[..., 0]
        shadow_mask = np.clip((0.6 - luma) * 1.66, 0.0, 1.0)[..., None]
        arr[..., 0] -= strength * 0.05 * shadow_mask[..., 0]
        arr[..., 2] += strength * 0.12 * shadow_mask[..., 0]
        arr = arr * 0.95 + 0.03 * strength
        h, w = arr.shape[:2]
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        leak_dir = (seed % 2)
        if leak_dir == 0:
            gradient = np.clip(1.0 - (xx / w), 0.0, 1.0)
        else:
            gradient = np.clip(xx / w, 0.0, 1.0)
        gradient = np.power(gradient, 3.5)
        arr[..., 0] += strength * 0.35 * gradient
        arr[..., 1] += strength * 0.12 * gradient
        arr = np.clip(arr, 0.0, 1.0)
        return Image.fromarray((arr * 255.0).round().astype(np.uint8), mode="RGB")

    if mode == "Duotone":
        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        r = 0.05 * (1.0 - luma) + 0.95 * luma
        g = 0.05 * (1.0 - luma) + 0.75 * luma
        b = 0.25 * (1.0 - luma) + 0.25 * luma
        duo = np.stack([r, g, b], axis=-1)
        out = arr * (1.0 - strength) + duo * strength
        return Image.fromarray((np.clip(out, 0.0, 1.0) * 255.0).round().astype(np.uint8), mode="RGB")

    if mode == "Matte":
        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        lift = 0.12 * strength
        arr = lift + (1.0 - lift) * arr
        arr = arr * (1.0 - 0.08 * strength)
        arr = (arr - 0.5) * (1.0 - 0.15 * strength) + 0.5
        return Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0).round().astype(np.uint8), mode="RGB")

    return image


def _apply_color_look(image: Image.Image, look_name: str, intensity: float) -> Image.Image:
    if intensity <= 0 or look_name == "None":
        return image

    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0

    if look_name == "Teal & Orange":
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        shadow_mask = np.clip((0.5 - luma) * 2.0, 0.0, 1.0)
        arr[..., 0] -= intensity * 0.08 * shadow_mask
        arr[..., 1] += intensity * 0.05 * shadow_mask
        arr[..., 2] += intensity * 0.15 * shadow_mask
        highlight_mask = np.clip((luma - 0.5) * 2.0, 0.0, 1.0)
        arr[..., 0] += intensity * 0.15 * highlight_mask
        arr[..., 1] += intensity * 0.06 * highlight_mask
        arr[..., 2] -= intensity * 0.10 * highlight_mask

    elif look_name == "Kodak Portra":
        arr[..., 0] *= 1.0 + intensity * 0.05
        arr[..., 2] *= 1.0 - intensity * 0.05
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        arr = arr * (1.0 - intensity * 0.15) + luma[..., None] * (intensity * 0.15)
        arr = (arr - 0.5) * (1.0 - intensity * 0.08) + 0.5

    elif look_name == "Fuji Superia":
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        shadow_mask = np.clip((0.45 - luma) * 2.2, 0.0, 1.0)
        arr[..., 0] += intensity * 0.04 * shadow_mask
        arr[..., 2] += intensity * 0.08 * shadow_mask
        arr[..., 1] *= 1.0 + intensity * 0.08
        arr[..., 0] *= 1.0 + intensity * 0.06

    elif look_name == "Monochrome Noir":
        luma = arr[..., 0] * 0.60 + arr[..., 1] * 0.35 + arr[..., 2] * 0.05
        luma = np.clip((luma - 0.45) * (1.0 + intensity * 0.5) + 0.45, 0.0, 1.0)
        bw = np.stack([luma, luma, luma], axis=-1)
        arr = arr * (1.0 - intensity) + bw * intensity

    elif look_name == "Vintage Gold":
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        arr = arr * (1.0 - intensity * 0.08) + intensity * 0.08
        arr[..., 0] *= 1.0 + intensity * 0.12
        arr[..., 1] *= 1.0 + intensity * 0.08
        arr[..., 2] *= 1.0 - intensity * 0.12
        arr = arr * (1.0 - intensity * 0.20) + luma[..., None] * (intensity * 0.20)

    elif look_name == "Cyberpunk":
        luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
        shadow_mask = np.clip((0.5 - luma) * 2.0, 0.0, 1.0)
        arr[..., 0] += intensity * 0.16 * shadow_mask
        arr[..., 2] += intensity * 0.16 * shadow_mask
        arr[..., 1] -= intensity * 0.08 * shadow_mask
        highlight_mask = np.clip((luma - 0.5) * 2.0, 0.0, 1.0)
        arr[..., 0] -= intensity * 0.12 * highlight_mask
        arr[..., 1] += intensity * 0.16 * highlight_mask
        arr[..., 2] += intensity * 0.16 * highlight_mask

    return Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0).round().astype(np.uint8), mode="RGB")



def _rgb_to_lab(img_rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Convert RGB image to OpenCV's 8-bit LAB representation (L, a, b in [0, 255]).
    img_rgb is a numpy array of shape (H, W, 3) and dtype uint8 or float32.
    """
    arr = img_rgb.astype(np.float32)
    if arr.max() > 1.0:
        arr = arr / 255.0

    # sRGB linearization
    mask = arr > 0.04045
    arr_linear = np.empty_like(arr)
    arr_linear[mask] = ((arr[mask] + 0.055) / 1.055) ** 2.4
    arr_linear[~mask] = arr[~mask] / 12.92

    # RGB to XYZ
    r, g, b = arr_linear[..., 0], arr_linear[..., 1], arr_linear[..., 2]
    # D65 white point normalized coordinates
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883

    # Clamp XYZ to avoid negative values
    x = np.maximum(x, 0.0)
    y = np.maximum(y, 0.0)
    z = np.maximum(z, 0.0)

    # Nonlinear transformation f(t)
    def f(t):
        mask_t = t > 0.008856
        res = np.empty_like(t)
        res[mask_t] = np.cbrt(t[mask_t])
        res[~mask_t] = 7.787 * t[~mask_t] + 16.0 / 116.0
        return res

    fx = f(x)
    fy = f(y)
    fz = f(z)

    # Standard LAB
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)

    # Scale to OpenCV 8-bit LAB representation [0, 255]
    L_cv = L * (255.0 / 100.0)
    a_cv = a + 128.0
    b_cv = b + 128.0

    return L_cv, a_cv, b_cv


def _lab_to_rgb(L_cv: np.ndarray, a_cv: np.ndarray, b_cv: np.ndarray) -> np.ndarray:
    """
    Convert OpenCV's 8-bit LAB representation (L, a, b in [0, 255]) back to RGB.
    Returns RGB image as float32 numpy array with values in [0, 255].
    """
    # Scale from OpenCV 8-bit LAB to Standard LAB
    L = L_cv * (100.0 / 255.0)
    a = a_cv - 128.0
    b = b_cv - 128.0

    y = (L + 16.0) / 116.0
    x = a / 500.0 + y
    z = y - b / 200.0

    def f_inv(t):
        t3 = t ** 3
        mask_t = t3 > 0.008856
        res = np.empty_like(t)
        res[mask_t] = t3[mask_t]
        res[~mask_t] = (t[~mask_t] - 16.0 / 116.0) / 7.787
        return res

    x_norm = f_inv(x) * 0.95047
    y_norm = f_inv(y) * 1.00000
    z_norm = f_inv(z) * 1.08883

    # XYZ to linear RGB
    r_linear = x_norm * 3.2404542 + y_norm * -1.5371385 + z_norm * -0.4985314
    g_linear = x_norm * -0.9692660 + y_norm * 1.8760108 + z_norm * 0.0415560
    b_linear = x_norm * 0.0556434 + y_norm * -0.2040259 + z_norm * 1.0572252

    # Clip linear RGB to [0, 1]
    r_linear = np.clip(r_linear, 0.0, 1.0)
    g_linear = np.clip(g_linear, 0.0, 1.0)
    b_linear = np.clip(b_linear, 0.0, 1.0)

    # linear RGB to sRGB
    def to_srgb(c):
        mask_c = c > 0.0031308
        res = np.empty_like(c)
        res[mask_c] = 1.055 * (c[mask_c] ** (1.0 / 2.4)) - 0.055
        res[~mask_c] = 12.92 * c[~mask_c]
        return res

    r = to_srgb(r_linear)
    g = to_srgb(g_linear)
    b = to_srgb(b_linear)

    rgb = np.stack([r, g, b], axis=-1)
    return np.clip(rgb * 255.0, 0.0, 255.0)


def _apply_style_transfer(image: Image.Image, ref_stats: dict, intensity: float) -> Image.Image:
    if intensity <= 0 or not ref_stats:
        return image
    
    # Convert image to numpy RGB
    arr = np.asarray(image.convert("RGB"), dtype=np.uint8)
    
    # Convert to LAB
    l, a, b = _rgb_to_lab(arr)
    
    # Target (source) stats
    l_mean_src, l_std_src = l.mean(), l.std()
    a_mean_src, a_std_src = a.mean(), a.std()
    b_mean_src, b_std_src = b.mean(), b.std()
    
    # Reference stats
    l_mean_ref = ref_stats.get("l_mean", l_mean_src)
    l_std_ref = ref_stats.get("l_std", l_std_src)
    a_mean_ref = ref_stats.get("a_mean", a_mean_src)
    a_std_ref = ref_stats.get("a_std", a_std_src)
    b_mean_ref = ref_stats.get("b_mean", b_mean_src)
    b_std_ref = ref_stats.get("b_std", b_std_src)
    
    # Avoid division by zero
    l_std_src = max(l_std_src, 1e-4)
    a_std_src = max(a_std_src, 1e-4)
    b_std_src = max(b_std_src, 1e-4)
    
    # Reinhard transfer
    l_out = (l - l_mean_src) * (l_std_ref / l_std_src) + l_mean_ref
    a_out = (a - a_mean_src) * (a_std_ref / a_std_src) + a_mean_ref
    b_out = (b - b_mean_src) * (b_std_ref / b_std_src) + b_mean_ref
    
    # Clip and convert back to RGB
    l_out = np.clip(l_out, 0, 255)
    a_out = np.clip(a_out, 0, 255)
    b_out = np.clip(b_out, 0, 255)
    
    out_rgb = _lab_to_rgb(l_out, a_out, b_out)
    
    # Blend with original based on intensity
    if intensity < 1.0:
        out_rgb = arr.astype(np.float32) * (1.0 - intensity) + out_rgb * intensity
        out_rgb = np.clip(out_rgb, 0, 255)
        
    return Image.fromarray(out_rgb.astype(np.uint8), mode="RGB")

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


def _load_via_pillow(path: str) -> tuple:
    image = Image.open(path).convert("RGB")
    exif_bytes = image.info.get("exif", b"")
    arr = np.asarray(image, dtype=np.float32) / 255.0
    return arr[np.newaxis, ...], exif_bytes


def _load_via_rawpy(path: str) -> np.ndarray:
    if not RAW_SUPPORT:
        raise RuntimeError("rawpy is not installed.")
    with rawpy.imread(path) as raw:
        rgb = raw.postproc()
    arr = np.asarray(Image.fromarray(rgb), dtype=np.float32) / 255.0
    return arr[np.newaxis, ...]



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


class OneArtPhotoSplitToning:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "shadow_color": ("STRING", {"default": "#102040"}),
                "highlight_color": ("STRING", {"default": "#ffaa20"}),
                "balance": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, shadow_color, highlight_color, balance):
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            arr = np.asarray(_tensor_to_pil(images[index]), dtype=np.uint8)
            toned = _apply_split_toning(arr, shadow_color, highlight_color, balance)
            output.append(_pil_to_tensor(Image.fromarray(toned)))
        return (torch.stack(output, dim=0),)


class OneArtPhotoGradientMap:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "preset": (["Sunset", "Forest", "Cyberpunk", "Vintage", "B&W"], {"default": "Sunset"}),
                "intensity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "oneart/photo"

    def apply(self, images, preset, intensity):
        presets = {
            "Sunset": [(0.07, 0.05, 0.18), (0.87, 0.25, 0.2), (1.0, 0.77, 0.35)],
            "Forest": [(0.05, 0.08, 0.05), (0.35, 0.45, 0.25), (0.9, 0.92, 0.8)],
            "Cyberpunk": [(0.05, 0.0, 0.15), (0.9, 0.0, 0.5), (0.0, 0.95, 1.0)],
            "Vintage": [(0.12, 0.07, 0.05), (0.68, 0.52, 0.35), (0.95, 0.92, 0.85)],
            "B&W": [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)]
        }
        colors = presets.get(preset, presets["Sunset"])
        
        images = _ensure_batch(images)
        output = []
        for index in range(images.shape[0]):
            image = _tensor_to_pil(images[index])
            arr = np.asarray(image, dtype=np.uint8)
            mapped = _apply_gradient_map(arr, colors)
            if intensity < 1.0:
                mapped = (arr.astype(np.float32) * (1.0 - intensity) + mapped.astype(np.float32) * intensity).clip(0, 255).astype(np.uint8)
            output.append(_pil_to_tensor(Image.fromarray(mapped)))
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
    "OneArtPhotoSplitToning": OneArtPhotoSplitToning,
    "OneArtPhotoGradientMap": OneArtPhotoGradientMap,
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
    "OneArtPhotoSplitToning": "OneArt Photo Split Toning",
    "OneArtPhotoGradientMap": "OneArt Photo Gradient Map",
}


def _apply_split_toning(
    arr: np.ndarray, 
    shadow_color: tuple[float, float, float] | list[float] | str, 
    highlight_color: tuple[float, float, float] | list[float] | str, 
    balance: float
) -> np.ndarray:
    """
    Apply split-toning using a smooth luminance mask.
    Accepts hex colors (str) or RGB tuples/lists.
    """
    is_uint8 = arr.dtype == np.uint8
    working_arr = arr.astype(np.float32) / 255.0 if is_uint8 else arr.copy()
    
    # Helper to parse colors
    def parse_color(c) -> np.ndarray:
        if isinstance(c, str):
            c = c.lstrip('#')
            if len(c) == 6:
                return np.array([int(c[i:i+2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0
        return np.array(c, dtype=np.float32) / (255.0 if np.array(c).max() > 1.0 else 1.0)
        
    sh_color = parse_color(shadow_color)
    hl_color = parse_color(highlight_color)
    
    # Calculate luminance
    luma = working_arr[..., 0] * 0.299 + working_arr[..., 1] * 0.587 + working_arr[..., 2] * 0.114
    
    # Shift balance
    luma_shifted = np.clip(luma - balance * 0.2, 0.0, 1.0)
    highlight_mask = luma_shifted * luma_shifted
    shadow_mask = (1.0 - luma_shifted) * (1.0 - luma_shifted)
    
    # Blend tinting
    shadow_tint = working_arr * sh_color
    highlight_tint = working_arr * hl_color
    
    blended = working_arr.copy()
    blended = blended * (1.0 - shadow_mask[..., None]) + shadow_tint * shadow_mask[..., None]
    blended = blended * (1.0 - highlight_mask[..., None]) + highlight_tint * highlight_mask[..., None]
    
    # Preserve original luminance to prevent brightness changes
    luma_new = blended[..., 0] * 0.299 + blended[..., 1] * 0.587 + blended[..., 2] * 0.114
    luma_ratio = np.where(luma_new > 1e-5, luma / luma_new, 1.0)[..., None]
    blended = np.clip(blended * luma_ratio, 0.0, 1.0)
    
    return (blended * 255.0).round().astype(np.uint8) if is_uint8 else blended


def _apply_gradient_map(arr: np.ndarray, gradient_colors: list[tuple[float, float, float]]) -> np.ndarray:
    n_colors = len(gradient_colors)
    if n_colors < 2:
        return arr
        
    is_uint8 = arr.dtype == np.uint8
    working_arr = arr.astype(np.float32) / 255.0 if is_uint8 else arr.copy()
    
    luma = working_arr[..., 0] * 0.299 + working_arr[..., 1] * 0.587 + working_arr[..., 2] * 0.114
    colors_arr = np.array(gradient_colors, dtype=np.float32)
    if colors_arr.max() > 1.0:
        colors_arr /= 255.0
        
    xp = np.linspace(0.0, 1.0, n_colors)
    r_mapped = np.interp(luma, xp, colors_arr[:, 0])
    g_mapped = np.interp(luma, xp, colors_arr[:, 1])
    b_mapped = np.interp(luma, xp, colors_arr[:, 2])
    
    mapped_arr = np.stack([r_mapped, g_mapped, b_mapped], axis=-1)
    
    return (mapped_arr * 255.0).round().astype(np.uint8) if is_uint8 else mapped_arr


def _calculate_color_covariance_transfer(src_arr: np.ndarray, ref_stats: dict) -> np.ndarray:
    src_rgb = src_arr.astype(np.uint8) if src_arr.dtype != np.uint8 else src_arr
    
    # Convert to LAB using existing methods in nodes.py
    src_l, src_a, src_b = _rgb_to_lab(src_rgb)
    
    src_pixels = np.stack([src_l.ravel(), src_a.ravel(), src_b.ravel()], axis=0)
    src_mean = src_pixels.mean(axis=1, keepdims=True)
    src_cov = np.cov(src_pixels) + 1e-5 * np.eye(3)
    
    # Reference stats
    ref_mean = np.array([
        [ref_stats.get("l_mean", src_mean[0, 0])],
        [ref_stats.get("a_mean", src_mean[1, 0])],
        [ref_stats.get("b_mean", src_mean[2, 0])]
    ], dtype=np.float32)
    
    if "cov_matrix" in ref_stats:
        ref_cov = np.array(ref_stats["cov_matrix"], dtype=np.float32)
    else:
        # Fallback to standard deviations if covariance matrix is not stored
        ref_std = np.array([
            ref_stats.get("l_std", 15.0),
            ref_stats.get("a_std", 5.0),
            ref_stats.get("b_std", 5.0)
        ], dtype=np.float32)
        ref_cov = np.diag(ref_std ** 2) + 1e-5 * np.eye(3)
        
    def matrix_sqrt_and_inv_sqrt(cov):
        evals, evecs = np.linalg.eigh(cov)
        evals = np.maximum(evals, 1e-6)
        sqrt_evals = np.sqrt(evals)
        cov_sqrt = evecs @ np.diag(sqrt_evals) @ evecs.T
        cov_inv_sqrt = evecs @ np.diag(1.0 / sqrt_evals) @ evecs.T
        return cov_sqrt, cov_inv_sqrt

    ref_sqrt, _ = matrix_sqrt_and_inv_sqrt(ref_cov)
    _, src_inv_sqrt = matrix_sqrt_and_inv_sqrt(src_cov)
    
    T = ref_sqrt @ src_inv_sqrt
    trans_pixels = T @ (src_pixels - src_mean) + ref_mean
    
    h, w = src_l.shape
    l_out = np.clip(trans_pixels[0].reshape((h, w)), 0.0, 255.0)
    a_out = np.clip(trans_pixels[1].reshape((h, w)), 0.0, 255.0)
    b_out = np.clip(trans_pixels[2].reshape((h, w)), 0.0, 255.0)
    
    out_rgb = _lab_to_rgb(l_out, a_out, b_out)
    return np.clip(out_rgb, 0.0, 255.0).astype(np.uint8)


def _apply_radial_chromatic_aberration(arr: np.ndarray, strength: float, center: tuple[float, float] = (0.5, 0.5)) -> np.ndarray:
    if strength == 0.0:
        return arr
        
    is_uint8 = arr.dtype == np.uint8
    working_arr = arr.astype(np.float32) / 255.0 if is_uint8 else arr.copy()
    h, w, c = working_arr.shape
    cy, cx = center[1] * h, center[0] * w
    
    yy, xx = np.mgrid[0:h, 0:w]
    dy, dx = yy - cy, xx - cx
    r = np.sqrt(dx*dx + dy*dy)
    max_r = np.sqrt(cx*cx + cy*cy)
    if max_r == 0: max_r = 1.0
    
    try:
        from scipy.ndimage import map_coordinates
        # Subpixel mapping
        r_scale = 1.0 + strength * 0.04 * (r / max_r)
        ry, rx = cy + dy * r_scale, cx + dx * r_scale
        coords_r = np.stack([ry.ravel(), rx.ravel()], axis=0)
        red = map_coordinates(working_arr[..., 0], coords_r, order=1, mode='nearest').reshape((h, w))
        
        b_scale = 1.0 - strength * 0.04 * (r / max_r)
        by, bx = cy + dy * b_scale, cx + dx * b_scale
        coords_b = np.stack([by.ravel(), bx.ravel()], axis=0)
        blue = map_coordinates(working_arr[..., 2], coords_b, order=1, mode='nearest').reshape((h, w))
        
        out = np.stack([red, working_arr[..., 1], blue], axis=-1)
    except ImportError:
        # Nearest neighbor lookup fallback
        r_scale = 1.0 + strength * 0.04 * (r / max_r)
        rx = np.clip(cx + dx * r_scale, 0, w - 1).astype(np.int32)
        ry = np.clip(cy + dy * r_scale, 0, h - 1).astype(np.int32)
        
        b_scale = 1.0 - strength * 0.04 * (r / max_r)
        bx = np.clip(cx + dx * b_scale, 0, w - 1).astype(np.int32)
        by = np.clip(cy + dy * b_scale, 0, h - 1).astype(np.int32)
        
        out = working_arr.copy()
        out[..., 0] = working_arr[ry, rx, 0]
        out[..., 2] = working_arr[by, bx, 2]
        
    return (np.clip(out, 0.0, 1.0) * 255.0).round().astype(np.uint8) if is_uint8 else np.clip(out, 0.0, 1.0)

def _apply_curves(image: Image.Image, curves: dict) -> Image.Image:
    """Apply RGB and channel tone curves using numpy interpolation."""
    if not curves:
        return image
    
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    xp = np.linspace(0.0, 1.0, 256)
    
    c_red = curves.get("red")
    c_green = curves.get("green")
    c_blue = curves.get("blue")
    c_rgb = curves.get("rgb")
    
    # Apply individual channel curves
    if c_red and len(c_red) == 256:
        fp_r = np.array(c_red, dtype=np.float32) / 255.0
        arr[..., 0] = np.interp(arr[..., 0], xp, fp_r)
        
    if c_green and len(c_green) == 256:
        fp_g = np.array(c_green, dtype=np.float32) / 255.0
        arr[..., 1] = np.interp(arr[..., 1], xp, fp_g)
        
    if c_blue and len(c_blue) == 256:
        fp_b = np.array(c_blue, dtype=np.float32) / 255.0
        arr[..., 2] = np.interp(arr[..., 2], xp, fp_b)
        
    # Apply master RGB curve
    if c_rgb and len(c_rgb) == 256:
        fp_rgb = np.array(c_rgb, dtype=np.float32) / 255.0
        for channel in range(3):
            arr[..., channel] = np.interp(arr[..., channel], xp, fp_rgb)
            
    arr = np.clip(arr * 255.0, 0, 255).round().astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def export_3d_lut(params: dict, out_path: str) -> None:
    """
    Generate a 3D LUT by passing a 3D RGB grid through the color grading pipeline,
    and save it in Adobe .cube format.
    """
    lut_size = 32
    grid = np.mgrid[0:lut_size, 0:lut_size, 0:lut_size].astype(np.float32) / (lut_size - 1)
    
    b_ch, g_ch, r_ch = grid[2], grid[1], grid[0]
    rgb_flat = np.stack([r_ch, g_ch, b_ch], axis=-1).reshape(-1, 3)
    
    arr_3d = rgb_flat.reshape(lut_size, lut_size * lut_size, 3)
    arr_uint8 = (arr_3d * 255.0).round().astype(np.uint8)
    image = Image.fromarray(arr_uint8, mode="RGB")
    
    # 1. LUT Look
    lut_look = params.get("lut_look", "None")
    lut_intensity = float(params.get("lut_intensity", 0.0))
    if lut_look != "None" and lut_intensity > 0:
        image = _apply_color_look(image, lut_look, lut_intensity)

    # 2. Color Temperature / White Balance
    if params.get("whitebalance_enabled", True):
        image = _apply_color_temperature(
            image,
            temp_kelvin=float(params.get("color_temp", 6500.0)),
            tint=float(params.get("color_tint", 0.0)),
            wb_mode=str(params.get("whitebalance_mode", "manual")),
        )

    # 3. Tone Adjust
    image = _apply_tone_adjustment(
        image,
        brightness=float(params.get("brightness", 1.16)),
        contrast=float(params.get("contrast", 1.01)),
        light_balance=float(params.get("light_balance", 0.36)),
        highlights=float(params.get("highlights", 0.53)),
        shadows=float(params.get("shadows", -0.02)),
        warmth=float(params.get("warmth", 0.04)),
    )

    # 4. Saturation + Vibrance
    if params.get("saturation_enabled", True):
        image = _apply_saturation_vibrance(
            image,
            saturation=float(params.get("saturation", 0.0)),
            vibrance=float(params.get("vibrance", 0.0)),
        )

    # 5. Tone Curves (v6.0)
    if params.get("curves_enabled", False) and params.get("curves"):
        image = _apply_curves(image, params.get("curves"))

    # 6. Style Transfer (v5.1)
    if params.get("style_transfer_enabled", False) and params.get("style_transfer_stats") is not None and params.get("style_transfer_mode", "pixel") == "pixel":
        image = _apply_style_transfer(
            image, 
            params.get("style_transfer_stats"), 
            float(params.get("style_transfer_intensity", 1.0))
        )
        
    res_arr = np.asarray(image, dtype=np.float32) / 255.0
    res_flat = res_arr.reshape(-1, 3)
    
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("# Generated by OneArt Photo Studio v6.0\n")
        f.write(f"LUT_3D_SIZE {lut_size}\n\n")
        for i in range(res_flat.shape[0]):
            r, g, b = res_flat[i]
            f.write(f"{r:.6f} {g:.6f} {b:.6f}\n")


