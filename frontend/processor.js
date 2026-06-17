/**
 * OneArt Photo Studio — Client-Side JavaScript Image Processing Engine
 * ===================================================================
 * A pure JS port of the Python nodes.py and lens_distortion_safe.py logic.
 * Optimised using Canvas 2D context operations and pre-calculated lookup tables.
 */

const OneArtProcessor = (function () {
  'use strict';

  // Helper: Seeded Random Generator (LCG) for reproducible GlitchArt
  function createLCG(seed) {
    let s = seed === 0 ? Math.random() * 2147483647 : seed;
    return function () {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  // Helper: Gaussian Box-Muller generator
  function boxMuller() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // Pre-calculate a table of Gaussian noise values to avoid millions of math calls
  const NOISE_TABLE_SIZE = 4096;
  const GAUSSIAN_NOISE_TABLE = new Float32Array(NOISE_TABLE_SIZE);
  for (let i = 0; i < NOISE_TABLE_SIZE; i++) {
    GAUSSIAN_NOISE_TABLE[i] = boxMuller();
  }

  // Bilinear interpolation sampling for Lens Warp
  function sampleBilinear(data, w, h, x, y, c) {
    let x0 = Math.floor(x);
    let y0 = Math.floor(y);

    if (x0 < 0) x0 = 0; else if (x0 >= w - 1) x0 = w - 2;
    if (y0 < 0) y0 = 0; else if (y0 >= h - 1) y0 = h - 2;

    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const dx = x - x0;
    const dy = y - y0;

    const row0 = y0 * w * 4;
    const row1 = y1 * w * 4;

    const idx00 = row0 + x0 * 4 + c;
    const idx01 = row0 + x1 * 4 + c;
    const idx10 = row1 + x0 * 4 + c;
    const idx11 = row1 + x1 * 4 + c;

    return (1 - dx) * (1 - dy) * data[idx00] +
           dx * (1 - dy) * data[idx01] +
           (1 - dx) * dy * data[idx10] +
           dx * dy * data[idx11];
  }

  /**
   * Run the full OneArt Photo processing pipeline on a source HTMLImageElement or HTMLCanvasElement.
   * Returns a Promise resolving to a new HTMLCanvasElement containing the result.
   */
  function processImage(sourceElement, params) {
    return new Promise((resolve, reject) => {
      try {
        const width = sourceElement.naturalWidth || sourceElement.width;
        const height = sourceElement.naturalHeight || sourceElement.height;

        if (!width || !height) {
          reject(new Error("Invalid image dimensions"));
          return;
        }

        // --- A. Crop Overlay (if enabled) ---
        let sourceX = 0;
        let sourceY = 0;
        let sourceW = width;
        let sourceH = height;

        if (params.crop_enabled) {
          const cx = parseFloat(params.crop_x) / 100.0 || 0;
          const cy = parseFloat(params.crop_y) / 100.0 || 0;
          const cw = parseFloat(params.crop_w) / 100.0 || 1;
          const ch = parseFloat(params.crop_h) / 100.0 || 1;
          sourceX = Math.round(cx * width);
          sourceY = Math.round(cy * height);
          sourceW = Math.round(cw * width);
          sourceH = Math.round(ch * height);
        }

        // --- B. Resize ---
        const resizeScale = parseFloat(params.resize_scale) / 100.0 || 1.0;
        const widthOverride = params.resize_width ? parseInt(params.resize_width) : null;
        const heightOverride = params.resize_height ? parseInt(params.resize_height) : null;

        let targetW = sourceW;
        let targetH = sourceH;

        if (widthOverride || heightOverride) {
          targetW = widthOverride || Math.round(sourceW * (heightOverride / sourceH));
          targetH = heightOverride || Math.round(sourceH * (widthOverride / sourceW));
        } else if (resizeScale < 1.0) {
          targetW = Math.round(sourceW * resizeScale);
          targetH = Math.round(sourceH * resizeScale);
        }

        // Initialize main working canvas with cropped/resized dimensions
        const workCanvas = document.createElement('canvas');
        workCanvas.width = targetW;
        workCanvas.height = targetH;
        const ctx = workCanvas.getContext('2d');
        ctx.drawImage(sourceElement, sourceX, sourceY, sourceW, sourceH, 0, 0, targetW, targetH);

        // -------------------------------------------------------------
        // 1. Noise, Tone Adjust, and Vignette (Single Pass Pixel Loop)
        // -------------------------------------------------------------
        const imgData = ctx.getImageData(0, 0, targetW, targetH);
        const data = imgData.data;

        // Tone params
        const brightness = parseFloat(params.brightness) ?? 1.16;
        const contrast = parseFloat(params.contrast) ?? 1.01;
        const lightBalance = parseFloat(params.light_balance) ?? 0.36;
        const highlights = parseFloat(params.highlights) ?? 0.53;
        const shadows = parseFloat(params.shadows) ?? -0.02;
        const warmth = parseFloat(params.warmth) ?? 0.04;

        const redGain = 1.0 + warmth * 0.16;
        const greenGain = 1.0 + warmth * 0.03;
        const blueGain = 1.0 - warmth * 0.16;

        // Noise params
        const noiseLevel = parseFloat(params.noise_level) ?? 0.02;
        const blueBias = parseFloat(params.blue_bias) ?? 0.8;

        // Vignette params
        const outerBrightness = parseFloat(params.outer_brightness) ?? 0.05;
        const innerBrightness = parseFloat(params.inner_brightness) ?? 0.20;

        const halfW = targetW / 2;
        const halfH = targetH / 2;
        const maxDist = Math.max(halfW, 1.0);
        const maxDistY = Math.max(halfH, 1.0);

        let noiseIndex = 0;

        for (let y = 0; y < targetH; y++) {
          const ny = (y - halfH) / maxDistY;
          for (let x = 0; x < targetW; x++) {
            const nx = (x - halfW) / maxDist;
            const idx = (y * targetW + x) * 4;

            // Load colors normalised to [0, 1]
            let r = data[idx] / 255.0;
            let g = data[idx + 1] / 255.0;
            let b = data[idx + 2] / 255.0;

            // --- 0. Color Look (LUT) ---
            const look = params.lut_look || "None";
            const lookIntensity = parseFloat(params.lut_intensity) || 0.0;
            if (look !== "None" && lookIntensity > 0) {
              if (look === "Teal & Orange") {
                const luma = r * 0.299 + g * 0.587 + b * 0.114;
                const sMask = Math.max(0.0, Math.min(1.0, (0.5 - luma) * 2.0));
                r -= lookIntensity * 0.08 * sMask;
                g += lookIntensity * 0.05 * sMask;
                b += lookIntensity * 0.15 * sMask;
                const hMask = Math.max(0.0, Math.min(1.0, (luma - 0.5) * 2.0));
                r += lookIntensity * 0.15 * hMask;
                g += lookIntensity * 0.06 * hMask;
                b -= lookIntensity * 0.10 * hMask;
              } else if (look === "Kodak Portra") {
                r *= (1.0 + lookIntensity * 0.05);
                b *= (1.0 - lookIntensity * 0.05);
                const luma = r * 0.299 + g * 0.587 + b * 0.114;
                r = r * (1.0 - lookIntensity * 0.15) + luma * (lookIntensity * 0.15);
                g = g * (1.0 - lookIntensity * 0.15) + luma * (lookIntensity * 0.15);
                b = b * (1.0 - lookIntensity * 0.15) + luma * (lookIntensity * 0.15);
                r = (r - 0.5) * (1.0 - lookIntensity * 0.08) + 0.5;
                g = (g - 0.5) * (1.0 - lookIntensity * 0.08) + 0.5;
                b = (b - 0.5) * (1.0 - lookIntensity * 0.08) + 0.5;
              } else if (look === "Fuji Superia") {
                const luma = r * 0.299 + g * 0.587 + b * 0.114;
                const sMask = Math.max(0.0, Math.min(1.0, (0.45 - luma) * 2.2));
                r += lookIntensity * 0.04 * sMask;
                b += lookIntensity * 0.08 * sMask;
                g *= (1.0 + lookIntensity * 0.08);
                r *= (1.0 + lookIntensity * 0.06);
              } else if (look === "Monochrome Noir") {
                let luma = r * 0.60 + g * 0.35 + b * 0.05;
                luma = Math.max(0.0, Math.min(1.0, (luma - 0.45) * (1.0 + lookIntensity * 0.5) + 0.45));
                r = r * (1.0 - lookIntensity) + luma * lookIntensity;
                g = g * (1.0 - lookIntensity) + luma * lookIntensity;
                b = b * (1.0 - lookIntensity) + luma * lookIntensity;
              } else if (look === "Vintage Gold") {
                const luma = r * 0.299 + g * 0.587 + b * 0.114;
                const factor = 1.0 - lookIntensity * 0.08;
                r = r * factor + lookIntensity * 0.08;
                g = g * factor + lookIntensity * 0.08;
                b = b * factor + lookIntensity * 0.08;
                r *= (1.0 + lookIntensity * 0.12);
                g *= (1.0 + lookIntensity * 0.08);
                b *= (1.0 - lookIntensity * 0.12);
                r = r * (1.0 - lookIntensity * 0.20) + luma * (lookIntensity * 0.20);
                g = g * (1.0 - lookIntensity * 0.20) + luma * (lookIntensity * 0.20);
                b = b * (1.0 - lookIntensity * 0.20) + luma * (lookIntensity * 0.20);
              } else if (look === "Cyberpunk") {
                const luma = r * 0.299 + g * 0.587 + b * 0.114;
                const sMask = Math.max(0.0, Math.min(1.0, (0.5 - luma) * 2.0));
                r += lookIntensity * 0.16 * sMask;
                b += lookIntensity * 0.16 * sMask;
                g -= lookIntensity * 0.08 * sMask;
                const hMask = Math.max(0.0, Math.min(1.0, (luma - 0.5) * 2.0));
                r -= lookIntensity * 0.12 * hMask;
                g += lookIntensity * 0.16 * hMask;
                b += lookIntensity * 0.16 * hMask;
              }
              r = Math.max(0.0, Math.min(1.0, r));
              g = Math.max(0.0, Math.min(1.0, g));
              b = Math.max(0.0, Math.min(1.0, b));
            }

            // --- A. Tone Adjust ---
            // Brightness
            if (brightness !== 1.0) {
              r *= brightness;
              g *= brightness;
              b *= brightness;
            }
            // Contrast
            if (contrast !== 1.0) {
              r = (r - 0.5) * contrast + 0.5;
              g = (g - 0.5) * contrast + 0.5;
              b = (b - 0.5) * contrast + 0.5;
            }

            // Luminance
            const luma = r * 0.299 + g * 0.587 + b * 0.114;

            // Light Balance
            if (lightBalance !== 0.0) {
              const midMask = 1.0 - Math.abs(luma - 0.5) * 2.0;
              const shift = lightBalance * 0.10 * midMask;
              r += shift; g += shift; b += shift;
            }
            // Highlights
            if (highlights !== 0.0) {
              const hMask = Math.max(0.0, Math.min(1.0, (luma - 0.5) * 2.0));
              const shift = highlights * 0.18 * hMask;
              r += shift * (1.0 - r);
              g += shift * (1.0 - g);
              b += shift * (1.0 - b);
            }
            // Shadows
            if (shadows !== 0.0) {
              const sMask = Math.max(0.0, Math.min(1.0, (0.5 - luma) * 2.0));
              const shift = shadows * 0.18 * sMask;
              r += shift * (1.0 - r);
              g += shift * (1.0 - g);
              b += shift * (1.0 - b);
            }
            // Warmth
            if (warmth !== 0.0) {
              r *= redGain;
              g *= greenGain;
              b *= blueGain;
            }

            // --- B. Noise ---
            if (noiseLevel > 0) {
              // Get noise from pre-calculated Box-Muller table
              const nR = GAUSSIAN_NOISE_TABLE[noiseIndex % NOISE_TABLE_SIZE] * noiseLevel;
              const nG = GAUSSIAN_NOISE_TABLE[(noiseIndex + 7) % NOISE_TABLE_SIZE] * noiseLevel;
              const nB = GAUSSIAN_NOISE_TABLE[(noiseIndex + 19) % NOISE_TABLE_SIZE] * noiseLevel * blueBias;
              noiseIndex += 3;

              r += nR;
              g += nG;
              b += nB;
            }

            // --- C. Vignette ---
            let radius = Math.sqrt(nx * nx + ny * ny);
            if (radius > 1.0) radius = 1.0;
            let innerMask = 1.0 - radius;
            innerMask = innerMask * innerMask * (3.0 - 2.0 * innerMask); // smoothstep
            const outerMask = 1.0 - innerMask;

            const outerGain = 1.0 + outerBrightness;
            const innerGain = 1.0 + innerBrightness;
            const vignetteGain = outerMask * outerGain + innerMask * innerGain;

            r *= vignetteGain;
            g *= vignetteGain;
            b *= vignetteGain;

            // --- Tone Curves (v6.0) ---
            if (params.curves_enabled && params.curves) {
              const cR = params.curves.red;
              const cG = params.curves.green;
              const cB = params.curves.blue;
              const cRGB = params.curves.rgb;
              
              if (cR && cG && cB && cRGB) {
                let rIdx = Math.max(0, Math.min(255, Math.round(r * 255.0)));
                let gIdx = Math.max(0, Math.min(255, Math.round(g * 255.0)));
                let bIdx = Math.max(0, Math.min(255, Math.round(b * 255.0)));
                
                r = cR[rIdx] / 255.0;
                g = cG[gIdx] / 255.0;
                b = cB[bIdx] / 255.0;
                
                rIdx = Math.max(0, Math.min(255, Math.round(r * 255.0)));
                gIdx = Math.max(0, Math.min(255, Math.round(g * 255.0)));
                bIdx = Math.max(0, Math.min(255, Math.round(b * 255.0)));
                
                r = cRGB[rIdx] / 255.0;
                g = cRGB[gIdx] / 255.0;
                b = cRGB[bIdx] / 255.0;
              }
            }

            // Save back clamped
            data[idx] = Math.max(0, Math.min(255, Math.round(r * 255.0)));
            data[idx + 1] = Math.max(0, Math.min(255, Math.round(g * 255.0)));
            data[idx + 2] = Math.max(0, Math.min(255, Math.round(b * 255.0)));
          }
        }
        ctx.putImageData(imgData, 0, 0);

        // -------------------------------------------------------------
        // 2. Lens Warp (Radial Distortion & Chromatic Aberration)
        // -------------------------------------------------------------
        const distortion = parseFloat(params.distortion) ?? 0.03;
        const aberration = parseFloat(params.chromatic_aberration) ?? 0.10;

        if (distortion !== 0.0 || aberration !== 0.0) {
          const srcData = ctx.getImageData(0, 0, width, height);
          const srcPixels = srcData.data;
          const dstData = ctx.createImageData(width, height);
          const dstPixels = dstData.data;

          const channelShift = aberration * 0.008;

          for (let y = 0; y < height; y++) {
            const ny = (y - halfH) / halfH;
            for (let x = 0; x < width; x++) {
              const nx = (x - halfW) / halfW;
              const r2 = nx * nx + ny * ny;

              let factor = 1.0 + distortion * r2;
              if (Math.abs(factor) < 1e-4) factor = 1e-4;

              const baseX = nx / factor;
              const baseY = ny / factor;

              const srcX = baseX * halfW + halfW;
              const srcY = baseY * halfH + halfH;

              const dstIdx = (y * width + x) * 4;

              // R channel (c=0): shift = -channelShift
              const shiftR = -channelShift * r2 * width;
              dstPixels[dstIdx] = Math.max(0, Math.min(255, Math.round(sampleBilinear(srcPixels, width, height, srcX + shiftR, srcY, 0))));

              // G channel (c=1): shift = 0
              dstPixels[dstIdx + 1] = Math.max(0, Math.min(255, Math.round(sampleBilinear(srcPixels, width, height, srcX, srcY, 1))));

              // B channel (c=2): shift = +channelShift
              const shiftB = channelShift * r2 * width;
              dstPixels[dstIdx + 2] = Math.max(0, Math.min(255, Math.round(sampleBilinear(srcPixels, width, height, srcX + shiftB, srcY, 2))));

              // Alpha channel
              dstPixels[dstIdx + 3] = srcPixels[dstIdx + 3];
            }
          }
          ctx.putImageData(dstData, 0, 0);
        }

        // -------------------------------------------------------------
        // 3. Edge Softness (Radial Gradient Mask + Gaussian Blur)
        // -------------------------------------------------------------
        const edgeSoftness = parseFloat(params.edge_softness) ?? 0.15;
        if (edgeSoftness > 0) {
          // 1. Create a blurred copy of the current state
          const blurredCanvas = document.createElement('canvas');
          blurredCanvas.width = width;
          blurredCanvas.height = height;
          const bctx = blurredCanvas.getContext('2d');
          bctx.filter = `blur(${Math.max(0.1, edgeSoftness * 12.0)}px)`;
          bctx.drawImage(workCanvas, 0, 0);

          // 2. Create the radial gradient mask
          const maskCanvas = document.createElement('canvas');
          maskCanvas.width = width;
          maskCanvas.height = height;
          const mctx = maskCanvas.getContext('2d');
          const maxR = Math.sqrt(halfW * halfW + halfH * halfH);
          const radiusLimit = maxR / Math.sqrt(0.55 + edgeSoftness);

          const grad = mctx.createRadialGradient(halfW, halfH, 0, halfW, halfH, radiusLimit);
          grad.addColorStop(0, 'rgba(255,255,255,1)');
          grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          mctx.fillStyle = grad;
          mctx.fillRect(0, 0, width, height);

          // Blur the mask to match Python's extra mask blurring
          const blurredMaskCanvas = document.createElement('canvas');
          blurredMaskCanvas.width = width;
          blurredMaskCanvas.height = height;
          const bmctx = blurredMaskCanvas.getContext('2d');
          bmctx.filter = `blur(${Math.max(0.1, edgeSoftness * 20.0)}px)`;
          bmctx.drawImage(maskCanvas, 0, 0);

          // 3. Composite: draw sharp original, then mask it with the radial mask
          const sharpMaskedCanvas = document.createElement('canvas');
          sharpMaskedCanvas.width = width;
          sharpMaskedCanvas.height = height;
          const smctx = sharpMaskedCanvas.getContext('2d');
          smctx.drawImage(workCanvas, 0, 0);
          smctx.globalCompositeOperation = 'destination-in';
          smctx.drawImage(blurredMaskCanvas, 0, 0);

          // 4. Draw blurred canvas as base, and top with sharp masked canvas
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(blurredCanvas, 0, 0);
          ctx.drawImage(sharpMaskedCanvas, 0, 0);
        }

        // -------------------------------------------------------------
        // 3b. Portrait Bokeh Fallback (2D Canvas Blur + Compositing)
        // -------------------------------------------------------------
        if (params.portrait_bokeh_enabled === true || params.portrait_bokeh_enabled === 'true') {
          const pbRadius = parseFloat(params.portrait_bokeh_radius) ?? 20.0;
          if (pbRadius > 0) {
            // 1. Create a blurred copy of the current state
            const blurredCanvas = document.createElement('canvas');
            blurredCanvas.width = width;
            blurredCanvas.height = height;
            const bctx = blurredCanvas.getContext('2d');
            // Canvas fallback uses standard CSS filter blur
            bctx.filter = `blur(${Math.max(0.1, pbRadius * 0.75)}px)`;
            bctx.drawImage(workCanvas, 0, 0);

            // 2. Create the focus mask canvas
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = width;
            maskCanvas.height = height;
            const mctx = maskCanvas.getContext('2d');
            const pbMaskMode = params.portrait_bokeh_mask_mode || 'auto';

            if (pbMaskMode === 'none') {
              mctx.fillStyle = '#000000';
              mctx.fillRect(0, 0, width, height);
            } else if (pbMaskMode === 'auto') {
              mctx.fillStyle = '#000000';
              mctx.fillRect(0, 0, width, height);
              if (params.ai_mask_base64) {
                const aiMaskImg = await new Promise((resolve) => {
                  const img = new Image();
                  img.onload = () => resolve(img);
                  img.onerror = () => resolve(null);
                  img.src = params.ai_mask_base64;
                });
                if (aiMaskImg) {
                  mctx.drawImage(aiMaskImg, 0, 0, width, height);
                }
              }
            } else if (pbMaskMode === 'radial') {
              const cx = (parseFloat(params.portrait_bokeh_mask_center_x) ?? 50.0) / 100.0 * width;
              const cy = (parseFloat(params.portrait_bokeh_mask_center_y) ?? 50.0) / 100.0 * height;
              const maxDim = Math.max(width, height);
              const rPx = (parseFloat(params.portrait_bokeh_mask_radius) ?? 30.0) / 100.0 * maxDim * 0.5;
              const transition = parseFloat(params.portrait_bokeh_mask_hardness) ?? 0.5;

              const innerR = Math.max(0, rPx * (1.0 - transition));
              const outerR = rPx * (1.0 + transition);

              const grad = mctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
              grad.addColorStop(0, '#ffffff');
              grad.addColorStop(1, '#000000');
              mctx.fillStyle = grad;
              mctx.fillRect(0, 0, width, height);
            } else if (pbMaskMode === 'linear') {
              const cx = (parseFloat(params.portrait_bokeh_mask_center_x) ?? 50.0) / 100.0 * width;
              const cy = (parseFloat(params.portrait_bokeh_mask_center_y) ?? 50.0) / 100.0 * height;
              const maxDim = Math.max(width, height);
              const wPx = (parseFloat(params.portrait_bokeh_mask_radius) ?? 30.0) / 100.0 * maxDim * 0.5;
              const transition = parseFloat(params.portrait_bokeh_mask_hardness) ?? 0.5;
              const angleDeg = parseFloat(params.portrait_bokeh_mask_angle) ?? 0.0;

              const innerW = Math.max(0, wPx * (1.0 - transition));
              const outerW = wPx * (1.0 + transition);

              mctx.save();
              mctx.translate(cx, cy);
              mctx.rotate(angleDeg * Math.PI / 180.0);

              mctx.fillStyle = '#ffffff';
              mctx.fillRect(-width * 2, -innerW, width * 4, innerW * 2);

              const topGrad = mctx.createLinearGradient(0, -innerW, 0, -outerW);
              topGrad.addColorStop(0, '#ffffff');
              topGrad.addColorStop(1, '#000000');
              mctx.fillStyle = topGrad;
              mctx.fillRect(-width * 2, -outerW, width * 4, outerW - innerW);

              const bottomGrad = mctx.createLinearGradient(0, innerW, 0, outerW);
              bottomGrad.addColorStop(0, '#ffffff');
              bottomGrad.addColorStop(1, '#000000');
              mctx.fillStyle = bottomGrad;
              mctx.fillRect(-width * 2, innerW, width * 4, outerW - innerW);

              mctx.fillStyle = '#000000';
              mctx.fillRect(-width * 2, -height * 2, width * 4, height * 2 - outerW);
              mctx.fillRect(-width * 2, outerW, width * 4, height * 2 - outerW);

              mctx.restore();
            }

            const sharpMaskedCanvas = document.createElement('canvas');
            sharpMaskedCanvas.width = width;
            sharpMaskedCanvas.height = height;
            const smctx = sharpMaskedCanvas.getContext('2d');
            smctx.drawImage(workCanvas, 0, 0);
            smctx.globalCompositeOperation = 'destination-in';
            smctx.drawImage(maskCanvas, 0, 0);

            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(blurredCanvas, 0, 0);
            ctx.drawImage(sharpMaskedCanvas, 0, 0);
          }
        }

        // -------------------------------------------------------------
        // 4. Style FX (Bloom, Halation, SoftPortrait, CinematicGrade, GlitchArt)
        // -------------------------------------------------------------
        const mode = params.mode ?? "Bloom";
        const strength = parseFloat(params.strength) ?? 0.33;
        const radius = parseFloat(params.radius) ?? 20.7;
        const threshold = parseFloat(params.threshold) ?? 0.80;
        const seed = parseInt(params.seed) ?? 0;

        if (strength > 0) {
          if (mode === "Bloom" || mode === "Halation") {
            // A. Extract highlights
            const highlightCanvas = document.createElement('canvas');
            highlightCanvas.width = width;
            highlightCanvas.height = height;
            const hlCtx = highlightCanvas.getContext('2d');
            const hlData = hlCtx.createImageData(width, height);
            const currentImgData = ctx.getImageData(0, 0, width, height);
            const currentPixels = currentImgData.data;

            const isBloom = (mode === "Bloom");
            const powFactor = isBloom ? 1.2 : 1.6;

            for (let i = 0; i < currentPixels.length; i += 4) {
              const r = currentPixels[i] / 255.0;
              const g = currentPixels[i + 1] / 255.0;
              const b = currentPixels[i + 2] / 255.0;
              const luma = r * 0.299 + g * 0.587 + b * 0.114;

              let w = Math.max(0.0, Math.min(1.0, (luma - threshold) / Math.max(1e-4, 1.0 - threshold)));
              w = Math.pow(w, powFactor);

              // Save luma mask in alpha, colors in RGB
              hlData.data[i] = Math.round(r * w * 255);
              hlData.data[i + 1] = Math.round(g * w * 255);
              hlData.data[i + 2] = Math.round(b * w * 255);
              hlData.data[i + 3] = Math.round(w * 255);
            }
            hlCtx.putImageData(hlData, 0, 0);

            // B. Blur highlights (Bloom mask)
            const blurRad = isBloom ? radius * (0.8 + strength) : radius * (0.7 + strength);
            const bloomMaskCanvas = document.createElement('canvas');
            bloomMaskCanvas.width = width;
            bloomMaskCanvas.height = height;
            const bmCtx = bloomMaskCanvas.getContext('2d');
            bmCtx.filter = `blur(${Math.max(0.1, blurRad)}px)`;
            bmCtx.drawImage(highlightCanvas, 0, 0);

            // C. Blur base image for soft glow (glow)
            const glowCanvas = document.createElement('canvas');
            glowCanvas.width = width;
            glowCanvas.height = height;
            const glCtx = glowCanvas.getContext('2d');
            glCtx.filter = `blur(${Math.max(0.1, radius)}px)`;
            glCtx.drawImage(workCanvas, 0, 0);

            // D. Get pixel arrays for blending
            const baseData = ctx.getImageData(0, 0, width, height);
            const basePixels = baseData.data;
            const glowPixels = glCtx.getImageData(0, 0, width, height).data;
            const maskPixels = bmCtx.getImageData(0, 0, width, height).data;

            for (let i = 0; i < basePixels.length; i += 4) {
              const r = basePixels[i] / 255.0;
              const g = basePixels[i + 1] / 255.0;
              const b = basePixels[i + 2] / 255.0;

              const gr = glowPixels[i] / 255.0;
              const gg = glowPixels[i + 1] / 255.0;
              const gb = glowPixels[i + 2] / 255.0;

              // The bloom mask value is based on R channel or Alpha channel
              const maskVal = maskPixels[i + 3] / 255.0; 

              if (isBloom) {
                // out = arr * (1.0 - 0.20 * strength) + glow * bloom_mask * (0.35 + 0.65 * strength) + bloom_mask * (0.05 + 0.08 * strength)
                let or = r * (1.0 - 0.20 * strength) + gr * maskVal * (0.35 + 0.65 * strength) + maskVal * (0.05 + 0.08 * strength);
                let og = g * (1.0 - 0.20 * strength) + gg * maskVal * (0.35 + 0.65 * strength) + maskVal * (0.05 + 0.08 * strength);
                let ob = b * (1.0 - 0.20 * strength) + gb * maskVal * (0.35 + 0.65 * strength) + maskVal * (0.05 + 0.08 * strength);

                basePixels[i] = Math.max(0, Math.min(255, Math.round(or * 255)));
                basePixels[i + 1] = Math.max(0, Math.min(255, Math.round(og * 255)));
                basePixels[i + 2] = Math.max(0, Math.min(255, Math.round(ob * 255)));
              } else {
                // Halation:
                // out = arr + glow * halo_mask * (0.18 + 0.55 * strength)
                // out[..., 0] += halo_mask * (0.08 + 0.18 * strength)
                // out[..., 1] += halo_mask * (0.03 + 0.05 * strength)
                const glowMult = 0.18 + 0.55 * strength;
                let or = r + gr * maskVal * glowMult + maskVal * (0.08 + 0.18 * strength);
                let og = g + gg * maskVal * glowMult + maskVal * (0.03 + 0.05 * strength);
                let ob = b + gb * maskVal * glowMult;

                basePixels[i] = Math.max(0, Math.min(255, Math.round(or * 255)));
                basePixels[i + 1] = Math.max(0, Math.min(255, Math.round(og * 255)));
                basePixels[i + 2] = Math.max(0, Math.min(255, Math.round(ob * 255)));
              }
            }
            ctx.putImageData(baseData, 0, 0);

          } else if (mode === "SoftPortrait") {
            // A. Create blurred base
            const softBlurCanvas = document.createElement('canvas');
            softBlurCanvas.width = width;
            softBlurCanvas.height = height;
            const sbCtx = softBlurCanvas.getContext('2d');
            sbCtx.filter = `blur(${Math.max(0.1, radius * (0.55 + strength * 0.9))}px)`;
            sbCtx.drawImage(workCanvas, 0, 0);

            const baseData = ctx.getImageData(0, 0, width, height);
            const basePixels = baseData.data;
            const blurPixels = sbCtx.getImageData(0, 0, width, height).data;

            const liftAmount = 0.03 + strength * 0.04;
            const wR = 1.0 + strength * 0.03;
            const wG = 1.0 + strength * 0.01;
            const wB = 1.0 - strength * 0.02;

            for (let i = 0; i < basePixels.length; i += 4) {
              const r = basePixels[i] / 255.0;
              const g = basePixels[i + 1] / 255.0;
              const b = basePixels[i + 2] / 255.0;

              const br = blurPixels[i] / 255.0;
              const bg = blurPixels[i + 1] / 255.0;
              const bb = blurPixels[i + 2] / 255.0;

              const luma = r * 0.299 + g * 0.587 + b * 0.114;
              const sat = Math.max(r, g, b) - Math.min(r, g, b);

              let smoothMask = Math.max(0, Math.min(1.0, 1.0 - sat * 2.2)) * Math.max(0, Math.min(1.0, 1.0 - Math.abs(luma - 0.5) * 1.6));
              smoothMask = Math.max(0, Math.min(1.0, smoothMask * (0.35 + strength * 0.9)));

              // Lifted shadows shadow_mask = clip(0.5 - luma)
              const shadowMask = Math.max(0.0, Math.min(1.0, 0.5 - luma));
              let lr = r + liftAmount * shadowMask;
              let lg = g + liftAmount * shadowMask;
              let lb = b + liftAmount * shadowMask;

              // Apply warmth to lifted layer
              lr *= wR;
              lg *= wG;
              lb *= wB;

              // Blend: out = arr * (1.0 - smooth_mask) + blur * smooth_mask
              let or = r * (1.0 - smoothMask) + br * smoothMask;
              let og = g * (1.0 - smoothMask) + bg * smoothMask;
              let ob = b * (1.0 - smoothMask) + bb * smoothMask;

              // Final composite: out = out * 0.88 + lifted * 0.12
              or = or * 0.88 + lr * 0.12;
              og = og * 0.88 + lg * 0.12;
              ob = ob * 0.88 + lb * 0.12;

              basePixels[i] = Math.max(0, Math.min(255, Math.round(or * 255)));
              basePixels[i + 1] = Math.max(0, Math.min(255, Math.round(og * 255)));
              basePixels[i + 2] = Math.max(0, Math.min(255, Math.round(ob * 255)));
            }
            ctx.putImageData(baseData, 0, 0);

          } else if (mode === "CinematicGrade") {
            const baseData = ctx.getImageData(0, 0, width, height);
            const basePixels = baseData.data;

            const contrastFactor = 1.0 + 0.22 * strength;
            const dimFactor = 1.0 - 0.10 * strength;

            for (let i = 0; i < basePixels.length; i += 4) {
              let r = basePixels[i] / 255.0;
              let g = basePixels[i + 1] / 255.0;
              let b = basePixels[i + 2] / 255.0;

              // Apply contrast
              r = Math.max(0.0, Math.min(1.0, (r - 0.5) * contrastFactor + 0.5));
              g = Math.max(0.0, Math.min(1.0, (g - 0.5) * contrastFactor + 0.5));
              b = Math.max(0.0, Math.min(1.0, (b - 0.5) * contrastFactor + 0.5));

              const luma = r * 0.299 + g * 0.587 + b * 0.114;
              const shadow = Math.max(0.0, Math.min(1.0, (0.5 - luma) * 2.0));
              const highlight = Math.max(0.0, Math.min(1.0, (luma - 0.5) * 2.0));

              // Highlight shifts
              r *= 1.0 + 0.10 * strength * highlight;
              g *= 1.0 + 0.02 * strength * highlight;
              b *= 1.0 - 0.08 * strength * highlight;

              // Shadow shifts
              r *= 1.0 - 0.07 * strength * shadow;
              g *= 1.0 + 0.05 * strength * shadow;
              b *= 1.0 + 0.11 * strength * shadow;

              // Dim overall
              r = Math.max(0.0, Math.min(1.0, r * dimFactor));
              g = Math.max(0.0, Math.min(1.0, g * dimFactor));
              b = Math.max(0.0, Math.min(1.0, b * dimFactor));

              basePixels[i] = Math.round(r * 255);
              basePixels[i + 1] = Math.round(g * 255);
              basePixels[i + 2] = Math.round(b * 255);
            }
            ctx.putImageData(baseData, 0, 0);

          } else if (mode === "RetroFilm") {
            const baseData = ctx.getImageData(0, 0, width, height);
            const basePixels = baseData.data;
            const leakDir = (seed % 2);
            for (let y = 0; y < height; y++) {
              const ny = (y - halfH) / halfH;
              for (let x = 0; x < width; x++) {
                const nx = (x - halfW) / halfW;
                const idx = (y * width + x) * 4;
                let r = basePixels[idx] / 255.0;
                let g = basePixels[idx + 1] / 255.0;
                let b = basePixels[idx + 2] / 255.0;
                const luma = r * 0.299 + g * 0.587 + b * 0.114;
                
                // Warm highlights
                const hMask = Math.max(0.0, Math.min(1.0, (luma - 0.4) * 1.66));
                r += strength * 0.15 * hMask;
                g += strength * 0.07 * hMask;
                b -= strength * 0.08 * hMask;

                // Cool shadows
                const sMask = Math.max(0.0, Math.min(1.0, (0.6 - luma) * 1.66));
                r -= strength * 0.05 * sMask;
                b += strength * 0.12 * sMask;

                // Fade shadows
                r = r * 0.95 + 0.03 * strength;
                g = g * 0.95 + 0.03 * strength;
                b = b * 0.95 + 0.03 * strength;

                // Light leak
                let gradient = leakDir === 0 ? 1.0 - (x / width) : (x / width);
                gradient = Math.pow(Math.max(0, Math.min(1, gradient)), 3.5);
                r += strength * 0.35 * gradient;
                g += strength * 0.12 * gradient;

                basePixels[idx]     = Math.max(0, Math.min(255, Math.round(r * 255)));
                basePixels[idx + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
                basePixels[idx + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
              }
            }
            ctx.putImageData(baseData, 0, 0);

          } else if (mode === "Duotone") {
            const baseData = ctx.getImageData(0, 0, width, height);
            const basePixels = baseData.data;
            for (let i = 0; i < basePixels.length; i += 4) {
              const r = basePixels[i] / 255.0;
              const g = basePixels[i + 1] / 255.0;
              const b = basePixels[i + 2] / 255.0;
              const luma = r * 0.299 + g * 0.587 + b * 0.114;
              
              const duoR = 0.05 * (1.0 - luma) + 0.95 * luma;
              const duoG = 0.05 * (1.0 - luma) + 0.75 * luma;
              const duoB = 0.25 * (1.0 - luma) + 0.25 * luma;

              basePixels[i]     = Math.max(0, Math.min(255, Math.round((r * (1.0 - strength) + duoR * strength) * 255)));
              basePixels[i + 1] = Math.max(0, Math.min(255, Math.round((g * (1.0 - strength) + duoG * strength) * 255)));
              basePixels[i + 2] = Math.max(0, Math.min(255, Math.round((b * (1.0 - strength) + duoB * strength) * 255)));
            }
            ctx.putImageData(baseData, 0, 0);

          } else if (mode === "Matte") {
            const baseData = ctx.getImageData(0, 0, width, height);
            const basePixels = baseData.data;
            const lift = 0.12 * strength;
            const dim = 1.0 - 0.08 * strength;
            const contrastFactor = 1.0 - 0.15 * strength;
            for (let i = 0; i < basePixels.length; i += 4) {
              let r = basePixels[i] / 255.0;
              let g = basePixels[i + 1] / 255.0;
              let b = basePixels[i + 2] / 255.0;

              r = lift + (1.0 - lift) * r;
              g = lift + (1.0 - lift) * g;
              b = lift + (1.0 - lift) * b;

              r *= dim; g *= dim; b *= dim;

              r = (r - 0.5) * contrastFactor + 0.5;
              g = (g - 0.5) * contrastFactor + 0.5;
              b = (b - 0.5) * contrastFactor + 0.5;

              basePixels[i]     = Math.max(0, Math.min(255, Math.round(r * 255)));
              basePixels[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
              basePixels[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
            }
            ctx.putImageData(baseData, 0, 0);

          } else if (mode === "GlitchArt") {
            const rng = createLCG(seed);
            const imgData = ctx.getImageData(0, 0, width, height);
            const pixels = imgData.data;

            const maxShift = Math.max(1, Math.round((width * 0.03) * (0.35 + strength)));
            const stripeStep = Math.max(2, Math.round(18 - strength * 12));

            // A. Row shifts
            for (let y = 0; y < height; y += stripeStep) {
              const bandH = Math.max(1, Math.round(rng() * (4 + strength * 12)));
              const yEnd = Math.min(height, y + bandH);
              const shift = Math.round(rng() * (maxShift * 2)) - maxShift;

              if (shift !== 0) {
                // Roll row pixels horizontally
                for (let rowY = y; rowY < yEnd; rowY++) {
                  const rowOffset = rowY * width * 4;
                  const tempRow = new Uint8Array(width * 4);
                  // Copy row
                  for (let i = 0; i < width * 4; i++) {
                    tempRow[i] = pixels[rowOffset + i];
                  }
                  // Roll
                  for (let x = 0; x < width; x++) {
                    const srcX = (x - shift + width) % width;
                    pixels[rowOffset + x * 4]     = tempRow[srcX * 4];
                    pixels[rowOffset + x * 4 + 1] = tempRow[srcX * 4 + 1];
                    pixels[rowOffset + x * 4 + 2] = tempRow[srcX * 4 + 2];
                  }
                }
              }
            }

            // B. Block Shifts (if strength > 0.2)
            if (strength > 0.2) {
              const blockCount = Math.floor(2 + strength * 6);
              for (let b = 0; b < blockCount; b++) {
                const x0 = Math.floor(rng() * width);
                const y0 = Math.floor(rng() * height);
                const bw = Math.max(4, Math.floor(rng() * (width / 8 - width / 24)) + Math.floor(width / 24));
                const bh = Math.max(4, Math.floor(rng() * (height / 10 - height / 30)) + Math.floor(height / 30));
                const x1 = Math.min(width, x0 + bw);
                const y1 = Math.min(height, y0 + bh);
                const shift = Math.round(rng() * (maxShift * 2)) - maxShift;

                if (shift !== 0) {
                  for (let rowY = y0; rowY < y1; rowY++) {
                    const rowOffset = rowY * width * 4;
                    const tempBlock = new Uint8Array(bw * 4);
                    // Copy block segment
                    for (let x = x0; x < x1; x++) {
                      const idx = (x - x0) * 4;
                      tempBlock[idx] = pixels[rowOffset + x * 4];
                      tempBlock[idx + 1] = pixels[rowOffset + x * 4 + 1];
                      tempBlock[idx + 2] = pixels[rowOffset + x * 4 + 2];
                    }
                    // Roll segment
                    for (let x = x0; x < x1; x++) {
                      const relX = (x - x0 - shift + bw) % bw;
                      pixels[rowOffset + x * 4]     = tempBlock[relX * 4];
                      pixels[rowOffset + x * 4 + 1] = tempBlock[relX * 4 + 1];
                      pixels[rowOffset + x * 4 + 2] = tempBlock[relX * 4 + 2];
                    }
                  }
                }
              }
            }

            // C. Chromatic Roll, Scanlines, and Noise
            const shiftAmount = Math.round(maxShift * 0.6);
            const tempPixels = new Uint8Array(pixels);

            for (let y = 0; y < height; y++) {
              const scanline = Math.sin(y * 1.25) > 0 ? 1 : 0;
              const scanlineFactor = 1.0 - strength * 0.08 * scanline;

              for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                // 1. Roll R channel horizontally by shiftAmount
                const rxSrc = (x - shiftAmount + width) % width;
                const rIdx = (y * width + rxSrc) * 4;
                let r = tempPixels[rIdx];

                // 2. G channel stays
                let g = tempPixels[idx + 1];

                // 3. Roll B channel vertically by -shiftAmount
                const rySrc = (y + shiftAmount + height) % height;
                const bIdx = (rySrc * width + x) * 4;
                let b = tempPixels[bIdx + 2];

                // Apply scanline darkening
                r *= scanlineFactor;
                g *= scanlineFactor;
                b *= scanlineFactor;

                // Add Glitch high frequency noise
                const gNoise = (rng() * 2 - 1) * 255.0 * 0.06 * strength;
                r = Math.max(0, Math.min(255, Math.round(r + gNoise)));
                g = Math.max(0, Math.min(255, Math.round(g + gNoise)));
                b = Math.max(0, Math.min(255, Math.round(b + gNoise)));

                pixels[idx]     = r;
                pixels[idx + 1] = g;
                pixels[idx + 2] = b;
              }
            }
            ctx.putImageData(imgData, 0, 0);
          }
        }

        // -------------------------------------------------------------
        // 5. Grain (Nearest-Neighbor Scaled Noise Overlay)
        // -------------------------------------------------------------
        const grainStrength = parseFloat(params.grain_strength) ?? 0.30;
        const grainSize = parseInt(params.grain_size) ?? 2;

        if (grainStrength > 0) {
          // A. Generate low-resolution grain pattern
          const grainW = Math.max(1, Math.floor(width / grainSize));
          const grainH = Math.max(1, Math.floor(height / grainSize));

          const tempGrainCanvas = document.createElement('canvas');
          tempGrainCanvas.width = grainW;
          tempGrainCanvas.height = grainH;
          const tgCtx = tempGrainCanvas.getContext('2d');
          const tgData = tgCtx.createImageData(grainW, grainH);

          // Fast Box-Muller table index
          let gIndex = Math.floor(Math.random() * NOISE_TABLE_SIZE);

          for (let i = 0; i < tgData.data.length; i += 4) {
            const noiseVal = 128.0 + GAUSSIAN_NOISE_TABLE[gIndex % NOISE_TABLE_SIZE] * 50.0 * grainStrength;
            gIndex++;

            const val = Math.max(0, Math.min(255, Math.round(noiseVal)));
            tgData.data[i]     = val;
            tgData.data[i + 1] = val;
            tgData.data[i + 2] = val;
            tgData.data[i + 3] = 255;
          }
          tgCtx.putImageData(tgData, 0, 0);

          // B. Scale up the grain canvas using Nearest Neighbor
          const scaledGrainCanvas = document.createElement('canvas');
          scaledGrainCanvas.width = width;
          scaledGrainCanvas.height = height;
          const sgCtx = scaledGrainCanvas.getContext('2d');
          sgCtx.imageSmoothingEnabled = false; // Nearest neighbor
          sgCtx.drawImage(tempGrainCanvas, 0, 0, width, height);

          // C. Blend grain pattern into base image in a pixel loop
          const baseData = ctx.getImageData(0, 0, width, height);
          const basePixels = baseData.data;
          const grainPixels = sgCtx.getImageData(0, 0, width, height).data;

          for (let i = 0; i < basePixels.length; i += 4) {
            let r = basePixels[i] / 255.0;
            let g = basePixels[i + 1] / 255.0;
            let b = basePixels[i + 2] / 255.0;

            const grainLuma = grainPixels[i] / 255.0; // grayscale image

            // mixed = base * (0.85 + 0.3 * (layer - 0.5) * strength)
            const factor = 0.85 + 0.3 * (grainLuma - 0.5) * grainStrength;
            r = Math.max(0.0, Math.min(1.0, r * factor));
            g = Math.max(0.0, Math.min(1.0, g * factor));
            b = Math.max(0.0, Math.min(1.0, b * factor));

            basePixels[i]     = Math.round(r * 255);
            basePixels[i + 1] = Math.round(g * 255);
            basePixels[i + 2] = Math.round(b * 255);
          }
          ctx.putImageData(baseData, 0, 0);
        }

        // -------------------------------------------------------------
        // -------------------------------------------------------------
        // 9B. Style Transfer (v5.1)
        // -------------------------------------------------------------
        const styleTransferEnabled = (params.style_transfer_enabled === true || params.style_transfer_enabled === 'true') && (params.style_transfer_mode === 'pixel');
        const styleTransferIntensity = parseFloat(params.style_transfer_intensity) ?? 1.0;
        const refStats = params.style_transfer_stats;

        if (styleTransferEnabled && refStats && styleTransferIntensity > 0) {
          const imgData = ctx.getImageData(0, 0, width, height);
          const pixels = imgData.data;

          // Helper: RGB [0,1] to standard LAB
          function rgb2lab(r, g, b) {
            r = (r > 0.04045) ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
            g = (g > 0.04045) ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
            b = (b > 0.04045) ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
            let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
            let y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000;
            let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
            x = (x > 0.008856) ? Math.cbrt(x) : (7.787 * x) + (16 / 116);
            y = (y > 0.008856) ? Math.cbrt(y) : (7.787 * y) + (16 / 116);
            z = (z > 0.008856) ? Math.cbrt(z) : (7.787 * z) + (16 / 116);
            return [(116 * y) - 16, 500 * (x - y), 200 * (y - z)];
          }

          // Helper: standard LAB to RGB [0,1]
          function lab2rgb(l, a, b) {
            let y = (l + 16) / 116;
            let x = a / 500 + y;
            let z = y - b / 200;
            let x3 = x*x*x, y3 = y*y*y, z3 = z*z*z;
            x = ((x3 > 0.008856) ? x3 : (x - 16 / 116) / 7.787) * 0.95047;
            y = ((y3 > 0.008856) ? y3 : (y - 16 / 116) / 7.787) * 1.00000;
            z = ((z3 > 0.008856) ? z3 : (z - 16 / 116) / 7.787) * 1.08883;
            let rr = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
            let gg = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
            let bb = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;
            rr = (rr > 0.0031308) ? (1.055 * Math.pow(rr, 1 / 2.4) - 0.055) : 12.92 * rr;
            gg = (gg > 0.0031308) ? (1.055 * Math.pow(gg, 1 / 2.4) - 0.055) : 12.92 * gg;
            bb = (bb > 0.0031308) ? (1.055 * Math.pow(bb, 1 / 2.4) - 0.055) : 12.92 * bb;
            return [Math.max(0, Math.min(1, rr)), Math.max(0, Math.min(1, gg)), Math.max(0, Math.min(1, bb))];
          }

          // Compute current image stats (downsampled for speed)
          const step = 4;
          let sumL = 0, sumA = 0, sumB = 0;
          let count = 0;
          let labPixels = new Float32Array(width * height * 3);
          
          for (let i = 0; i < pixels.length; i += 4) {
            const lab = rgb2lab(pixels[i]/255, pixels[i+1]/255, pixels[i+2]/255);
            const idx = (i / 4) * 3;
            labPixels[idx] = lab[0]; labPixels[idx+1] = lab[1]; labPixels[idx+2] = lab[2];
            
            if ((i/4) % step === 0) {
              sumL += lab[0]; sumA += lab[1]; sumB += lab[2];
              count++;
            }
          }
          const meanL = sumL / count, meanA = sumA / count, meanB = sumB / count;
          let varL = 0, varA = 0, varB = 0;
          for (let i = 0; i < pixels.length; i += 4 * step) {
            const idx = (i / 4) * 3;
            varL += (labPixels[idx] - meanL) ** 2;
            varA += (labPixels[idx+1] - meanA) ** 2;
            varB += (labPixels[idx+2] - meanB) ** 2;
          }
          const stdL = Math.max(Math.sqrt(varL / count), 1e-4);
          const stdA = Math.max(Math.sqrt(varA / count), 1e-4);
          const stdB = Math.max(Math.sqrt(varB / count), 1e-4);

          // Convert reference stats from OpenCV uint8 range to Standard LAB
          const refMeanL = refStats.l_mean * (100 / 255);
          const refStdL = refStats.l_std * (100 / 255);
          const refMeanA = refStats.a_mean - 128;
          const refStdA = refStats.a_std;
          const refMeanB = refStats.b_mean - 128;
          const refStdB = refStats.b_std;

          // Apply transfer
          for (let i = 0; i < pixels.length; i += 4) {
            const idx = (i / 4) * 3;
            const l = (labPixels[idx] - meanL) * (refStdL / stdL) + refMeanL;
            const a = (labPixels[idx+1] - meanA) * (refStdA / stdA) + refMeanA;
            const b = (labPixels[idx+2] - meanB) * (refStdB / stdB) + refMeanB;

            const rgb = lab2rgb(l, a, b);
            
            pixels[i]   = Math.round((pixels[i]/255 * (1 - styleTransferIntensity) + rgb[0] * styleTransferIntensity) * 255);
            pixels[i+1] = Math.round((pixels[i+1]/255 * (1 - styleTransferIntensity) + rgb[1] * styleTransferIntensity) * 255);
            pixels[i+2] = Math.round((pixels[i+2]/255 * (1 - styleTransferIntensity) + rgb[2] * styleTransferIntensity) * 255);
          }
          ctx.putImageData(imgData, 0, 0);
        }

        // -------------------------------------------------------------
        // 10A. Infrared Film (Aerochrome)
        // -------------------------------------------------------------
        const infraredEnabled = params.infrared_enabled === true || params.infrared_enabled === 'true';
        const infraredIntensity = parseFloat(params.infrared_intensity) ?? 0.8;
        if (infraredEnabled && infraredIntensity > 0) {
          const imgData = ctx.getImageData(0, 0, width, height);
          const pixels = imgData.data;
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i] / 255.0;
            const g = pixels[i + 1] / 255.0;
            const b = pixels[i + 2] / 255.0;

            const rOut = Math.max(0.0, Math.min(1.0, r * 0.15 + g * 1.5 - b * 0.25));
            const gOut = Math.max(0.0, Math.min(1.0, r * 0.85 + g * 0.0 + b * 0.15));
            const bOut = Math.max(0.0, Math.min(1.0, r * -0.25 + g * 0.15 + b * 1.1));

            pixels[i]     = Math.round((r * (1.0 - infraredIntensity) + rOut * infraredIntensity) * 255);
            pixels[i + 1] = Math.round((g * (1.0 - infraredIntensity) + gOut * infraredIntensity) * 255);
            pixels[i + 2] = Math.round((b * (1.0 - infraredIntensity) + bOut * infraredIntensity) * 255);
          }
          ctx.putImageData(imgData, 0, 0);
        }



        // -------------------------------------------------------------
        // 10C. Glass Prism Refractions
        // -------------------------------------------------------------
        const prismEnabled = params.prism_enabled === true || params.prism_enabled === 'true';
        const prismMode = params.prism_mode ?? 'Kaleidoscope';
        const prismIntensity = parseFloat(params.prism_intensity) ?? 0.5;

        if (prismEnabled && prismIntensity > 0) {
          const imgData = ctx.getImageData(0, 0, width, height);
          const pixels = imgData.data;
          const outData = ctx.createImageData(width, height);
          const outPixels = outData.data;

          const cy = height / 2.0;
          const cx = width / 2.0;
          const maxR = Math.sqrt(cx * cx + cy * cy);

          if (prismMode === 'Kaleidoscope') {
            const segments = 8;
            const segmentAngle = (2.0 * Math.PI) / segments;
            const halfAngle = segmentAngle / 2.0;

            for (let y = 0; y < height; y++) {
              const dy = y - cy;
              for (let x = 0; x < width; x++) {
                const dx = x - cx;
                const r = Math.sqrt(dx * dx + dy * dy);
                const theta = Math.atan2(dy, dx);

                let thetaMapped = theta % segmentAngle;
                if (thetaMapped < 0) thetaMapped += segmentAngle;

                const thetaMirror = halfAngle - Math.abs(thetaMapped - halfAngle);
                const thetaFinal = theta * (1.0 - prismIntensity) + thetaMirror * prismIntensity;

                const srcX = Math.max(0, Math.min(width - 1, Math.round(cx + r * Math.cos(thetaFinal))));
                const srcY = Math.max(0, Math.min(height - 1, Math.round(cy + r * Math.sin(thetaFinal))));

                const dstIdx = (y * width + x) * 4;
                const srcIdx = (srcY * width + srcX) * 4;

                outPixels[dstIdx]     = pixels[srcIdx];
                outPixels[dstIdx + 1] = pixels[srcIdx + 1];
                outPixels[dstIdx + 2] = pixels[srcIdx + 2];
                outPixels[dstIdx + 3] = pixels[srcIdx + 3];
              }
            }
            ctx.putImageData(outData, 0, 0);

          } else if (prismMode === 'Triple Split') {
            const shift = Math.round(width * 0.12 * prismIntensity);
            const opacity = 0.3 * prismIntensity;

            for (let y = 0; y < height; y++) {
              const rowOffset = y * width * 4;
              for (let x = 0; x < width; x++) {
                const idx = rowOffset + x * 4;

                const lx = (x - shift + width) % width;
                const lIdx = rowOffset + lx * 4;

                const rx = (x + shift) % width;
                const rIdx = rowOffset + rx * 4;

                const baseR = pixels[idx] / 255.0;
                const baseG = pixels[idx + 1] / 255.0;
                const baseB = pixels[idx + 2] / 255.0;

                const leftR = pixels[lIdx] / 255.0;
                const leftG = pixels[lIdx + 1] / 255.0;
                const leftB = pixels[lIdx + 2] / 255.0;

                const rightR = pixels[rIdx] / 255.0;
                const rightG = pixels[rIdx + 1] / 255.0;
                const rightB = pixels[rIdx + 2] / 255.0;

                const finalR = baseR * (1.0 - opacity * 2.0) + leftR * opacity + rightR * opacity;
                const finalG = baseG * (1.0 - opacity * 2.0) + leftG * opacity + rightG * opacity;
                const finalB = baseB * (1.0 - opacity * 2.0) + leftB * opacity + rightB * opacity;

                pixels[idx]     = Math.max(0, Math.min(255, Math.round(finalR * 255)));
                pixels[idx + 1] = Math.max(0, Math.min(255, Math.round(finalG * 255)));
                pixels[idx + 2] = Math.max(0, Math.min(255, Math.round(finalB * 255)));
              }
            }
            ctx.putImageData(imgData, 0, 0);

          } else if (prismMode === 'Refraction Ring') {
            const ringCenter = maxR * 0.6;
            const ringWidth = maxR * 0.15 * prismIntensity;

            for (let y = 0; y < height; y++) {
              const dy = y - cy;
              for (let x = 0; x < width; x++) {
                const dx = x - cx;
                const r = Math.sqrt(dx * dx + dy * dy);
                const theta = Math.atan2(dy, dx);

                const distToRing = Math.abs(r - ringCenter);
                const mask = Math.max(0.0, Math.min(1.0, 1.0 - distToRing / Math.max(1.0, ringWidth)));
                const distortion = Math.sin(mask * Math.PI) * 25.0 * prismIntensity;

                const rNew = r + distortion;
                const srcX = Math.max(0, Math.min(width - 1, Math.round(cx + rNew * Math.cos(theta))));
                const srcY = Math.max(0, Math.min(height - 1, Math.round(cy + rNew * Math.sin(theta))));

                const dstIdx = (y * width + x) * 4;
                const srcIdx = (srcY * width + srcX) * 4;

                outPixels[dstIdx]     = pixels[srcIdx];
                outPixels[dstIdx + 1] = pixels[srcIdx + 1];
                outPixels[dstIdx + 2] = pixels[srcIdx + 2];
                outPixels[dstIdx + 3] = pixels[srcIdx + 3];
              }
            }
            ctx.putImageData(outData, 0, 0);

          } else if (prismMode === 'Chromatic Edge') {
            for (let y = 0; y < height; y++) {
              const dy = y - cy;
              for (let x = 0; x < width; x++) {
                const dx = x - cx;
                const r = Math.sqrt(dx * dx + dy * dy);
                const theta = Math.atan2(dy, dx);

                const factor = r / maxR;
                const rShift = 0.05 * prismIntensity * factor;
                const bShift = -0.05 * prismIntensity * factor;

                const rx = Math.max(0, Math.min(width - 1, Math.round(cx + r * (1.0 + rShift) * Math.cos(theta))));
                const ry = Math.max(0, Math.min(height - 1, Math.round(cy + r * (1.0 + rShift) * Math.sin(theta))));

                const bx = Math.max(0, Math.min(width - 1, Math.round(cx + r * (1.0 + bShift) * Math.cos(theta))));
                const by = Math.max(0, Math.min(height - 1, Math.round(cy + r * (1.0 + bShift) * Math.sin(theta))));

                const dstIdx = (y * width + x) * 4;
                const rIdx = (ry * width + rx) * 4;
                const bIdx = (by * width + bx) * 4;

                outPixels[dstIdx]     = pixels[rIdx];
                outPixels[dstIdx + 1] = pixels[dstIdx + 1];
                outPixels[dstIdx + 2] = pixels[bIdx + 2];
                outPixels[dstIdx + 3] = pixels[dstIdx + 3];
              }
            }
            ctx.putImageData(outData, 0, 0);
          }
        }

        // -------------------------------------------------------------
        // 10D. Procedural Light Leaks
        // -------------------------------------------------------------
        const leaksEnabled = params.light_leaks_enabled === true || params.light_leaks_enabled === 'true';
        const leaksIntensity = parseFloat(params.light_leaks_intensity) ?? 0.5;
        const leaksSeed = parseInt(params.light_leaks_seed) ?? 12345;

        if (leaksEnabled && leaksIntensity > 0) {
          const imgData = ctx.getImageData(0, 0, width, height);
          const pixels = imgData.data;

          const rng = createLCG(leaksSeed);
          const numLeaks = 3;

          for (let leak = 0; leak < numLeaks; leak++) {
            let cx = 0, cy = 0;
            const edge = Math.floor(rng() * 4);
            if (edge === 0) {
              cx = rng() * (width * 0.1);
              cy = rng() * height;
            } else if (edge === 1) {
              cx = width * 0.9 + rng() * (width * 0.1);
              cy = rng() * height;
            } else if (edge === 2) {
              cx = rng() * width;
              cy = rng() * (height * 0.1);
            } else {
              cx = rng() * width;
              cy = height * 0.9 + rng() * (height * 0.1);
            }

            let tintR = 1.0, tintG = 0.35, tintB = 0.05;
            const colorType = Math.floor(rng() * 3);
            if (colorType === 1) {
              tintR = 1.0; tintG = 0.1; tintB = 0.4;
            } else if (colorType === 2) {
              tintR = 1.0; tintG = 0.75; tintB = 0.1;
            }

            const rx = (0.25 + rng() * 0.35) * width;
            const ry = (0.25 + rng() * 0.35) * height;
            const leakStrength = (0.6 + rng() * 0.4) * leaksIntensity;

            for (let y = 0; y < height; y++) {
              const dy = (y - cy) / ry;
              const rowOffset = y * width * 4;
              for (let x = 0; x < width; x++) {
                const dx = (x - cx) / rx;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < 1.0) {
                  let falloff = 1.0 - dist;
                  falloff = falloff * falloff * (3.0 - 2.0 * falloff);

                  const idx = rowOffset + x * 4;
                  const baseR = pixels[idx] / 255.0;
                  const baseG = pixels[idx + 1] / 255.0;
                  const baseB = pixels[idx + 2] / 255.0;

                  const leakR = falloff * tintR * leakStrength;
                  const leakG = falloff * tintG * leakStrength;
                  const leakB = falloff * tintB * leakStrength;

                  pixels[idx]     = Math.max(0, Math.min(255, Math.round((1.0 - (1.0 - baseR) * (1.0 - leakR)) * 255)));
                  pixels[idx + 1] = Math.max(0, Math.min(255, Math.round((1.0 - (1.0 - baseG) * (1.0 - leakG)) * 255)));
                  pixels[idx + 2] = Math.max(0, Math.min(255, Math.round((1.0 - (1.0 - baseB) * (1.0 - leakB)) * 255)));
                }
              }
            }
          }
          ctx.putImageData(imgData, 0, 0);
        }

        // -------------------------------------------------------------
        // 10E. Street Art Graffiti Stencil
        // -------------------------------------------------------------
        const stencilEnabled = params.stencil_enabled === true || params.stencil_enabled === 'true';
        const stencilMode = params.stencil_mode ?? 'Classic Red/Black';
        const stencilThreshold = parseFloat(params.stencil_threshold) ?? 0.5;
        const stencilSpray = parseFloat(params.stencil_spray) ?? 0.3;

        if (stencilEnabled) {
          const imgData = ctx.getImageData(0, 0, width, height);
          const pixels = imgData.data;

          const t1 = stencilThreshold * 0.6;
          const t2 = stencilThreshold * 1.3;

          let cShadow    = [5, 5, 5];
          let cMidtone   = [209, 30, 38];
          let cHighlight = [240, 236, 224];

          if (stencilMode === 'Cyber Neon') {
            cShadow    = [25, 5, 38];
            cMidtone   = [255, 0, 127];
            cHighlight = [0, 242, 255];
          } else if (stencilMode === 'High-Contrast B&W') {
            cShadow    = [0, 0, 0];
            cMidtone   = [64, 64, 64];
            cHighlight = [255, 255, 255];
          }

          const grayValues = new Float32Array(width * height);
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i] / 255.0;
            const g = pixels[i + 1] / 255.0;
            const b = pixels[i + 2] / 255.0;
            grayValues[i / 4] = r * 0.299 + g * 0.587 + b * 0.114;
          }

          const levels = new Int32Array(width * height);
          for (let i = 0; i < grayValues.length; i++) {
            const gVal = grayValues[i];
            if (gVal >= t2) {
              levels[i] = 2;
            } else if (gVal >= t1) {
              levels[i] = 1;
            } else {
              levels[i] = 0;
            }
          }

          if (stencilSpray > 0) {
            const lcg = createLCG(42);
            const splatterLcg = createLCG(1337);

            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const level = levels[idx];

                let isBoundary = false;
                if (x < width - 1 && levels[idx + 1] !== level) isBoundary = true;
                else if (y < height - 1 && levels[idx + width] !== level) isBoundary = true;

                if (isBoundary) {
                  if (lcg() < stencilSpray * 0.7) {
                    const rShift = splatterLcg();
                    let levelShift = 0;
                    if (rShift < 0.2) levelShift = -1;
                    else if (rShift > 0.8) levelShift = 1;
                    
                    levels[idx] = Math.max(0, Math.min(2, level + levelShift));
                  }
                }
              }
            }
          }

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const idx = (y * width + x) * 4;
              const gIdx = y * width + x;
              const level = levels[gIdx];

              let col = cShadow;
              if (level === 1) {
                col = cMidtone;
              } else if (level === 2) {
                col = cHighlight;
              }

              let isEdge = false;
              if (x < width - 1 && Math.abs(grayValues[gIdx] - grayValues[gIdx + 1]) > 0.08) isEdge = true;
              else if (y < height - 1 && Math.abs(grayValues[gIdx] - grayValues[gIdx + width]) > 0.08) isEdge = true;

              if (isEdge) {
                pixels[idx]     = Math.round(col[0] * 0.1);
                pixels[idx + 1] = Math.round(col[1] * 0.1);
                pixels[idx + 2] = Math.round(col[2] * 0.1);
              } else {
                pixels[idx]     = col[0];
                pixels[idx + 1] = col[1];
                pixels[idx + 2] = col[2];
              }
            }
          }
          ctx.putImageData(imgData, 0, 0);
        }

        // -------------------------------------------------------------
        // WB. White Balance — Color Temperature (Kelvin) + Tint
        // -------------------------------------------------------------
        const wbEnabled = params.whitebalance_enabled !== false && params.whitebalance_enabled !== 'false';
        const colorTempK = parseFloat(params.color_temp) || 6500;
        const colorTint  = parseFloat(params.color_tint)  || 0;
        const wbMode     = params.whitebalance_mode || 'manual';

        if (wbEnabled) {
          let rNorm = 1.0;
          let gNorm = 1.0;
          let bNorm = 1.0;
          let tintGreenBoost = 0;
          let tintMagentaRed = 0;
          let tintMagentaBlue = 0;

          if (wbMode === 'manual') {
            if (colorTempK !== 6500 || colorTint !== 0) {
              // Tanner Helland algorithm: Kelvin -> RGB gains
              function kelvinToRgbGains(kelvin) {
                const t = Math.max(1000, Math.min(40000, kelvin)) / 100.0;
                let rg, gg, bg;
                // Red
                if (t <= 66) rg = 1.0;
                else rg = Math.max(0, Math.min(1, 329.698727446 * Math.pow(t - 60, -0.1332047592) / 255.0));
                // Green
                if (t <= 66) gg = Math.max(0, Math.min(1, (99.4708025861 * Math.log(t) - 161.1195681661) / 255.0));
                else gg = Math.max(0, Math.min(1, 288.1221695283 * Math.pow(t - 60, -0.0755148492) / 255.0));
                // Blue
                if (t >= 66) bg = 1.0;
                else if (t <= 19) bg = 0.0;
                else bg = Math.max(0, Math.min(1, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255.0));
                return [rg, gg, bg];
              }

              // Normalise gains relative to D65 (6500K ≈ [1, 1, 1])
              const [rRef, gRef, bRef] = kelvinToRgbGains(6500);
              const [rGain, gGain, bGain] = kelvinToRgbGains(colorTempK);
              rNorm = rGain / Math.max(rRef, 1e-4);
              gNorm = gGain / Math.max(gRef, 1e-4);
              bNorm = bGain / Math.max(bRef, 1e-4);
              // Tint: positive = green, negative = magenta
              tintGreenBoost  = colorTint > 0 ?  colorTint * 0.15 : 0;
              tintMagentaRed  = colorTint < 0 ? -colorTint * 0.10 : 0;
              tintMagentaBlue = colorTint < 0 ? -colorTint * 0.10 : 0;
            }
          } else {
            // Auto or Smart AWB
            const wbData = ctx.getImageData(0, 0, targetW, targetH);
            const wbPixels = wbData.data;

            let sumR = 0, sumG = 0, sumB = 0, count = 0;
            // Downsample pixel evaluation to quickly compute channel-wide sums
            const step = Math.max(4, Math.floor(wbPixels.length / 40000)) * 4;

            for (let i = 0; i < wbPixels.length; i += step) {
              const r = wbPixels[i] / 255.0;
              const g = wbPixels[i+1] / 255.0;
              const b = wbPixels[i+2] / 255.0;

              if (wbMode === 'smart') {
                const maxVal = Math.max(r, g, b);
                const minVal = Math.min(r, g, b);
                const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                const sat = maxVal > 1e-5 ? (maxVal - minVal) / maxVal : 0;

                // Exclude very dark/bright and highly saturated pixels
                if (luma > 0.06 && luma < 0.94 && sat < 0.35) {
                  sumR += r;
                  sumG += g;
                  sumB += b;
                  count++;
                }
              } else {
                // Standard Auto
                sumR += r;
                sumG += g;
                sumB += b;
                count++;
              }
            }

            if (count > 0) {
              const avgR = sumR / count;
              const avgG = sumG / count;
              const avgB = sumB / count;
              const gray = (avgR + avgG + avgB) / 3.0;

              let rg = gray / Math.max(avgR, 1e-5);
              let gg = gray / Math.max(avgG, 1e-5);
              let bg = gray / Math.max(avgB, 1e-5);

              if (wbMode === 'smart') {
                // Keep some warmth (80% correction)
                rg = 1.0 + 0.8 * (rg - 1.0);
                gg = 1.0 + 0.8 * (gg - 1.0);
                bg = 1.0 + 0.8 * (bg - 1.0);

                // Limit gains to robust range
                rg = Math.max(0.65, Math.min(1.5, rg));
                gg = Math.max(0.65, Math.min(1.5, gg));
                bg = Math.max(0.65, Math.min(1.5, bg));
              } else {
                // Standard Auto: Limit gains to standard range
                rg = Math.max(0.5, Math.min(2.0, rg));
                gg = Math.max(0.5, Math.min(2.0, gg));
                bg = Math.max(0.5, Math.min(2.0, bg));
              }

              rNorm = rg;
              gNorm = gg;
              bNorm = bg;
            }
          }

          if (rNorm !== 1.0 || gNorm !== 1.0 || bNorm !== 1.0 || tintGreenBoost !== 0 || tintMagentaRed !== 0 || tintMagentaBlue !== 0) {
            const wbData = ctx.getImageData(0, 0, targetW, targetH);
            const wbPixels = wbData.data;
            for (let i = 0; i < wbPixels.length; i += 4) {
              let r = wbPixels[i]   / 255.0 * rNorm + tintMagentaRed;
              let g = wbPixels[i+1] / 255.0 * gNorm + tintGreenBoost;
              let b = wbPixels[i+2] / 255.0 * bNorm + tintMagentaBlue;
              wbPixels[i]   = Math.max(0, Math.min(255, Math.round(r * 255)));
              wbPixels[i+1] = Math.max(0, Math.min(255, Math.round(g * 255)));
              wbPixels[i+2] = Math.max(0, Math.min(255, Math.round(b * 255)));
            }
            ctx.putImageData(wbData, 0, 0);
          }
        }

        // -------------------------------------------------------------
        // SAT. Saturation + Vibrance
        // -------------------------------------------------------------
        const satEnabled  = params.saturation_enabled !== false && params.saturation_enabled !== 'false';
        const satAmount   = parseFloat(params.saturation) || 0;
        const vibAmount   = parseFloat(params.vibrance)   || 0;

        if (satEnabled && (satAmount !== 0 || vibAmount !== 0)) {
          const satData = ctx.getImageData(0, 0, targetW, targetH);
          const satPixels = satData.data;
          for (let i = 0; i < satPixels.length; i += 4) {
            let r = satPixels[i]   / 255.0;
            let g = satPixels[i+1] / 255.0;
            let b = satPixels[i+2] / 255.0;
            const luma = r * 0.299 + g * 0.587 + b * 0.114;

            // Saturation: uniform chroma boost
            if (satAmount !== 0) {
              const sf = 1.0 + satAmount;
              r = Math.max(0, Math.min(1, luma + (r - luma) * sf));
              g = Math.max(0, Math.min(1, luma + (g - luma) * sf));
              b = Math.max(0, Math.min(1, luma + (b - luma) * sf));
            }

            // Vibrance: smart boost (stronger on muted/desaturated colors)
            if (vibAmount !== 0) {
              const cmax = Math.max(r, g, b);
              const cmin = Math.min(r, g, b);
              const s = cmax > 1e-6 ? (cmax - cmin) / cmax : 0;
              const vf = 1.0 + vibAmount * (1.0 - s);
              r = Math.max(0, Math.min(1, luma + (r - luma) * vf));
              g = Math.max(0, Math.min(1, luma + (g - luma) * vf));
              b = Math.max(0, Math.min(1, luma + (b - luma) * vf));
            }

            satPixels[i]   = Math.round(r * 255);
            satPixels[i+1] = Math.round(g * 255);
            satPixels[i+2] = Math.round(b * 255);
          }
          ctx.putImageData(satData, 0, 0);
        }

        // -------------------------------------------------------------
        // SHP. Sharpness (Unsharp Mask via blur subtraction)
        // -------------------------------------------------------------
        const sharpEnabled   = params.sharpness_enabled !== false && params.sharpness_enabled !== 'false';
        const sharpAmount    = parseFloat(params.sharpness_amount) || 0;
        const sharpRadius    = parseFloat(params.sharpness_radius) || 1.0;
        const sharpThreshold = parseInt(params.sharpness_threshold) || 3;

        if (sharpEnabled && sharpAmount > 0) {
          // Create a blurred copy for USM
          const blurCanvas = document.createElement('canvas');
          blurCanvas.width = targetW;
          blurCanvas.height = targetH;
          const bCtx = blurCanvas.getContext('2d');
          bCtx.filter = `blur(${Math.max(0.3, sharpRadius)}px)`;
          bCtx.drawImage(workCanvas, 0, 0);

          const sharpData = ctx.getImageData(0, 0, targetW, targetH);
          const sharpPixels = sharpData.data;
          const blurPixels  = bCtx.getImageData(0, 0, targetW, targetH).data;

          // USM: out = original + amount * (original - blur)  when |orig - blur| > threshold
          const usmPercent = sharpAmount * 1.5; // 0..2 -> 0..3
          const thresholdVal = sharpThreshold / 255.0;

          for (let i = 0; i < sharpPixels.length; i += 4) {
            for (let c = 0; c < 3; c++) {
              const orig = sharpPixels[i + c] / 255.0;
              const blur = blurPixels[i + c] / 255.0;
              const diff = orig - blur;
              if (Math.abs(diff) > thresholdVal) {
                const result = orig + diff * usmPercent;
                sharpPixels[i + c] = Math.max(0, Math.min(255, Math.round(result * 255)));
              }
            }
          }
          ctx.putImageData(sharpData, 0, 0);
        }

        // Processing finished! Return the canvas
        resolve(workCanvas);

      } catch (err) {
        reject(err);
      }
    });
  }

  return {
    processImage: processImage
  };
})();

// Export for mobile/web imports
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OneArtProcessor;
}
