"""
OneArt Photo Studio — Standalone Desktop Application
=====================================================
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
OUTPUT_DIR = APP_DIR / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

# Define folder_paths shim since ComfyUI nodes expect it
_folder_paths_shim = type(sys)("folder_paths")
_folder_paths_shim.base_path = str(APP_DIR)
_folder_paths_shim.get_output_directory = lambda: str(OUTPUT_DIR)
sys.modules["folder_paths"] = _folder_paths_shim

# Define torch shim to avoid massive PyTorch installation
_torch_shim = type(sys)("torch")
_torch_shim.Tensor = type("Tensor", (), {})
_torch_shim.device = type("device", (), {})
sys.modules["torch"] = _torch_shim

# Now import the processing helpers directly from the local engine package
from engine.nodes import (
    _add_noise,
    _apply_grain,
    _apply_style_fx,
    _apply_tone_adjustment,
    _apply_vignette,
    build_exif_bytes,
    _write_jpeg_with_exif,
    _encode_exif,
    _decode_exif,
)
from engine.lens_distortion_safe import _warp


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def _pil_to_base64(image: Image.Image, fmt: str = "JPEG", quality: int = 92) -> str:
    """Convert a PIL Image to a data-URI base64 string."""
    buf = io.BytesIO()
    image.save(buf, format=fmt, quality=quality)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _load_pil(path: str) -> Image.Image:
    """Load an image from disk, handling common formats."""
    return Image.open(path).convert("RGB")


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

            return {
                "ok": True,
                "preview": _pil_to_base64(preview),
                "width": w,
                "height": h,
                "filename": filename,
            }
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

    # -- Process ------------------------------------------------------------

    def process_image(self, params_json: str) -> dict:
        """Run the full OneArt Photo pipeline on the loaded image."""
        try:
            if self._source_image is None:
                return {"ok": False, "error": "No image loaded"}

            p = json.loads(params_json) if isinstance(params_json, str) else params_json

            image = self._source_image.copy()

            # 1. Noise
            arr = np.asarray(image, dtype=np.float32)
            noisy = _add_noise(arr, float(p.get("noise_level", 0.02)),
                               float(p.get("blue_bias", 0.8)))
            image = Image.fromarray(noisy.astype(np.uint8), mode="RGB")

            # 2. Grain
            image = _apply_grain(image,
                                 float(p.get("grain_strength", 0.3)),
                                 int(p.get("grain_size", 2)))

            # 3. Lens Warp
            arr = np.asarray(image, dtype=np.float32)
            warped = _warp(arr,
                           float(p.get("distortion", 0.03)),
                           float(p.get("chromatic_aberration", 0.1)))
            image = Image.fromarray(warped, mode="RGB")

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

            # 4. Style FX
            image = _apply_style_fx(
                image,
                str(p.get("mode", "Bloom")),
                float(p.get("strength", 0.33)),
                float(p.get("radius", 20.7)),
                float(p.get("threshold", 0.8)),
                int(p.get("seed", 0)),
            )

            # 5. Vignette
            image = _apply_vignette(
                image,
                float(p.get("outer_brightness", 0.05)),
                float(p.get("inner_brightness", 0.2)),
            )

            # 6. Tone Adjust
            image = _apply_tone_adjustment(
                image,
                brightness=float(p.get("brightness", 1.16)),
                contrast=float(p.get("contrast", 1.01)),
                light_balance=float(p.get("light_balance", 0.36)),
                highlights=float(p.get("highlights", 0.53)),
                shadows=float(p.get("shadows", -0.02)),
                warmth=float(p.get("warmth", 0.04)),
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
        """Save the processed result as a JPEG with EXIF metadata."""
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

            import random
            from datetime import datetime

            exif_bytes = build_exif_bytes(
                preset_name=preset,
                artist=artist,
                software="OneArt Photo Studio",
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
            filename = f"oneart_{base_name}_{timestamp}.jpg"
            out_path = str(OUTPUT_DIR / filename)

            _write_jpeg_with_exif(self._result_image, out_path, quality, exif_bytes)

            return {"ok": True, "path": out_path, "filename": filename}
        except Exception as exc:
            traceback.print_exc()
            return {"ok": False, "error": str(exc)}

    def open_output_folder(self) -> dict:
        """Open the output folder in the system file explorer."""
        try:
            import subprocess
            subprocess.Popen(f'explorer "{OUTPUT_DIR}"')
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
#  Main — launch the desktop window
# ---------------------------------------------------------------------------

def main():
    import webview

    api = Api()

    window = webview.create_window(
        title="OneArt Photo Studio",
        url=str(FRONTEND_DIR / "index.html"),
        js_api=api,
        width=1440,
        height=900,
        min_size=(1024, 680),
        background_color="#0a0a0f",
        text_select=False,
    )

    webview.start(debug=False)


if __name__ == "__main__":
    main()
