<div align="center">

# 📷 OneArt Photo Studio

**Premium local photo processor with cinematic film effects**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Android-lightgrey.svg)](#)
[![Capacitor](https://img.shields.io/badge/Capacitor-6.0-119EFF.svg)](https://capacitorjs.com/)

A standalone photo-processing application that runs **100% locally** — no internet connection, no cloud, no subscriptions.  
Process your photos with professional film-style effects and export with realistic EXIF metadata.

</div>

---

## ✨ Features

### 🎞️ Film Effects Pipeline
- **Noise** — realistic sensor noise with adjustable blue channel bias
- **Grain** — organic analog film grain with size control
- **Lens Warp** — barrel/pincushion distortion + chromatic aberration + edge softness
- **Style FX** — 5 creative modes:
  - `Bloom` — soft glowing highlights
  - `Halation` — cinematic film halation effect
  - `CinematicGrade` — Hollywood-style color grading
  - `SoftPortrait` — skin-smoothing portrait mode
  - `GlitchArt` — digital glitch / lo-fi aesthetic
- **Vignette** — radial brightness control (inner + outer zones)
- **Tone Adjust** — brightness, contrast, highlights, shadows, warmth, light balance

### 📷 Realistic EXIF Metadata
Export photos with authentic camera metadata presets:
| Preset | Camera |
|--------|--------|
| Canon | Canon EOS R5 + RF 24-70mm F2.8 L IS USM |
| Sony | Sony A7 IV + FE 24-70mm F2.8 GM |
| Nikon | Nikon Z9 + NIKKOR Z 24-70mm f/2.8 S |
| Fujifilm | Fujifilm X-T5 + XF 23mm F1.4 R LM WR |
| Leica | Leica M11 + SUMMICRON-M 35mm f/2 ASPH |
| iPhone | iPhone 15 Pro (triple camera system) |

### 📐 Format Support
- **Input:** JPG, PNG, TIFF, WebP, HEIC/HEIF, RAW (DNG, CR2, NEF, ARW, etc.)
- **Output:** JPEG with embedded EXIF

### 🌍 Localization
- Full **English** and **Russian** UI
- Language switch saved to `localStorage`

---

## 🚀 Getting Started

### Prerequisites
- Python 3.10+
- Windows (desktop mode) or Android 7.0+ (mobile mode)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/oneartai-lab/OnePhoto.git
cd OnePhoto

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Launch the desktop app
python start_app.py
```

> **Windows users:** You can also double-click `OneArt Photo Studio.bat`

### Android

The app is packaged as an Android WebView app via [Capacitor](https://capacitorjs.com/).

```bash
# Install Node dependencies
npm install

# Sync web assets to Android
npx cap sync android

# Open in Android Studio
npx cap open android
```

Then build and run via **Android Studio** → `▶ Run`.

---

## 🏗️ Architecture

```
OnePhoto/
├── start_app.py          # Desktop app entry point (pywebview)
├── requirements.txt      # Python dependencies
│
├── engine/               # Core image processing library
│   ├── nodes.py          # All image processing nodes (ComfyUI-compatible)
│   ├── lens_distortion_safe.py  # Lens warp / chromatic aberration
│   ├── presets.py        # Camera EXIF metadata presets
│   └── luts/             # Drop .cube or image LUT files here
│
├── frontend/             # Web UI (HTML + CSS + JS)
│   ├── index.html        # Main application layout
│   ├── style.css         # UI design system
│   └── app.js            # Frontend logic & pywebview bridge
│
├── android/              # Capacitor Android project
└── output/               # Processed photos saved here
```

### How It Works

```
User picks photo
      │
      ▼
Python backend (pywebview API)
      │
      ├─► Noise addition      (NumPy)
      ├─► Film grain          (Pillow + NumPy)
      ├─► Lens distortion     (NumPy warp)
      ├─► Style FX            (Pillow + NumPy)
      ├─► Vignette            (NumPy radial mask)
      └─► Tone adjustment     (Pillow ImageEnhance + NumPy)
              │
              ▼
      JPEG output with EXIF metadata (piexif)
```

> **On Android / browser:** processing runs fully client-side in JavaScript (no Python backend required).

---

## ⚙️ ComfyUI Nodes

The `engine/` package is also usable as a **ComfyUI custom node pack**.  
All nodes live in `engine/nodes.py` under the `oneart/photo` category:

| Node | Description |
|------|-------------|
| `OneArtPhotoLoad` | Load image or RAW file with EXIF passthrough |
| `OneArtPhotoNoise` | Add realistic sensor noise |
| `OneArtPhotoGrain` | Apply analog film grain |
| `OneArtPhotoStyleFX` | Apply cinematic style effects |
| `OneArtPhotoVignette` | Radial brightness vignette |
| `OneArtPhotoToneAdjust` | Full tone grading (brightness/contrast/warmth/etc.) |
| `OneArtPhotoLUT` | Apply .cube or image LUT |
| `OneArtPhotoMetadata` | Attach realistic camera EXIF |
| `OneArtPhotoSaveJpeg` | Save with EXIF passthrough |
| `OneArtPhotoSaveJpegDirect` | Save with inline EXIF metadata |

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `pywebview >= 5.0` | Desktop WebView window |
| `Pillow` | Image loading, processing, saving |
| `numpy` | Fast array-based image math |
| `piexif` | EXIF metadata read/write |
| `pillow-heif` | HEIC/HEIF format support |
| `rawpy` | RAW camera file support |
| `tifffile` | TIFF format support |

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

Made with ❤️ by [OneArt AI Lab](https://github.com/oneartai-lab)

</div>
