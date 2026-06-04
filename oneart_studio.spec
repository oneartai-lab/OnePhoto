# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller build spec for OneArt Photo Studio
Run: pyinstaller oneart_studio.spec
Output: dist/OneArtPhotoStudio/OneArtPhotoStudio.exe
"""

import sys
from pathlib import Path

APP_DIR = Path('.').resolve()

block_cipher = None

a = Analysis(
    ['start_app.py'],
    pathex=[str(APP_DIR)],
    binaries=[],
    datas=[
        # Bundle the entire frontend (HTML, CSS, JS)
        ('frontend', 'frontend'),
        # Bundle engine (LUTs etc.)
        ('engine/luts', 'engine/luts'),
        # pywebview bundled assets
    ],
    hiddenimports=[
        'pywebview',
        'webview',
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
        'PIL',
        'PIL.Image',
        'PIL.ImageEnhance',
        'PIL.ImageFilter',
        'numpy',
        'piexif',
        'tifffile',
        'clr',        # pythonnet (needed by pywebview on Windows)
        'System',
        'System.Windows.Forms',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'scipy',
        'pandas',
        'IPython',
        'jupyter',
        'notebook',
        'test',
        'unittest',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='OneArtPhotoStudio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,           # No console window — GUI only
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon='docs/icon.ico',  # Uncomment if you have an icon file
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='OneArtPhotoStudio',
)
