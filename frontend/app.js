/**
 * OneArt Photo Studio — Frontend Logic
 * =====================================
 * Communicates with the Python backend via pywebview JS-Python bridge.
 */

(function () {
  'use strict';

  // ───────────────── State ─────────────────
  let imageLoaded = false;
  let resultReady = false;
  let isProcessing = false;
  let apiReady = false;
  let comparePosition = 50; // percentage

  // ───────────────── DOM refs ─────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const uploadZone     = $('#uploadZone');
  const fileInput      = $('#fileInput');
  const uploadContent  = $('#uploadContent');
  const previewContainer = $('#previewContainer');
  const previewImage   = $('#previewImage');
  const resultImage    = $('#resultImage');
  const comparisonSlider = $('#comparisonSlider');
  const comparisonLabels = $('#comparisonLabels');
  const btnRemoveImage = $('#btnRemoveImage');
  const btnProcess     = $('#btnProcess');
  const btnSave        = $('#btnSave');
  const loadingOverlay = $('#loadingOverlay');
  const statusDot      = $('#statusDot');
  const statusText     = $('#statusText');
  const toastContainer = $('#toastContainer');
  const pywebviewNotice = $('#pywebviewNotice');

  // ───────────────── Initialization ─────────────────

  function init() {
    apiReady = true;
    setStatus('ready', 'Ready');
    toast('Backend connected', 'info');
    if (pywebviewNotice) pywebviewNotice.classList.add('hidden');
  }

  // Wait for pywebview
  if (window.pywebview && window.pywebview.api) {
    init();
  } else {
    window.addEventListener('pywebviewready', init);
    // Show notice if not ready after 2s (browser preview mode)
    setTimeout(() => {
      if (!apiReady && pywebviewNotice) {
        pywebviewNotice.classList.remove('hidden');
      }
    }, 2000);
  }

  // ───────────────── Upload Handling ─────────────────

  uploadZone.addEventListener('click', () => {
    if (apiReady) {
      // Use native file dialog via Python
      callApi('pick_file').then(handleLoadResult);
    } else {
      fileInput.click();
    }
  });

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
  });

  // Prevent browser default drop behavior on window to avoid navigating away
  window.addEventListener('dragover', (e) => e.preventDefault(), false);
  window.addEventListener('drop', (e) => e.preventDefault(), false);

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const reader = new FileReader();
      reader.onload = function(evt) {
        callApi('load_image_data', evt.target.result, file.name).then(handleLoadResult);
      };
      reader.onerror = function() {
        toast('Failed to read dropped file', 'error');
      };
      reader.readAsDataURL(file);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const reader = new FileReader();
      reader.onload = function(evt) {
        callApi('load_image_data', evt.target.result, file.name).then(handleLoadResult);
      };
      reader.readAsDataURL(file);
    }
  });

  function handleLoadResult(res) {
    if (!res || !res.ok) {
      toast(res ? res.error : 'Failed to load image', 'error');
      return;
    }
    imageLoaded = true;
    resultReady = false;

    previewImage.src = res.preview;
    resultImage.src = '';
    resultImage.classList.add('hidden');
    comparisonSlider.classList.add('hidden');
    comparisonLabels.classList.add('hidden');

    uploadZone.classList.add('hidden');
    previewContainer.classList.remove('hidden');

    btnProcess.disabled = false;
    btnSave.classList.add('hidden');
    setStatus('ready', `${res.filename} — ${res.width}×${res.height}`);
    toast(`Loaded: ${res.filename}`, 'success');
  }

  // ───────────────── Remove Image ─────────────────
  btnRemoveImage.addEventListener('click', () => {
    imageLoaded = false;
    resultReady = false;
    previewImage.src = '';
    resultImage.src = '';
    uploadZone.classList.remove('hidden');
    previewContainer.classList.add('hidden');
    btnProcess.disabled = true;
    btnSave.classList.add('hidden');
    setStatus('ready', 'Ready');
  });

  // ───────────────── Section Toggle ─────────────────
  $$('.section-header').forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.closest('.section');
      const isCollapsed = section.classList.contains('collapsed');
      section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
    });
  });

  // ───────────────── Slider Value Labels ─────────────────
  $$('input[type="range"].slider').forEach((slider) => {
    const valEl = $(`#val_${slider.id}`);
    if (valEl) {
      slider.addEventListener('input', () => {
        const step = parseFloat(slider.step) || 1;
        const decimals = step < 1 ? Math.max(String(step).split('.')[1]?.length || 0, 2) : 0;
        valEl.textContent = parseFloat(slider.value).toFixed(decimals);
      });
    }
  });

  // ───────────────── Reset Buttons ─────────────────
  const sectionDefaults = {
    noise: ['noise_level', 'blue_bias'],
    grain: ['grain_strength', 'grain_size'],
    lenswarp: ['distortion', 'chromatic_aberration', 'edge_softness'],
    stylefx: ['mode', 'strength', 'radius', 'threshold', 'seed'],
    vignette: ['outer_brightness', 'inner_brightness'],
    toneadjust: ['brightness', 'contrast', 'light_balance', 'highlights', 'shadows', 'warmth'],
    metadata: ['preset', 'artist', 'focal_length_mm', 'fnumber', 'exposure_1_over_s', 'iso', 'quality'],
  };

  $$('.reset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sectionName = btn.dataset.reset;
      const ids = sectionDefaults[sectionName] || [];
      ids.forEach((id) => {
        const el = $(`#${id}`);
        if (!el) return;
        const def = el.dataset.default;
        if (def !== undefined) {
          el.value = def;
          // Trigger input event to update value labels
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      toast(`${sectionName} reset to defaults`, 'info');
    });
  });

  // ───────────────── Process Photo ─────────────────
  btnProcess.addEventListener('click', async () => {
    if (!imageLoaded || isProcessing || !apiReady) return;

    isProcessing = true;
    btnProcess.disabled = true;
    loadingOverlay.classList.remove('hidden');
    setStatus('processing', 'Processing…');

    const params = collectParams();

    try {
      const res = await callApi('process_image', JSON.stringify(params));
      if (!res || !res.ok) {
        toast(res ? res.error : 'Processing failed', 'error');
        setStatus('error', 'Error');
        return;
      }

      resultReady = true;
      resultImage.src = res.preview;
      resultImage.classList.remove('hidden');
      comparisonSlider.classList.remove('hidden');
      comparisonLabels.classList.remove('hidden');
      btnSave.classList.remove('hidden');

      // Reset compare position
      setComparePosition(50);

      setStatus('ready', `Done — ${res.width}×${res.height}`);
      toast('Processing complete!', 'success');
    } catch (err) {
      toast('Processing error: ' + err.message, 'error');
      setStatus('error', 'Error');
    } finally {
      isProcessing = false;
      btnProcess.disabled = !imageLoaded;
      loadingOverlay.classList.add('hidden');
    }
  });

  // ───────────────── Save ─────────────────
  btnSave.addEventListener('click', async () => {
    if (!resultReady || !apiReady) return;

    const params = collectMetadataParams();
    setStatus('processing', 'Saving…');

    try {
      const res = await callApi('save_image', JSON.stringify(params));
      if (!res || !res.ok) {
        toast(res ? res.error : 'Save failed', 'error');
        setStatus('error', 'Save error');
        return;
      }
      toast(`Saved: ${res.filename}`, 'success');
      setStatus('ready', `Saved: ${res.filename}`);
    } catch (err) {
      toast('Save error: ' + err.message, 'error');
      setStatus('error', 'Error');
    }
  });

  // ───────────────── Comparison Slider ─────────────────
  let isDragging = false;

  comparisonSlider.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const wrapper = previewContainer.querySelector('.comparison-wrapper');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.max(2, Math.min(98, pct));
    setComparePosition(pct);
  });

  document.addEventListener('mouseup', () => { isDragging = false; });

  function setComparePosition(pct) {
    comparePosition = pct;
    comparisonSlider.style.left = pct + '%';
    resultImage.style.clipPath = `inset(0 0 0 ${pct}%)`;
  }

  // ───────────────── Helpers ─────────────────

  function collectParams() {
    return {
      // Noise
      noise_level: getVal('noise_level'),
      blue_bias: getVal('blue_bias'),
      // Grain
      grain_strength: getVal('grain_strength'),
      grain_size: getVal('grain_size'),
      // Lens Warp
      distortion: getVal('distortion'),
      chromatic_aberration: getVal('chromatic_aberration'),
      edge_softness: getVal('edge_softness'),
      // Style FX
      mode: $(`#mode`).value,
      strength: getVal('strength'),
      radius: getVal('radius'),
      threshold: getVal('threshold'),
      seed: getVal('seed'),
      // Vignette
      outer_brightness: getVal('outer_brightness'),
      inner_brightness: getVal('inner_brightness'),
      // Tone Adjust
      brightness: getVal('brightness'),
      contrast: getVal('contrast'),
      light_balance: getVal('light_balance'),
      highlights: getVal('highlights'),
      shadows: getVal('shadows'),
      warmth: getVal('warmth'),
    };
  }

  function collectMetadataParams() {
    return {
      preset: $(`#preset`).value,
      artist: $(`#artist`).value,
      focal_length_mm: $(`#focal_length_mm`).value,
      fnumber: $(`#fnumber`).value,
      exposure_1_over_s: $(`#exposure_1_over_s`).value,
      iso: getVal('iso'),
      quality: getVal('quality'),
    };
  }

  function getVal(id) {
    const el = $(`#${id}`);
    if (!el) return 0;
    return parseFloat(el.value) || 0;
  }

  async function callApi(method, ...args) {
    if (!window.pywebview || !window.pywebview.api) {
      toast('Backend not connected', 'error');
      return null;
    }
    return window.pywebview.api[method](...args);
  }

  function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;
  }

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    toastContainer.appendChild(el);

    setTimeout(() => {
      el.classList.add('removing');
      setTimeout(() => el.remove(), 250);
    }, 3500);
  }
})();
