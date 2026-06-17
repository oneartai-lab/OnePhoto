"""
OneArt Photo Studio — Standalone Desktop Application  v5
===========================================================
A premium photo-processing desktop app built on top of the
OneArt Photo node library.  No ComfyUI server required —
all processing runs locally via NumPy / Pillow.

Launch:
    python start_app.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import traceback
from pathlib import Path

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
#  Resolve paths & Shims
# ---------------------------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

FRONTEND_DIR = APP_DIR / "frontend"
OUTPUT_DIR = Path.home() / "Downloads"
OUTPUT_DIR.mkdir(exist_ok=True)

# Define folder_paths shim since ComfyUI nodes expect it
_folder_paths_shim = type(sys)("folder_paths")
_folder_paths_shim.base_path = str(APP_DIR)
_folder_paths_shim.get_output_directory = lambda: str(OUTPUT_DIR)  # ~/Downloads
sys.modules["folder_paths"] = _folder_paths_shim

# Now import the processing helpers directly from the local engine package
from engine.nodes import (
    _add_noise,
    _apply_grain,
    _apply_sharpness,
    _apply_saturation_vibrance,
    _apply_color_temperature,
    _apply_style_fx,
    _apply_tone_adjustment,
    _apply_vignette,
    build_exif_bytes,
    _write_jpeg_with_exif,
    _encode_exif,
    _decode_exif,
    RAW_SUPPORT,
    _apply_curves,
    export_3d_lut,
    _apply_split_toning,
    _apply_gradient_map,
    _calculate_color_covariance_transfer,
    _apply_radial_chromatic_aberration,
)

from engine.lens_distortion_safe import _warp


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def _pil_to_base64(image: Image.Image, fmt: str = "JPEG", quality: int = 92) -> str:
    """Convert a PIL Image to a data-URI base64 string."""
    buf = io.BytesIO()
    if fmt.upper() == "PNG":
        image.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"
    else:
        image.save(buf, format=fmt, quality=quality)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{b64}"


_RAW_EXTENSIONS = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raf', '.pef', '.srw'}


def _load_pil(path: str, raw_params: dict | None = None) -> Image.Image:
    """Load an image from disk. Supports JPEG/PNG/TIFF/WebP and RAW formats."""
    import pathlib
    ext = pathlib.Path(path).suffix.lower()
    if ext in _RAW_EXTENSIONS and RAW_SUPPORT:
        try:
            import rawpy
            user_exp_gain = 1.0
            demosaic = rawpy.DemosaicAlgorithm.AHD
            highlight_mode = 10  # Blend
            
            if raw_params and raw_params.get("raw_develop_enabled", False):
                ev = float(raw_params.get("raw_exposure", 0.0))
                user_exp_gain = 2.0 ** ev
                
                dm_str = raw_params.get("raw_demosaic", "AHD")
                if dm_str == "PPG":
                    demosaic = rawpy.DemosaicAlgorithm.PPG
                elif dm_str == "VNG":
                    demosaic = rawpy.DemosaicAlgorithm.VNG
                elif dm_str == "Bilinear":
                    demosaic = rawpy.DemosaicAlgorithm.LINEAR
                else:
                    demosaic = rawpy.DemosaicAlgorithm.AHD
                    
                hl_str = raw_params.get("raw_highlight_mode", "blend")
                if hl_str == "reconstruct":
                    highlight_mode = 3
                elif hl_str == "clip":
                    highlight_mode = 0
                else:
                    highlight_mode = 10
            
            with rawpy.imread(path) as raw:
                rgb = raw.postprocess(
                    use_camera_wb=True,
                    half_size=False,
                    no_auto_bright=False,
                    output_bps=8,
                    user_exp_gain=user_exp_gain,
                    demosaic_algorithm=demosaic,
                    highlight_mode=highlight_mode
                )
            return Image.fromarray(rgb, mode="RGB")
        except Exception as e:
            print(f"[RAW] decode failed ({e}), trying PIL fallback")
    return Image.open(path).convert("RGB")


def _process_single_worker(filepath: str, params: dict, output_dir: str) -> tuple[str, bool, str]:
    """Helper target for ProcessPoolExecutor worker. Returns (filepath, success, error_msg/filename)."""
    try:
        import os
        import io
        import random
        from pathlib import Path
        from datetime import datetime
        from PIL import Image
        import numpy as np
        
        # Now import the processing helpers directly
        from engine.nodes import (
            _add_noise,
            _apply_grain,
            _apply_sharpness,
            _apply_saturation_vibrance,
            _apply_color_temperature,
            _apply_style_fx,
            _apply_tone_adjustment,
            _apply_vignette,
            build_exif_bytes,
            _write_jpeg_with_exif,
            _apply_curves,
            _apply_split_toning,
            _apply_gradient_map,
            _calculate_color_covariance_transfer,
            _apply_radial_chromatic_aberration,
        )

        from engine.lens_distortion_safe import _warp
        
        image = _load_pil(filepath, params)
        w, h = image.size
        
        # 1. Crop
        if params.get("crop_enabled", False):
            cx = float(params.get("crop_x", 0)) / 100.0
            cy = float(params.get("crop_y", 0)) / 100.0
            cw = float(params.get("crop_w", 100)) / 100.0
            ch = float(params.get("crop_h", 100)) / 100.0
            left = int(cx * w)
            top = int(cy * h)
            right = int(min(w, (cx + cw) * w))
            bottom = int(min(h, (cy + ch) * h))
            if right > left and bottom > top:
                image = image.crop((left, top, right, bottom))
                
        # 2. Resize
        scale = float(params.get("resize_scale", 100)) / 100.0
        width_override = params.get("resize_width", "")
        height_override = params.get("resize_height", "")
        w, h = image.size
        if width_override or height_override:
            try:
                target_w = int(width_override) if width_override else int(w * (int(height_override)/h))
                target_h = int(height_override) if height_override else int(h * (int(width_override)/w))
                image = image.resize((target_w, target_h), Image.LANCZOS)
            except Exception:
                pass
        elif scale < 1.0:
            image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            
        # 3. LUT
        lut_look = params.get("lut_look", "None")
        lut_intensity = float(params.get("lut_intensity", 0.0))
        if lut_look != "None" and lut_intensity > 0:
            from engine.nodes import _apply_color_look
            image = _apply_color_look(image, lut_look, lut_intensity)
            
        # 3b. White Balance
        if params.get("whitebalance_enabled", True):
            image = _apply_color_temperature(
                image,
                temp_kelvin=float(params.get("color_temp", 6500.0)),
                tint=float(params.get("color_tint", 0.0)),
                wb_mode=str(params.get("whitebalance_mode", "manual")),
            )
            
        # 4. Noise
        arr = np.asarray(image, dtype=np.float32)
        noisy = _add_noise(arr, float(params.get("noise_level", 0.02)),
                           float(params.get("blue_bias", 0.8)))
        image = Image.fromarray(noisy.astype(np.uint8), mode="RGB")
        
        # 5. Grain
        image = _apply_grain(image,
                             float(params.get("grain_strength", 0.3)),
                             int(params.get("grain_size", 2)),
                             bool(params.get("grain_luminosity_mask", False)))
                             
        # 6. Lens Warp
        arr = np.asarray(image, dtype=np.float32)
        ab_radial = params.get("aberration_radial", False)
        dist = float(params.get("distortion", 0.03))
        ab_strength = float(params.get("chromatic_aberration", 0.1))
        
        warped = _warp(arr, dist, 0.0 if ab_radial else ab_strength)
        image = Image.fromarray(warped, mode="RGB")
        if ab_radial and ab_strength > 0:
            image = Image.fromarray(_apply_radial_chromatic_aberration(np.asarray(image, dtype=np.uint8), ab_strength), mode="RGB")
            
        edge_softness = float(params.get("edge_softness", 0.15))
        if edge_softness > 0:
            from PIL import ImageFilter
            blurred = image.filter(
                ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 12.0))
            )
            w, h = image.size
            yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
            nx = (xx - w / 2.0) / (w / 2.0)
            ny = (yy - h / 2.0) / (h / 2.0)
            radius = np.sqrt(nx * nx + ny * ny)
            falloff = np.clip(1.0 - (radius ** 2) * (0.55 + edge_softness), 0.0, 1.0)
            mask = Image.fromarray(
                (falloff * 255.0).astype(np.uint8), mode="L"
            ).filter(ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 20.0)))
            image = Image.composite(image, blurred, mask)
            
        # 7. Style FX
        mode = str(params.get("mode", "Bloom"))
        # 8. Vignette
        image = _apply_vignette(
            image,
            float(params.get("outer_brightness", 0.05)),
            float(params.get("inner_brightness", 0.2)),
        )
        
        # 9. Tone Adjust
        image = _apply_tone_adjustment(
            image,
            brightness=float(params.get("brightness", 1.16)),
            contrast=float(params.get("contrast", 1.01)),
            light_balance=float(params.get("light_balance", 0.36)),
            highlights=float(params.get("highlights", 0.53)),
            shadows=float(params.get("shadows", -0.02)),
            warmth=float(params.get("warmth", 0.04)),
        )
        
        # 9.5. Tone Curves (v6.0)
        if params.get("curves_enabled", False) and params.get("curves"):
            image = _apply_curves(image, params.get("curves"))
            
        # 9b. Split Toning
        if params.get("split_toning_enabled", False):
            shadow_color = params.get("split_shadow_color", "#102040")
            highlight_color = params.get("split_highlight_color", "#ffaa20")
            balance = float(params.get("split_balance", 0.0))
            image = Image.fromarray(_apply_split_toning(np.asarray(image, dtype=np.uint8), shadow_color, highlight_color, balance))

        # 9c. Gradient Map
        if params.get("gradient_map_enabled", False):
            preset = params.get("gradient_preset", "Sunset")
            intensity = float(params.get("gradient_intensity", 1.0))
            presets = {
                "Sunset": [(0.07, 0.05, 0.18), (0.87, 0.25, 0.2), (1.0, 0.77, 0.35)],
                "Forest": [(0.05, 0.08, 0.05), (0.35, 0.45, 0.25), (0.9, 0.92, 0.8)],
                "Cyberpunk": [(0.05, 0.0, 0.15), (0.9, 0.0, 0.5), (0.0, 0.95, 1.0)],
                "Vintage": [(0.12, 0.07, 0.05), (0.68, 0.52, 0.35), (0.95, 0.92, 0.85)],
                "B&W": [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)]
            }
            colors = presets.get(preset, presets["Sunset"])
            arr = np.asarray(image, dtype=np.uint8)
            mapped = _apply_gradient_map(arr, colors)
            if intensity < 1.0:
                mapped = (arr.astype(np.float32) * (1.0 - intensity) + mapped.astype(np.float32) * intensity).clip(0, 255).astype(np.uint8)
            image = Image.fromarray(mapped)

        # 9d. Saturation + Vibrance
        if params.get("saturation_enabled", True):
            image = _apply_saturation_vibrance(
                image,
                saturation=float(params.get("saturation", 0.0)),
                vibrance=float(params.get("vibrance", 0.0)),
            )
            
        # 10. Style Transfer (v5.1)
        if params.get("style_transfer_enabled", False) and params.get("style_transfer_stats") is not None:
            st_mode = params.get("style_transfer_mode", "pixel")
            intensity = float(params.get("style_transfer_intensity", 1.0))
            if st_mode == "pixel":
                from engine.nodes import _apply_style_transfer
                image = _apply_style_transfer(
                    image, 
                    params.get("style_transfer_stats"), 
                    intensity
                )
            elif st_mode == "covariance":
                arr = np.asarray(image, dtype=np.uint8)
                mapped = _calculate_color_covariance_transfer(arr, params.get("style_transfer_stats"))
                if intensity < 1.0:
                    mapped = (arr.astype(np.float32) * (1.0 - intensity) + mapped.astype(np.float32) * intensity).clip(0, 255).astype(np.uint8)
                image = Image.fromarray(mapped)
            
        # Sharpness — last
        if params.get("sharpness_enabled", True):
            image = _apply_sharpness(
                image,
                amount=float(params.get("sharpness_amount", 0.0)),
                radius=float(params.get("sharpness_radius", 1.0)),
                threshold=int(params.get("sharpness_threshold", 3)),
            )
            
        # Save
        quality = int(params.get("quality", 95))
        preset = str(params.get("preset", "Canon"))
        artist = str(params.get("artist", "OneArt"))
        focal_length_mm = str(params.get("focal_length_mm", "50"))
        fnumber = str(params.get("fnumber", "4.0"))
        exposure_1_over_s = str(params.get("exposure_1_over_s", "125"))
        iso = int(params.get("iso", 400))
        export_format = params.get("export_format", "JPEG")
        
        exif_bytes = build_exif_bytes(
            preset_name=preset,
            artist=artist,
            software="OneArt Photo Studio v6.0",
            copyright_text="",
            body_serial=str(random.randint(1000000, 99999999)),
            lens_serial=str(random.randint(100000000, 999999999)),
            focal_length_mm=focal_length_mm,
            fnumber=fnumber,
            exposure_1_over_s=exposure_1_over_s,
            iso=iso,
            exposure_bias_ev="0",
            white_balance=0,
            datetime_original="",
        )
        
        base_name = Path(filepath).stem
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        ext_map = {"JPEG": "jpg", "PNG": "png", "TIFF": "tif", "WebP": "webp"}
        ext = ext_map.get(export_format, "jpg")
        filename = f"oneart_{base_name}_{timestamp}.{ext}"
        out_path = str(Path(output_dir) / filename)
        
        if export_format == "JPEG":
            _write_jpeg_with_exif(image, out_path, quality, exif_bytes)
        elif export_format == "PNG":
            image.save(out_path, format="PNG")
        elif export_format == "TIFF":
            if exif_bytes:
                image.save(out_path, format="TIFF", exif=exif_bytes)
            else:
                image.save(out_path, format="TIFF")
        elif export_format == "WebP":
            image.save(out_path, format="WEBP", quality=quality)
            
        return filepath, True, filename
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return filepath, False, str(exc)


# ---------------------------------------------------------------------------
#  API class exposed to the JS frontend via pywebview
# ---------------------------------------------------------------------------

class Api:
    """Methods callable from JavaScript via ``window.pywebview.api.*``."""

    def __init__(self):
        self._source_image: Image.Image | None = None
        self._result_image: Image.Image | None = None
        self._source_path: str = ""

    # -- Load ---------------------------------------------------------------

    def load_image(self, path: str | None = None) -> dict:
        """Open an image file. If *path* is None, show a file dialog."""
        try:
            if not path:
                return {"ok": False, "error": "No file selected"}

            path = path.strip().strip('"')
            if not os.path.isfile(path):
                return {"ok": False, "error": f"File not found: {path}"}

            self._source_image = _load_pil(path)
            self._source_path = path
            self._result_image = None
            w, h = self._source_image.size
            is_raw = Path(path).suffix.lower() in _RAW_EXTENSIONS and RAW_SUPPORT

            # Create a preview (max 1600px on longest side for speed)
            preview = self._source_image.copy()
            max_side = 1600
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                preview = preview.resize(
                    (int(w * ratio), int(h * ratio)), Image.LANCZOS
                )

            return {
                "ok": True,
                "preview": _pil_to_base64(preview),
                "width": w,
                "height": h,
                "filename": os.path.basename(path),
                "is_raw": is_raw,
            }
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    def load_image_data(self, base64_data: str, filename: str) -> dict:
        """Load an image from a base64 data URI (used for HTML5 drag-and-drop)."""
        try:
            if "," in base64_data:
                base64_data = base64_data.split(",", 1)[1]
            img_bytes = base64.b64decode(base64_data)
            self._source_image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            self._source_path = filename  # Use filename as path for output naming
            self._result_image = None
            w, h = self._source_image.size

            # Create preview (max 1600px)
            preview = self._source_image.copy()
            max_side = 1600
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                preview = preview.resize(
                    (int(w * ratio), int(h * ratio)), Image.LANCZOS
                )

            is_raw = Path(filename).suffix.lower() in _RAW_EXTENSIONS and RAW_SUPPORT

            return {
                "ok": True,
                "preview": _pil_to_base64(preview),
                "width": w,
                "height": h,
                "filename": filename,
                "is_raw": is_raw,
            }
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    def analyze_style_reference(self, base64_data: str) -> dict:
        """Decode a base64 image and extract LAB statistics for Style Transfer."""
        try:
            # Decode base64 using PIL
            header, encoded = base64_data.split(",", 1)
            img_bytes = base64.b64decode(encoded)
            img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            img_rgb = np.asarray(img, dtype=np.uint8)
            
            # Convert to LAB using the helper from engine.nodes
            from engine.nodes import _rgb_to_lab
            l, a, b = _rgb_to_lab(img_rgb)
            
            # Compute means and standard deviations
            l_mean, l_std = l.mean(), l.std()
            a_mean, a_std = a.mean(), a.std()
            b_mean, b_std = b.mean(), b.std()
            
            # Compute 3x3 covariance matrix
            pixels = np.stack([l.ravel(), a.ravel(), b.ravel()], axis=0)
            cov_matrix = np.cov(pixels).tolist()
            
            stats = {
                "l_mean": float(l_mean), "l_std": float(l_std),
                "a_mean": float(a_mean), "a_std": float(a_std),
                "b_mean": float(b_mean), "b_std": float(b_std),
                "cov_matrix": cov_matrix,
            }
            return {"ok": True, "stats": stats}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}


    def pick_file(self) -> dict:
        """Show a native file-open dialog and load the selected image."""
        try:
            import webview
            file_dialog_type = getattr(webview, 'FileDialog', None)
            dialog_flag = file_dialog_type.OPEN if file_dialog_type else webview.OPEN_DIALOG
            result = webview.windows[0].create_file_dialog(
                dialog_flag,
                file_types=(
                    "Image files (*.jpg;*.jpeg;*.png;*.bmp;*.tif;*.tiff;*.webp)",
                    "All files (*.*)",
                ),
            )
            if result and len(result) > 0:
                return self.load_image(result[0])
            return {"ok": False, "error": "No file selected"}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    def pick_files(self) -> dict:
        """Show a native file-open dialog allowing multiple selection."""
        try:
            import webview
            file_dialog_type = getattr(webview, 'FileDialog', None)
            dialog_flag = file_dialog_type.OPEN if file_dialog_type else webview.OPEN_DIALOG
            result = webview.windows[0].create_file_dialog(
                dialog_flag,
                allow_multiple=True,
                file_types=(
                    "Image files (*.jpg;*.jpeg;*.png;*.bmp;*.tif;*.tiff;*.webp;*.cr2;*.cr3;*.nef;*.arw;*.dng;*.orf;*.rw2;*.raf)",
                    "All files (*.*)",
                ),
            )
            if result:
                return {"ok": True, "files": result}
            return {"ok": False, "error": "No files selected"}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    # -- Process ------------------------------------------------------------

    def process_image(self, params_json: str) -> dict:
        """Run the full OneArt Photo pipeline on the loaded image."""
        try:
            if self._source_image is None:
                return {"ok": False, "error": "No image loaded"}

            p = json.loads(params_json) if isinstance(params_json, str) else params_json

            # Reload RAW source if applicable to apply new RAW settings
            if self._source_path and RAW_SUPPORT and Path(self._source_path).suffix.lower() in _RAW_EXTENSIONS:
                try:
                    self._source_image = _load_pil(self._source_path, p)
                except Exception as e:
                    print(f"[RAW reload failed] {e}")

            image = self._source_image.copy()

            # 1. Crop (if enabled)
            if p.get("crop_enabled", False):
                cx = float(p.get("crop_x", 0)) / 100.0
                cy = float(p.get("crop_y", 0)) / 100.0
                cw = float(p.get("crop_w", 100)) / 100.0
                ch = float(p.get("crop_h", 100)) / 100.0
                w, h = image.size
                left = int(cx * w)
                top = int(cy * h)
                right = int(min(w, (cx + cw) * w))
                bottom = int(min(h, (cy + ch) * h))
                if right > left and bottom > top:
                    image = image.crop((left, top, right, bottom))

            # 2. Resize
            scale = float(p.get("resize_scale", 100)) / 100.0
            width_override = p.get("resize_width", "")
            height_override = p.get("resize_height", "")
            w, h = image.size
            if width_override or height_override:
                try:
                    target_w = int(width_override) if width_override else int(w * (int(height_override)/h))
                    target_h = int(height_override) if height_override else int(h * (int(width_override)/w))
                    image = image.resize((target_w, target_h), Image.LANCZOS)
                except Exception:
                    pass
            elif scale < 1.0:
                image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

            # 3. LUT Look
            lut_look = p.get("lut_look", "None")
            lut_intensity = float(p.get("lut_intensity", 0.0))
            if lut_look != "None" and lut_intensity > 0:
                from engine.nodes import _apply_color_look
                image = _apply_color_look(image, lut_look, lut_intensity)

            # 3b. Color Temperature / White Balance
            if p.get("whitebalance_enabled", True):
                image = _apply_color_temperature(
                    image,
                    temp_kelvin=float(p.get("color_temp", 6500.0)),
                    tint=float(p.get("color_tint", 0.0)),
                    wb_mode=str(p.get("whitebalance_mode", "manual")),
                )

            # 4. Noise
            arr = np.asarray(image, dtype=np.float32)
            noisy = _add_noise(arr, float(p.get("noise_level", 0.02)),
                               float(p.get("blue_bias", 0.8)))
            image = Image.fromarray(noisy.astype(np.uint8), mode="RGB")

            # 5. Grain
            image = _apply_grain(image,
                                 float(p.get("grain_strength", 0.3)),
                                 int(p.get("grain_size", 2)),
                                 bool(p.get("grain_luminosity_mask", False)))

            # 6. Lens Warp
            arr = np.asarray(image, dtype=np.float32)
            ab_radial = p.get("aberration_radial", False)
            dist = float(p.get("distortion", 0.03))
            ab_strength = float(p.get("chromatic_aberration", 0.1))
            warped = _warp(arr, dist, 0.0 if ab_radial else ab_strength)
            image = Image.fromarray(warped, mode="RGB")
            if ab_radial and ab_strength > 0:
                from engine.nodes import _apply_radial_chromatic_aberration
                image = Image.fromarray(_apply_radial_chromatic_aberration(np.asarray(image, dtype=np.uint8), ab_strength), mode="RGB")

            edge_softness = float(p.get("edge_softness", 0.15))
            if edge_softness > 0:
                from PIL import ImageFilter
                blurred = image.filter(
                    ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 12.0))
                )
                w, h = image.size
                yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
                nx = (xx - w / 2.0) / (w / 2.0)
                ny = (yy - h / 2.0) / (h / 2.0)
                radius = np.sqrt(nx * nx + ny * ny)
                falloff = np.clip(1.0 - (radius ** 2) * (0.55 + edge_softness), 0.0, 1.0)
                mask = Image.fromarray(
                    (falloff * 255.0).astype(np.uint8), mode="L"
                ).filter(ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 20.0)))
                image = Image.composite(image, blurred, mask)

            # 7. Style FX
            mode = str(p.get("mode", "Bloom"))
            # 8. Vignette
            image = _apply_vignette(
                image,
                float(p.get("outer_brightness", 0.05)),
                float(p.get("inner_brightness", 0.2)),
            )

            # 9. Tone Adjust
            image = _apply_tone_adjustment(
                image,
                brightness=float(p.get("brightness", 1.16)),
                contrast=float(p.get("contrast", 1.01)),
                light_balance=float(p.get("light_balance", 0.36)),
                highlights=float(p.get("highlights", 0.53)),
                shadows=float(p.get("shadows", -0.02)),
                warmth=float(p.get("warmth", 0.04)),
            )

            # 9.5. Tone Curves (v6.0)
            if p.get("curves_enabled", False) and p.get("curves"):
                image = _apply_curves(image, p.get("curves"))

            # 9b. Split Toning
            if p.get("split_toning_enabled", False):
                from engine.nodes import _apply_split_toning
                shadow_color = p.get("split_shadow_color", "#102040")
                highlight_color = p.get("split_highlight_color", "#ffaa20")
                balance = float(p.get("split_balance", 0.0))
                image = Image.fromarray(_apply_split_toning(np.asarray(image, dtype=np.uint8), shadow_color, highlight_color, balance))

            # 9c. Gradient Map
            if p.get("gradient_map_enabled", False):
                from engine.nodes import _apply_gradient_map
                preset = p.get("gradient_preset", "Sunset")
                intensity = float(p.get("gradient_intensity", 1.0))
                presets = {
                    "Sunset": [(0.07, 0.05, 0.18), (0.87, 0.25, 0.2), (1.0, 0.77, 0.35)],
                    "Forest": [(0.05, 0.08, 0.05), (0.35, 0.45, 0.25), (0.9, 0.92, 0.8)],
                    "Cyberpunk": [(0.05, 0.0, 0.15), (0.9, 0.0, 0.5), (0.0, 0.95, 1.0)],
                    "Vintage": [(0.12, 0.07, 0.05), (0.68, 0.52, 0.35), (0.95, 0.92, 0.85)],
                    "B&W": [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)]
                }
                colors = presets.get(preset, presets["Sunset"])
                arr = np.asarray(image, dtype=np.uint8)
                mapped = _apply_gradient_map(arr, colors)
                if intensity < 1.0:
                    mapped = (arr.astype(np.float32) * (1.0 - intensity) + mapped.astype(np.float32) * intensity).clip(0, 255).astype(np.uint8)
                image = Image.fromarray(mapped)

            # 9d. Saturation + Vibrance
            if p.get("saturation_enabled", True):
                image = _apply_saturation_vibrance(
                    image,
                    saturation=float(p.get("saturation", 0.0)),
                    vibrance=float(p.get("vibrance", 0.0)),
                )

            # 10. Style Transfer (v5.1)
            if p.get("style_transfer_enabled", False) and p.get("style_transfer_stats") is not None:
                st_mode = p.get("style_transfer_mode", "pixel")
                intensity = float(p.get("style_transfer_intensity", 1.0))
                if st_mode == "pixel":
                    from engine.nodes import _apply_style_transfer
                    image = _apply_style_transfer(
                        image, 
                        p.get("style_transfer_stats"), 
                        intensity
                    )
                elif st_mode == "covariance":
                    from engine.nodes import _calculate_color_covariance_transfer
                    arr = np.asarray(image, dtype=np.uint8)
                    mapped = _calculate_color_covariance_transfer(arr, p.get("style_transfer_stats"))
                    if intensity < 1.0:
                        mapped = (arr.astype(np.float32) * (1.0 - intensity) + mapped.astype(np.float32) * intensity).clip(0, 255).astype(np.uint8)
                    image = Image.fromarray(mapped)

            # Sharpness — always LAST (after all effects, before encoding)
            if p.get("sharpness_enabled", True):
                image = _apply_sharpness(
                    image,
                    amount=float(p.get("sharpness_amount", 0.0)),
                    radius=float(p.get("sharpness_radius", 1.0)),
                    threshold=int(p.get("sharpness_threshold", 3)),
                )
                self._result_image = image

            # Create preview
            w, h = image.size
            preview = image.copy()
            max_side = 1600
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                preview = preview.resize(
                    (int(w * ratio), int(h * ratio)), Image.LANCZOS
                )

            return {
                "ok": True,
                "preview": _pil_to_base64(preview),
                "width": w,
                "height": h,
            }
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    # -- Save ---------------------------------------------------------------

    def save_image(self, params_json: str = "{}") -> dict:
        """Save the processed result with EXIF metadata in target format."""
        try:
            if self._result_image is None:
                return {"ok": False, "error": "No processed image to save"}

            p = json.loads(params_json) if isinstance(params_json, str) else params_json
            quality = int(p.get("quality", 95))
            preset = str(p.get("preset", "Canon"))
            artist = str(p.get("artist", "OneArt"))
            focal_length_mm = str(p.get("focal_length_mm", "50"))
            fnumber = str(p.get("fnumber", "4.0"))
            exposure_1_over_s = str(p.get("exposure_1_over_s", "125"))
            iso = int(p.get("iso", 400))
            export_format = p.get("export_format", "JPEG")  # JPEG, PNG, TIFF, WebP

            import random
            from datetime import datetime

            exif_bytes = build_exif_bytes(
                preset_name=preset,
                artist=artist,
                software="OneArt Photo Studio v6.0",
                copyright_text="",
                body_serial=str(random.randint(1000000, 99999999)),
                lens_serial=str(random.randint(100000000, 999999999)),
                focal_length_mm=focal_length_mm,
                fnumber=fnumber,
                exposure_1_over_s=exposure_1_over_s,
                iso=iso,
                exposure_bias_ev="0",
                white_balance=0,
                datetime_original="",
            )

            # Generate filename
            base_name = Path(self._source_path).stem if self._source_path else "photo"
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            ext_map = {"JPEG": "jpg", "PNG": "png", "TIFF": "tif", "WebP": "webp"}
            ext = ext_map.get(export_format, "jpg")
            filename = f"oneart_{base_name}_{timestamp}.{ext}"
            out_path = str(OUTPUT_DIR / filename)

            if export_format == "JPEG":
                _write_jpeg_with_exif(self._result_image, out_path, quality, exif_bytes)
            elif export_format == "PNG":
                self._result_image.save(out_path, format="PNG")
            elif export_format == "TIFF":
                if exif_bytes:
                    self._result_image.save(out_path, format="TIFF", exif=exif_bytes)
                else:
                    self._result_image.save(out_path, format="TIFF")
            elif export_format == "WebP":
                self._result_image.save(out_path, format="WEBP", quality=quality)

            return {"ok": True, "path": out_path, "filename": filename}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    def process_batch_image(self, filepath: str, params_json: str) -> dict:
        """Process a single image path from batch mode and save directly."""
        try:
            p = json.loads(params_json) if isinstance(params_json, str) else params_json
            
            if not os.path.isfile(filepath):
                return {"ok": False, "error": f"File not found: {filepath}"}

            image = _load_pil(filepath, p)

            # 1. Crop (if enabled)
            if p.get("crop_enabled", False):
                cx = float(p.get("crop_x", 0)) / 100.0
                cy = float(p.get("crop_y", 0)) / 100.0
                cw = float(p.get("crop_w", 100)) / 100.0
                ch = float(p.get("crop_h", 100)) / 100.0
                w, h = image.size
                left = int(cx * w)
                top = int(cy * h)
                right = int(min(w, (cx + cw) * w))
                bottom = int(min(h, (cy + ch) * h))
                if right > left and bottom > top:
                    image = image.crop((left, top, right, bottom))

            # 2. Resize
            scale = float(p.get("resize_scale", 100)) / 100.0
            width_override = p.get("resize_width", "")
            height_override = p.get("resize_height", "")
            w, h = image.size
            if width_override or height_override:
                try:
                    target_w = int(width_override) if width_override else int(w * (int(height_override)/h))
                    target_h = int(height_override) if height_override else int(h * (int(width_override)/w))
                    image = image.resize((target_w, target_h), Image.LANCZOS)
                except Exception:
                    pass
            elif scale < 1.0:
                image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

            # 3. LUT Look
            lut_look = p.get("lut_look", "None")
            lut_intensity = float(p.get("lut_intensity", 0.0))
            if lut_look != "None" and lut_intensity > 0:
                from engine.nodes import _apply_color_look
                image = _apply_color_look(image, lut_look, lut_intensity)

            # 3b. Color Temperature / White Balance
            if p.get("whitebalance_enabled", True):
                image = _apply_color_temperature(
                    image,
                    temp_kelvin=float(p.get("color_temp", 6500.0)),
                    tint=float(p.get("color_tint", 0.0)),
                    wb_mode=str(p.get("whitebalance_mode", "manual")),
                )

            # 4. Noise
            arr = np.asarray(image, dtype=np.float32)
            noisy = _add_noise(arr, float(p.get("noise_level", 0.02)),
                               float(p.get("blue_bias", 0.8)))
            image = Image.fromarray(noisy.astype(np.uint8), mode="RGB")

            # 5. Grain
            image = _apply_grain(image,
                                 float(p.get("grain_strength", 0.3)),
                                 int(p.get("grain_size", 2)),
                                 bool(p.get("grain_luminosity_mask", False)))

            # 6. Lens Warp
            arr = np.asarray(image, dtype=np.float32)
            ab_radial = p.get("aberration_radial", False)
            dist = float(p.get("distortion", 0.03))
            ab_strength = float(p.get("chromatic_aberration", 0.1))
            warped = _warp(arr, dist, 0.0 if ab_radial else ab_strength)
            image = Image.fromarray(warped, mode="RGB")
            if ab_radial and ab_strength > 0:
                from engine.nodes import _apply_radial_chromatic_aberration
                image = Image.fromarray(_apply_radial_chromatic_aberration(np.asarray(image, dtype=np.uint8), ab_strength), mode="RGB")

            edge_softness = float(p.get("edge_softness", 0.15))
            if edge_softness > 0:
                from PIL import ImageFilter
                blurred = image.filter(
                    ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 12.0))
                )
                w, h = image.size
                yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
                nx = (xx - w / 2.0) / (w / 2.0)
                ny = (yy - h / 2.0) / (h / 2.0)
                radius = np.sqrt(nx * nx + ny * ny)
                falloff = np.clip(1.0 - (radius ** 2) * (0.55 + edge_softness), 0.0, 1.0)
                mask = Image.fromarray(
                    (falloff * 255.0).astype(np.uint8), mode="L"
                ).filter(ImageFilter.GaussianBlur(radius=max(0.1, edge_softness * 20.0)))
                image = Image.composite(image, blurred, mask)

            # 7. Style FX
            mode = str(p.get("mode", "Bloom"))
            # 8. Vignette
            image = _apply_vignette(
                image,
                float(p.get("outer_brightness", 0.05)),
                float(p.get("inner_brightness", 0.2)),
            )

            # 9. Tone Adjust
            image = _apply_tone_adjustment(
                image,
                brightness=float(p.get("brightness", 1.16)),
                contrast=float(p.get("contrast", 1.01)),
                light_balance=float(p.get("light_balance", 0.36)),
                highlights=float(p.get("highlights", 0.53)),
                shadows=float(p.get("shadows", -0.02)),
                warmth=float(p.get("warmth", 0.04)),
            )

            # 9.5. Tone Curves (v6.0)
            if p.get("curves_enabled", False) and p.get("curves"):
                image = _apply_curves(image, p.get("curves"))

            # 9b. Split Toning
            if p.get("split_toning_enabled", False):
                from engine.nodes import _apply_split_toning
                shadow_color = p.get("split_shadow_color", "#102040")
                highlight_color = p.get("split_highlight_color", "#ffaa20")
                balance = float(p.get("split_balance", 0.0))
                image = Image.fromarray(_apply_split_toning(np.asarray(image, dtype=np.uint8), shadow_color, highlight_color, balance))

            # 9c. Gradient Map
            if p.get("gradient_map_enabled", False):
                from engine.nodes import _apply_gradient_map
                preset = p.get("gradient_preset", "Sunset")
                intensity = float(p.get("gradient_intensity", 1.0))
                presets = {
                    "Sunset": [(0.07, 0.05, 0.18), (0.87, 0.25, 0.2), (1.0, 0.77, 0.35)],
                    "Forest": [(0.05, 0.08, 0.05), (0.35, 0.45, 0.25), (0.9, 0.92, 0.8)],
                    "Cyberpunk": [(0.05, 0.0, 0.15), (0.9, 0.0, 0.5), (0.0, 0.95, 1.0)],
                    "Vintage": [(0.12, 0.07, 0.05), (0.68, 0.52, 0.35), (0.95, 0.92, 0.85)],
                    "B&W": [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)]
                }
                colors = presets.get(preset, presets["Sunset"])
                arr = np.asarray(image, dtype=np.uint8)
                mapped = _apply_gradient_map(arr, colors)
                if intensity < 1.0:
                    mapped = (arr.astype(np.float32) * (1.0 - intensity) + mapped.astype(np.float32) * intensity).clip(0, 255).astype(np.uint8)
                image = Image.fromarray(mapped)

            # 9d. Saturation + Vibrance
            if p.get("saturation_enabled", True):
                image = _apply_saturation_vibrance(
                    image,
                    saturation=float(p.get("saturation", 0.0)),
                    vibrance=float(p.get("vibrance", 0.0)),
                )

            # 10. Style Transfer (v6.0)
            if p.get("style_transfer_enabled", False) and p.get("style_transfer_stats") is not None:
                st_mode = p.get("style_transfer_mode", "pixel")
                intensity = float(p.get("style_transfer_intensity", 1.0))
                if st_mode == "pixel":
                    from engine.nodes import _apply_style_transfer
                    image = _apply_style_transfer(
                        image, 
                        p.get("style_transfer_stats"), 
                        intensity
                    )
                elif st_mode == "covariance":
                    from engine.nodes import _calculate_color_covariance_transfer
                    arr = np.asarray(image, dtype=np.uint8)
                    mapped = _calculate_color_covariance_transfer(arr, p.get("style_transfer_stats"))
                    if intensity < 1.0:
                        mapped = (arr.astype(np.float32) * (1.0 - intensity) + mapped.astype(np.float32) * intensity).clip(0, 255).astype(np.uint8)
                    image = Image.fromarray(mapped)

            # Save
            quality = int(p.get("quality", 95))
            preset = str(p.get("preset", "Canon"))

            # Sharpness — always LAST in batch too
            if p.get("sharpness_enabled", True):
                image = _apply_sharpness(
                    image,
                    amount=float(p.get("sharpness_amount", 0.0)),
                    radius=float(p.get("sharpness_radius", 1.0)),
                    threshold=int(p.get("sharpness_threshold", 3)),
                )
            artist = str(p.get("artist", "OneArt"))
            focal_length_mm = str(p.get("focal_length_mm", "50"))
            fnumber = str(p.get("fnumber", "4.0"))
            exposure_1_over_s = str(p.get("exposure_1_over_s", "125"))
            iso = int(p.get("iso", 400))
            export_format = p.get("export_format", "JPEG")

            import random
            from datetime import datetime

            exif_bytes = build_exif_bytes(
                preset_name=preset,
                artist=artist,
                software="OneArt Photo Studio v6.0",
                copyright_text="",
                body_serial=str(random.randint(1000000, 99999999)),
                lens_serial=str(random.randint(100000000, 999999999)),
                focal_length_mm=focal_length_mm,
                fnumber=fnumber,
                exposure_1_over_s=exposure_1_over_s,
                iso=iso,
                exposure_bias_ev="0",
                white_balance=0,
                datetime_original="",
            )

            base_name = Path(filepath).stem
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            ext_map = {"JPEG": "jpg", "PNG": "png", "TIFF": "tif", "WebP": "webp"}
            ext = ext_map.get(export_format, "jpg")
            filename = f"oneart_{base_name}_{timestamp}.{ext}"
            out_path = str(OUTPUT_DIR / filename)

            if export_format == "JPEG":
                _write_jpeg_with_exif(image, out_path, quality, exif_bytes)
            elif export_format == "PNG":
                image.save(out_path, format="PNG")
            elif export_format == "TIFF":
                if exif_bytes:
                    image.save(out_path, format="TIFF", exif=exif_bytes)
                else:
                    image.save(out_path, format="TIFF")
            elif export_format == "WebP":
                image.save(out_path, format="WEBP", quality=quality)

            return {"ok": True, "filename": filename}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    def export_3d_lut(self, params_json: str) -> dict:
        """Export current grading parameters as a .cube 3D LUT."""
        try:
            p = json.loads(params_json) if isinstance(params_json, str) else params_json
            
            import webview
            file_dialog_type = getattr(webview, 'FileDialog', None)
            dialog_flag = file_dialog_type.SAVE if file_dialog_type else webview.SAVE_DIALOG
            
            result = webview.windows[0].create_file_dialog(
                dialog_flag,
                save_filename="oneart_look.cube",
                file_types=("3D LUT files (*.cube)", "All files (*.*)"),
            )
            
            if result and len(result) > 0:
                out_path = result[0] if isinstance(result, list) else result
                from engine.nodes import export_3d_lut
                export_3d_lut(p, out_path)
                return {"ok": True, "filename": os.path.basename(out_path)}
            return {"ok": False, "error": "No file selected"}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}
    def process_batch_queue_parallel(self, queue_json: str, params_json: str) -> dict:
        """Process multiple files in parallel using ProcessPoolExecutor workers."""
        try:
            items = json.loads(queue_json)
            p = json.loads(params_json)
            
            import threading
            def run_workers():
                import webview
                from concurrent.futures import ProcessPoolExecutor, as_completed
                import os
                
                try:
                    num_workers = max(1, os.cpu_count() - 1)
                except Exception:
                    num_workers = 2
                
                filepaths = [item["path"] for item in items if item.get("path")]
                
                if not filepaths:
                    return
                
                output_dir_str = str(OUTPUT_DIR)
                
                with ProcessPoolExecutor(max_workers=num_workers) as executor:
                    futures = {
                        executor.submit(_process_single_worker, fp, p, output_dir_str): fp 
                        for fp in filepaths
                    }
                    
                    for fut in as_completed(futures):
                        fp = futures[fut]
                        try:
                            filepath, success, result_str = fut.result()
                            success_js = "true" if success else "false"
                            result_escaped = result_str.replace("\\", "\\\\").replace("'", "\\'")
                            fp_escaped = filepath.replace("\\", "\\\\").replace("'", "\\'")
                            js = f"window.onBatchItemProgress('{fp_escaped}', {success_js}, '{result_escaped}')"
                            webview.windows[0].evaluate_js(js)
                        except Exception as fut_exc:
                            fp_escaped = fp.replace("\\", "\\\\").replace("'", "\\'")
                            err_msg = str(fut_exc).replace("\\", "\\\\").replace("'", "\\'")
                            js = f"window.onBatchItemProgress('{fp_escaped}', false, '{err_msg}')"
                            webview.windows[0].evaluate_js(js)
                            
            threading.Thread(target=run_workers, daemon=True).start()
            return {"ok": True}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}
    def open_output_folder(self) -> dict:
        """Open the Downloads folder in the system file explorer."""
        try:
            import subprocess
            subprocess.Popen(f'explorer "{OUTPUT_DIR}"')
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
#  FastAPI WebSocket & HTTP Server setup
# ---------------------------------------------------------------------------

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
import asyncio

fastapi_app = FastAPI()
active_websockets = set()
global_api_instance = None
fastapi_loop = None

@fastapi_app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global fastapi_loop
    fastapi_loop = asyncio.get_running_loop()
    await websocket.accept()
    active_websockets.add(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            req = json.loads(data)
            req_id = req.get("id")
            method_name = req.get("method")
            args = req.get("args", [])
            
            api_instance = global_api_instance
            if api_instance and hasattr(api_instance, method_name):
                method = getattr(api_instance, method_name)
                try:
                    loop = asyncio.get_running_loop()
                    result = await loop.run_in_executor(None, method, *args)
                    await websocket.send_json({"id": req_id, "result": result})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    await websocket.send_json({"id": req_id, "error": str(e)})
            else:
                await websocket.send_json({"id": req_id, "error": f"Method {method_name} not found"})
    except Exception:
        pass
    finally:
        active_websockets.discard(websocket)

fastapi_app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


def broadcast_ws_message(msg_str: str):
    """Broadcasting utility for batch queue status progress to frontends."""
    if fastapi_loop is not None:
        for ws in list(active_websockets):
            try:
                asyncio.run_coroutine_threadsafe(ws.send_text(msg_str), fastapi_loop)
            except Exception:
                pass


def start_fastapi_server(port: int):
    import uvicorn
    uvicorn.run(fastapi_app, host="127.0.0.1", port=port, log_level="warning")


# ---------------------------------------------------------------------------
#  Main — launch the desktop window
# ---------------------------------------------------------------------------

def main():
    import webview
    import threading
    import socket
    import time

    # Find a free port dynamically to prevent conflicts
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()

    api = Api()
    global global_api_instance
    global_api_instance = api

    # Start FastAPI locally in a background daemon thread
    t = threading.Thread(target=start_fastapi_server, args=(port,), daemon=True)
    t.start()
    
    # Wait half a second for server startup
    time.sleep(0.5)

    window = webview.create_window(
        title="OneArt Photo Studio",
        url=f"http://127.0.0.1:{port}/index.html",
        js_api=api,
        width=1440,
        height=900,
        min_size=(1024, 680),
        background_color="#0a0a0f",
        text_select=False,
    )

    storage_dir = APP_DIR / "storage"
    storage_dir.mkdir(exist_ok=True)

    icon_path = APP_DIR / "icon.ico"
    icon_str = str(icon_path) if icon_path.exists() else None

    webview.start(
        debug=False,
        private_mode=False,
        storage_path=str(storage_dir),
        icon=icon_str
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import sys
        import traceback
        
        tb_str = traceback.format_exc()
        log_path = APP_DIR / "launcher_error.txt"
        
        try:
            with open(log_path, "w", encoding="utf-8") as f:
                f.write(tb_str)
        except Exception:
            pass
            
        error_msg = (
            f"An error occurred while launching OneArt Photo Studio:\n\n"
            f"{e}\n\n"
            f"Detailed traceback has been written to:\n"
            f"{log_path}\n\n"
            f"If this is a WebView2 error, try deleting the 'storage' folder in the application directory."
        )
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, error_msg, "OneArt Photo Studio - Startup Error", 0x10)
        except Exception:
            print(error_msg, file=sys.stderr)

