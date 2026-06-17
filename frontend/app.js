/**
 * OneArt Photo Studio — Frontend Logic
 * =====================================
 * Communicates with the Python backend via pywebview JS-Python bridge.
 * Implements full English and Russian localization.
 */

(function () {
  'use strict';

  // ───────────────── State ─────────────────
  let imageLoaded = false;
  let resultReady = false;
  let isProcessing = false;
  let apiReady = false;
  let useClientSide = false;
  let originalImage = null;
  let currentFilename = '';
  let comparePosition = 50; // percentage
  let currentLang = localStorage.getItem('oneart_lang') || 'en';
  let statusState = 'ready';
  let statusExtra = '';
  let aiMaskLoading = false;

  // v3 State
  let undoStack = [];
  let redoStack = [];
  let currentZoom = 1.0;
  let zoomX = 0;
  let zoomY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let isPanning = false;
  let cropActive = false;
  let cropRect = { x: 10, y: 10, w: 80, h: 80 }; // percentages
  let activeHandle = null;
  let dragStart = { x: 0, y: 0 };
  let rectStart = { x: 0, y: 0, w: 0, h: 0 };
  let compareMode = 'split';
  let holdOriginalActive = false;
  let batchModeActive = false;
  let batchQueue = [];

  // Tone Curves & RAW state (v6.0)
  let curvePoints = {
    rgb: [{x: 0, y: 0}, {x: 255, y: 255}],
    red: [{x: 0, y: 0}, {x: 255, y: 255}],
    green: [{x: 0, y: 0}, {x: 255, y: 255}],
    blue: [{x: 0, y: 0}, {x: 255, y: 255}]
  };
  let activeCurveChannel = 'rgb';
  let activeCurvePointIndex = -1;

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
  const btnExportLUT   = $('#btnExportLUT');
  const loadingOverlay = $('#loadingOverlay');
  const statusDot      = $('#statusDot');
  const statusText     = $('#statusText');
  const toastContainer = $('#toastContainer');
  const pywebviewNotice = $('#pywebviewNotice');

  // v3 DOM refs
  const comparisonViewport = $('#comparisonViewport');
  const comparisonWrapper = $('#comparisonWrapper');
  const cropBox        = $('#cropBox');
  const batchContainer = $('#batchContainer');
  const batchGrid      = $('#batchGrid');
  const batchProgressWrapper = $('#batchProgressWrapper');
  const batchProgressBar = $('#batchProgressBar');
  const batchProgressText = $('#batchProgressText');
  const btnProcessBatch = $('#btnProcessBatch');
  const btnToggleBatchMode = $('#btnToggleBatchMode');
  const btnClearBatch  = $('#btnClearBatch');
  const btnSelectBatchFiles = $('#btnSelectBatchFiles');
  const batchFileInput = $('#batchFileInput');
  const presetsSelect  = $('#presets_select');
  
  const webglPreviewCanvas = $('#webglPreviewCanvas');
  let webglActive = false;
  let ws = null;
  let wsReady = false;
  const pendingWsRequests = new Map();
  let wsRequestId = 0;
  
  const btnSavePreset  = $('#btnSavePreset');
  const btnDeletePreset = $('#btnDeletePreset');
  const cropEnabledCheckbox = $('#crop_enabled');
  const cropAspectRatioSelect = $('#crop_aspect_ratio');
  const resizeScaleSlider = $('#resize_scale');
  const resizeWidthInput  = $('#resize_width');
  const resizeHeightInput = $('#resize_height');
  const lutLookSelect     = $('#lut_look');
  const lutIntensitySlider = $('#lut_intensity');
  const exportFormatSelect = $('#export_format');

  const btnUndo = $('#btnUndo');
  const btnRedo = $('#btnRedo');
  const btnCompareSplit = $('#btnCompareSplit');
  const btnCompareSide = $('#btnCompareSide');
  const btnCompareHold = $('#btnCompareHold');
  const btnResetZoom = $('#btnResetZoom');

  // ───────────────── Localization Maps ─────────────────
  const TRANSLATIONS = {
    en: {
      appTitle: "Photo Studio",
      dropTitle: "Drop your photo here",
      dropHint: "or click to browse &middot; JPG, PNG, TIFF, WebP",
      beforeLabel: "BEFORE",
      afterLabel: "AFTER",
      btnRemove: "Remove image",
      btnProcess: "Process Photo",
      btnSave: "Save",
      statusReady: "Ready",
      statusProcessing: "Processing...",
      statusSaving: "Saving...",
      statusSaved: "Saved: {filename}",
      statusError: "Error",
      loadingText: "Processing your photo...",
      
      secNoise: "Noise",
      secGrain: "Grain",
      secLensWarp: "Lens Warp",
      secStyleFx: "Style FX",
      secVignette: "Vignette",
      secToneAdjust: "Tone Adjust",
      secMetadata: "Metadata (EXIF)",
      
      btnReset: "Reset",
      
      lblNoiseLevel: "Noise Level",
      lblBlueBias: "Blue Bias",
      lblGrainStrength: "Grain Strength",
      lblGrainSize: "Grain Size",
      lblDistortion: "Distortion",
      lblChromaticAberration: "Chromatic Aberration",
      lblEdgeSoftness: "Edge Softness",
      lblFocusMaskMode: "Focus Mask Mode",
      lblLensBokehStyle: "Lens Bokeh Style",
      lblBokehSize: "Bokeh Size (Radius)",
      lblHighlightBoost: "Highlight Boost",
      lblBokehRotation: "Bokeh Rotation",
      lblFocusPosX: "Focus Position X",
      lblFocusPosY: "Focus Position Y",
      lblFocusSize: "Focus Size (Radius)",
      lblFocusAngle: "Focus Angle",
      lblTransitionSoftness: "Transition Softness",
      lblMode: "Mode",
      lblStrength: "Strength",
      lblRadius: "Radius",
      lblThreshold: "Threshold",
      lblSeed: "Seed",
      lblOuterBrightness: "Outer Brightness",
      lblInnerBrightness: "Inner Brightness",
      lblBrightness: "Brightness",
      lblContrast: "Contrast",
      lblLightBalance: "Light Balance",
      lblHighlights: "Highlights",
      lblShadows: "Shadows",
      lblWarmth: "Warmth",
      lblCameraPreset: "Camera Preset",
      lblArtist: "Artist",
      lblFocalLength: "Focal Length (mm)",
      lblFNumber: "f/Number",
      lblExposure: "Exposure (1/s)",
      lblIso: "ISO",
      lblQuality: "Quality",
      
      optGlitchArt: "GlitchArt",
      optSoftPortrait: "SoftPortrait",
      optCinematicGrade: "CinematicGrade",
      optHalation: "Halation",
      optBloom: "Bloom",
      optRetroFilm: "RetroFilm",
      optDuotone: "Duotone",
      optMatte: "Matte",
      optMaskAuto: "Auto (AI Subject)",
      optMaskRadial: "Radial Focus",
      optMaskLinear: "Linear Focus (Tilt-Shift)",
      optMaskNone: "Full Image",
      optLensCircular: "Circular (Classic)",
      optLensPentagon: "Pentagonal (5 Blades)",
      optLensHexagon: "Hexagonal (Helios / Soviet)",
      optLensOctagon: "Octagonal (Modern DSLR)",
      optLensDonut: "Reflex Lens (Donut/Ring)",
      btnDetectSubject: "🎯 Detect AI Subject",
      
      toastConnected: "Backend connected",
      toastNoFile: "No file selected",
      toastLoadError: "Failed to load image",
      toastLoaded: "Loaded: {filename}",
      toastReset: "{section} reset to defaults",
      toastProcFailed: "Processing failed",
      toastProcComplete: "Processing complete!",
      toastSaveFailed: "Save failed",
      toastSaved: "Saved: {filename}",
      toastSaveError: "Save error",
      toastDragError: "Drag & drop requires desktop mode",
      toastReadError: "Failed to read dropped file",
      toastWebNotice: "Running in browser preview — backend API unavailable",

      // v3 English Translations
      secPresets: "Photo Styles",
      secHistogram: "Live Histogram",
      secDimensions: "Dimensions & Crop",
      secColorLooks: "Color Looks (LUT)",
      btnSavePreset: "Save Current",
      btnDeletePreset: "Delete",
      lblSelectPreset: "Photo Style",
      optDefault: "— No Style —",
      lblEnableCrop: "Enable Crop Overlay",
      lblCropRatio: "Aspect Ratio",
      lblResizeScale: "Resize Scale (%)",
      lblWidth: "Width (px)",
      lblHeight: "Height (px)",
      lblColorLook: "Select Look",
      lblLookIntensity: "Intensity",
      lblExportFormat: "Export Format",
      optRatioFree: "Free",
      optLookNone: "None",
      btnBatchMode: "Batch Mode",
      batchTitle: "Batch Queue",
      btnClearBatch: "Clear All",
      btnSelectBatchFiles: "Add Files",
      btnProcessBatch: "Run Batch Process",
      // v4 English Translations
      lblInfrared: "Infrared Film (Aerochrome)",
      lblInfraredIntensity: "Intensity",
      lblCyberpunkFlare: "Anamorphic Sci-Fi Flare",
      lblCyberpunkThreshold: "Brightness Threshold",
      lblCyberpunkRadius: "Stretch Radius",
      lblCyberpunkTint: "Flare Tint",
      lblCyberpunkIntensity: "Intensity",
      lblGlassPrism: "Glass Prism Refractions",
      lblPrismMode: "Prism Mode",
      lblPrismIntensity: "Distortion Intensity",
      lblLightLeaks: "Procedural Light Leaks",
      lblLightLeaksIntensity: "Leak Intensity",
      lblLightLeaksSeed: "Seed",
      lblStencil: "Street Art Graffiti Stencil",
      lblStencilMode: "Color Palette",
      lblStencilThreshold: "Stencil Threshold",
      lblStencilSpray: "Paint Spray Amount",
      // v5.2 — Sharpness, White Balance, Saturation
      secWhiteBalance: "White Balance",
      secSharpness: "Sharpness",
      secSaturation: "Saturation & Vibrance",
      lblColorTemp: "Temperature (K)",
      lblColorTint: "Tint (Green\u2194Magenta)",
      lblSharpAmount: "Amount",
      lblSharpRadius: "Radius (px)",
      lblSharpThreshold: "Threshold",
      lblSaturation: "Saturation",
      lblVibrance: "Vibrance",
      hintVibrance: "Smart boost: protects already-saturated colors",
      lblWhiteBalanceMode: "Mode",
      optWBManual: "Manual",
      optWBAuto: "Auto (Grey World)",
      optWBSmart: "Smart (Robust)",
      btnApplyStyleSliders: "Apply to Sliders",
      lblStyleTransferMode: "Match Mode",
      optStyleModePixel: "Pixel Match (CIELAB)",
      optStyleModeSliders: "Slider Match (UI Dilations)",
      secCurves: "Tone Curves",
      secRawDevelop: "RAW Develop",
      lblRawDemosaic: "Demosaicing Algorithm",
      lblRawExposure: "RAW Exposure (EV)",
      lblRawHighlightRecovery: "Highlight Recovery",
      btnExportLUT: "Export 3D LUT"
    },
    ru: {
      appTitle: "Фотостудия",
      dropTitle: "Перетащите фото сюда",
      dropHint: "или кликните для выбора &middot; JPG, PNG, TIFF, WebP",
      beforeLabel: "ДО",
      afterLabel: "ПОСЛЕ",
      btnRemove: "Удалить фото",
      btnProcess: "Обработать фото",
      btnSave: "Сохранить",
      statusReady: "Готов",
      statusProcessing: "Обработка...",
      statusSaving: "Сохранение...",
      statusSaved: "Сохранено: {filename}",
      statusError: "Ошибка",
      loadingText: "Обработка вашей фотографии...",
      
      secNoise: "Шум",
      secGrain: "Зернистость",
      secLensWarp: "Искажение линзы",
      secStyleFx: "Стилизация FX",
      secVignette: "Виньетка",
      secToneAdjust: "Коррекция тона",
      secMetadata: "Метаданные (EXIF)",
      
      btnReset: "Сбросить",
      
      lblNoiseLevel: "Уровень шума",
      lblBlueBias: "Баланс синего",
      lblGrainStrength: "Сила зерна",
      lblGrainSize: "Размер зерна",
      lblDistortion: "Дисторсия",
      lblChromaticAberration: "Хромат. аберрация",
      lblEdgeSoftness: "Мягкость краев",
      lblFocusMaskMode: "Режим фокуса (маска)",
      lblLensBokehStyle: "Стиль боке объектива",
      lblBokehSize: "Размер боке (радиус)",
      lblHighlightBoost: "Усиление бликов",
      lblBokehRotation: "Вращение боке",
      lblFocusPosX: "Положение фокуса X",
      lblFocusPosY: "Положение фокуса Y",
      lblFocusSize: "Размер зоны фокуса",
      lblFocusAngle: "Угол наклона фокуса",
      lblTransitionSoftness: "Мягкость перехода",
      lblMode: "Режим",
      lblStrength: "Интенсивность",
      lblRadius: "Радиус",
      lblThreshold: "Порог",
      lblSeed: "Сид (Seed)",
      lblOuterBrightness: "Внешняя яркость",
      lblInnerBrightness: "Внутренняя яркость",
      lblBrightness: "Яркость",
      lblContrast: "Контраст",
      lblLightBalance: "Световой баланс",
      lblHighlights: "Светлые тона",
      lblShadows: "Тени",
      lblWarmth: "Теплота",
      lblCameraPreset: "Пресет камеры",
      lblArtist: "Автор",
      lblFocalLength: "Фокусное расстояние (мм)",
      lblFNumber: "Диафрагма (f/число)",
      lblExposure: "Выдержка (1/с)",
      lblIso: "ISO",
      lblQuality: "Качество",
      
      optGlitchArt: "Глитч-арт",
      optSoftPortrait: "Мягкий портрет",
      optCinematicGrade: "Кинематографичный",
      optHalation: "Ореол киноленты",
      optBloom: "Размытие (Bloom)",
      optRetroFilm: "Ретро-пленка",
      optDuotone: "Дуотон",
      optMatte: "Матовый",
      optMaskAuto: "Авто (ИИ маска объекта)",
      optMaskRadial: "Радиальный фокус",
      optMaskLinear: "Линейный фокус (Тилт-Шифт)",
      optMaskNone: "Все изображение",
      optLensCircular: "Круглое (Классический)",
      optLensPentagon: "Пятиугольное (5 лепестков)",
      optLensHexagon: "Шестиугольное (Гелиос / СССР)",
      optLensOctagon: "Восьмиугольное (Современный)",
      optLensDonut: "Зеркальный (Бублик)",
      btnDetectSubject: "🎯 Распознать объект (ИИ)",
      
      toastConnected: "Бэкенд подключен",
      toastNoFile: "Файл не выбран",
      toastLoadError: "Не удалось загрузить изображение",
      toastLoaded: "Загружено: {filename}",
      toastReset: "Настройки {section} сброшены",
      toastProcFailed: "Ошибка обработки",
      toastProcComplete: "Обработка завершена!",
      toastSaveFailed: "Ошибка сохранения",
      toastSaved: "Сохранено: {filename}",
      toastSaveError: "Ошибка при сохранении",
      toastDragError: "Для перетаскивания нужен десктопный режим",
      toastReadError: "Не удалось прочитать файл",
      toastWebNotice: "Запущено в браузере — API бэкенда недоступен",

      // v3 Russian Translations
      secPresets: "Пресеты",
      secHistogram: "Гистограмма",
      secDimensions: "Размер и Кроп",
      secColorLooks: "LUT Профили",
      btnSavePreset: "Сохранить",
      btnDeletePreset: "Удалить",
      lblSelectPreset: "Фото-стиль",
      optDefault: "— Без стиля —",
      lblEnableCrop: "Включить рамку кропа",
      lblCropRatio: "Пропорции",
      lblResizeScale: "Масштаб (%)",
      lblWidth: "Ширина (px)",
      lblHeight: "Высота (px)",
      lblColorLook: "Цветовой лук",
      lblLookIntensity: "Интенсивность",
      lblExportFormat: "Формат файла",
      optRatioFree: "Свободные",
      optLookNone: "Нет",
      btnBatchMode: "Пакетный режим",
      batchTitle: "Очередь обработки",
      btnClearBatch: "Очистить все",
      btnSelectBatchFiles: "Добавить файлы",
      btnProcessBatch: "Запустить обработку",
      // v4 Russian Translations
      lblInfrared: "Инфракрасная пленка (Aerochrome)",
      lblInfraredIntensity: "Интенсивность",
      lblCyberpunkFlare: "Анаморфные Sci-Fi блики",
      lblCyberpunkThreshold: "Порог яркости",
      lblCyberpunkRadius: "Радиус растяжения",
      lblCyberpunkTint: "Цвет бликов",
      lblCyberpunkIntensity: "Интенсивность",
      lblGlassPrism: "Преломление стеклянной призмы",
      lblPrismMode: "Режим призмы",
      lblPrismIntensity: "Интенсивность искажения",
      lblLightLeaks: "Процедурные засветки",
      lblLightLeaksIntensity: "Интенсивность утечки",
      lblLightLeaksSeed: "Сид засветки",
      lblStencil: "Трафаретное граффити (Стрит-арт)",
      lblStencilMode: "Цветовая палитра",
      lblStencilThreshold: "Порог трафарета",
      lblStencilSpray: "Напыление краски",
      // v5.2 — Sharpness, White Balance, Saturation
      secWhiteBalance: "Баланс белого",
      secSharpness: "Резкость",
      secSaturation: "Насыщенность и вибрация",
      lblColorTemp: "Температура (К)",
      lblColorTint: "Тинт (Зелёный\u2194Пурпурный)",
      lblSharpAmount: "Интенсивность",
      lblSharpRadius: "Радиус (px)",
      lblSharpThreshold: "Порог контраста",
      lblSaturation: "Насыщенность",
      lblVibrance: "Вибрация",
      hintVibrance: "Умный буст: защищает уже насыщенные цвета",
      lblWhiteBalanceMode: "Режим",
      optWBManual: "Вручную",
      optWBAuto: "Авто (по серому миру)",
      optWBSmart: "Умный (сбалансированный)",
      btnApplyStyleSliders: "Применить к ползункам",
      lblStyleTransferMode: "Режим соответствия",
      optStyleModePixel: "Pixel Match (CIELAB)",
      optStyleModeSliders: "Slider Match (Ползунки интерфейса)",
      secCurves: "Тоновые кривые",
      secRawDevelop: "Проявка RAW",
      lblRawDemosaic: "Алгоритм демозаики",
      lblRawExposure: "Экспозиция RAW (EV)",
      lblRawHighlightRecovery: "Восстановление светов",
      btnExportLUT: "Экспорт 3D LUT"
    }
  };

  // ───────────────── Localization Logic ─────────────────

  function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('oneart_lang', lang);

    $$('.lang-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    const t = TRANSLATIONS[lang];
    if (!t) return;

    // Translate all elements with data-i18n attribute
    $$('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (t[key]) {
        // Only replace text node to preserve spans (like numerical outputs) or SVGs inside buttons
        let textNode = Array.from(el.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
        if (textNode) {
          textNode.nodeValue = t[key];
        } else {
          el.textContent = t[key];
        }
      }
    });

    // Translate titles
    $$('[data-i18n-title]').forEach((el) => {
      const key = el.dataset.i18nTitle;
      if (t[key]) {
        el.title = t[key];
      }
    });

    // Toggle info modal translations
    const infoEN = $('#infoEN');
    const infoRU = $('#infoRU');
    if (infoEN && infoRU) {
      if (lang === 'ru') {
        infoEN.style.display = 'none';
        infoRU.style.display = 'block';
      } else {
        infoEN.style.display = 'block';
        infoRU.style.display = 'none';
      }
    }

    updateStatusText();
  }

  function updateStatusText() {
    const t = TRANSLATIONS[currentLang];
    if (statusState === 'ready') {
      statusText.textContent = statusExtra ? statusExtra : t.statusReady;
    } else if (statusState === 'processing') {
      statusText.textContent = statusExtra ? statusExtra : t.statusProcessing;
    } else if (statusState === 'error') {
      statusText.textContent = statusExtra ? statusExtra : t.statusError;
    } else if (statusState === 'saved') {
      statusText.textContent = t.statusSaved.replace('{filename}', statusExtra);
    }
  }

  function setStatus(state, extra = '') {
    statusState = state;
    statusExtra = extra;
    statusDot.className = 'status-dot ' + (state === 'saved' || state === 'ready' ? 'ready' : state);
    updateStatusText();
  }

  function showToast(key, extra = '', type = 'info') {
    const t = TRANSLATIONS[currentLang];
    let msg = t[key] || key;
    if (extra) {
      // Handle template replacement
      msg = msg.replace('{filename}', extra).replace('{section}', extra);
    }
    toast(msg, type);
  }

  // ───────────────── Initialization ─────────────────

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then((reg) => console.log('Service Worker registered', reg))
          .catch((err) => console.error('Service Worker registration failed', err));
      });
    }
  }

  function init() {
    apiReady = true;
    setLanguage(currentLang);
    setStatus('ready');
    showToast('toastConnected', '', 'info');
    if (pywebviewNotice) pywebviewNotice.classList.add('hidden');
    registerServiceWorker();
  }

  // Set initial language immediately on execution
  setLanguage(currentLang);

  function initClientSide() {
    useClientSide = true;
    imageLoaded = false;
    resultReady = false;
    setLanguage(currentLang);
    setStatus('ready');
    if (pywebviewNotice) pywebviewNotice.classList.add('hidden');
    toast(currentLang === 'ru' ? 'Запущено локально в браузере (без бэкенда)' : 'Running client-side in browser', 'info');
    registerServiceWorker();
  }

  // Wait for pywebview
  if (window.pywebview && window.pywebview.api) {
    init();
  } else {
    window.addEventListener('pywebviewready', init);
    // Fall back to client-side mode if not ready after 1.5s
    setTimeout(() => {
      if (!apiReady) {
        initClientSide();
      }
    }, 1500);
  }

  // Language switch triggers
  $$('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setLanguage(btn.dataset.lang);
    });
  });

  // ───────────────── Upload Handling ─────────────────
  function loadLocalFile(file) {
    const reader = new FileReader();
    reader.onload = function(evt) {
      const base64Data = evt.target.result;
      const img = new Image();
      img.onload = function() {
        originalImage = img;
        currentFilename = file.name;
        
        // Generate preview scaled to max 1600px
        const canvas = document.createElement('canvas');
        const w = img.width;
        const h = img.height;
        const maxSide = 1600;
        
        if (Math.max(w, h) > maxSide) {
          const ratio = maxSide / Math.max(w, h);
          canvas.width = Math.round(w * ratio);
          canvas.height = Math.round(h * ratio);
        } else {
          canvas.width = w;
          canvas.height = h;
        }
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const previewBase64 = canvas.toDataURL('image/jpeg', 0.92);
        
        handleLoadResult({
          ok: true,
          preview: previewBase64,
          width: w,
          height: h,
          filename: file.name
        });
      };
      img.onerror = function() {
        showToast('toastLoadError', '', 'error');
      };
      img.src = base64Data;
    };
    reader.onerror = function() {
      showToast('toastReadError', '', 'error');
    };
    reader.readAsDataURL(file);
  }

  uploadZone.addEventListener('click', () => {
    if (apiReady && !useClientSide) {
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
      currentFilename = file.name;  // Set BEFORE async call
      aiMaskLoading = false;
      if (useClientSide) {
        loadLocalFile(file);
      } else {
        const reader = new FileReader();
        reader.onload = function(evt) {
          callApi('load_image_data', evt.target.result, file.name).then(handleLoadResult);
        };
        reader.onerror = function() {
          showToast('toastReadError', '', 'error');
        };
        reader.readAsDataURL(file);
      }
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      currentFilename = file.name;  // Set BEFORE async call
      aiMaskLoading = false;
      if (useClientSide) {
        loadLocalFile(file);
      } else {
        const reader = new FileReader();
        reader.onload = function(evt) {
          callApi('load_image_data', evt.target.result, file.name).then(handleLoadResult);
        };
        reader.readAsDataURL(file);
      }
    }
  });

  function handleLoadResult(res) {
    if (!res || !res.ok) {
      toast(res ? res.error : 'Failed to load image', 'error');
      return;
    }
    imageLoaded = true;
    resultReady = false;
    if (res.filename) {
      currentFilename = res.filename;
      // Clear cached mask for new image
    }

    previewImage.src = res.preview;
    resultImage.src = '';
    resultImage.classList.add('hidden');
    comparisonSlider.classList.add('hidden');
    comparisonLabels.classList.add('hidden');

    uploadZone.classList.add('hidden');
    previewContainer.classList.remove('hidden');

    btnProcess.disabled = false;
    btnSave.classList.add('hidden');
    if (btnExportLUT) btnExportLUT.classList.add('hidden');
    
    // Show/hide RAW develop section based on whether image is RAW
    const isRaw = res.is_raw || /\.(cr2|cr3|nef|arw|dng|orf|rw2|raf|pef|srw)$/i.test(res.filename);
    const rawSec = $('#sec_raw_develop');
    if (rawSec) {
      if (isRaw) {
        rawSec.classList.remove('hidden');
        enableSection('rawdevelop');
      } else {
        rawSec.classList.add('hidden');
        disableSection('rawdevelop');
      }
    }
    
    setStatus('ready', `${res.filename} — ${res.width}×${res.height}`);
    showToast('toastLoaded', res.filename, 'success');

    // Reset crop state on new image
    cropRect = { x: 10, y: 10, w: 80, h: 80 };
    updateCropBoxUI();

    // Reset zoom
    currentZoom = 1.0;
    zoomX = 0;
    zoomY = 0;
    updateZoomTransform();

    // Push initial state
    undoStack = [getFullState()];
    redoStack = [];
    updateUndoRedoButtons();

    // Live Histogram update

    // Portrait Bokeh state update
    aiMaskLoading = false;
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
    if (btnExportLUT) btnExportLUT.classList.add('hidden');
    setStatus('ready');
  });

  // ───────────────── Style Transfer (v5.1) Reference Image ─────────────────
  let currentStyleStats = null;
  let currentSourceStats = null;
  const btnLoadStyleRef = $('#btn_load_style_ref');
  const styleRefInput = $('#style_ref_input');
  const styleRefPreview = $('#style_ref_preview');

  if (btnLoadStyleRef && styleRefInput) {
    btnLoadStyleRef.addEventListener('click', (e) => {
      e.preventDefault();
      styleRefInput.click();
    });

    styleRefInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function(evt) {
        const base64Data = evt.target.result;
        styleRefPreview.src = base64Data;
        styleRefPreview.style.display = 'block';

        // Load into temp image to analyze on the client side
        const img = new Image();
        img.onload = function() {
          analyzeStyleReferenceClient(img);
          
          const applyAutoSliders = () => {
            if ($('#style_transfer_mode')?.value === 'sliders') {
              applyStyleToSliders();
            }
          };

          // If backend is active, also let the backend analyze for Reinhard pixel mode
          if (window.pywebview && window.pywebview.api) {
            callApi('analyze_style_reference', base64Data).then(res => {
              if (res && res.ok) {
                // Merge/keep the backend stats for L/A/B transfer
                currentStyleStats = { ...currentStyleStats, ...res.stats };
              }
              applyAutoSliders();
            });
          } else {
            applyAutoSliders();
          }
        };
        img.src = base64Data;
      };
      reader.readAsDataURL(file);
    });

    const styleTransferModeSelect = $('#style_transfer_mode');
    if (styleTransferModeSelect) {
      styleTransferModeSelect.addEventListener('change', () => {
        updateStyleTransferUI();
        if (styleTransferModeSelect.value === 'sliders') {
          applyStyleToSliders();
        }
      });
      styleTransferModeSelect.addEventListener('input', updateStyleTransferUI);
    }
  }

  function updateStyleTransferUI() {
    const modeSelect = $('#style_transfer_mode');
    if (!modeSelect) return;
    const mode = modeSelect.value || 'pixel';
    const intensityGroup = $('#group_style_transfer_intensity');
    if (intensityGroup) {
      intensityGroup.style.display = (mode === 'pixel') ? 'block' : 'none';
    }
  }

  function analyzeStyleReferenceClient(img) {
    try {
      const w = 128;
      const h = 128;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);
      const pixels = imgData.data;

      // Helper RGB to LAB
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

      let sumL = 0, sumA = 0, sumB = 0, sumSat = 0;
      let count = w * h;
      let lValues = new Float32Array(count);
      let aValues = new Float32Array(count);
      let bValues = new Float32Array(count);
      
      // We will also measure corner brightness vs center brightness for vignette
      let centerSumL = 0, centerCount = 0;
      let cornerSumL = 0, cornerCount = 0;
      
      // We will measure high-frequency details (grain estimate)
      let diffSum = 0, diffCount = 0;

      for (let yCoord = 0; yCoord < h; yCoord++) {
        for (let xCoord = 0; xCoord < w; xCoord++) {
          const idx = (yCoord * w + xCoord) * 4;
          const rVal = pixels[idx] / 255.0;
          const gVal = pixels[idx+1] / 255.0;
          const bVal = pixels[idx+2] / 255.0;

          const lab = rgb2lab(rVal, gVal, bVal);
          const L = lab[0];
          const A = lab[1];
          const B = lab[2];
          
          const pixelIndex = yCoord * w + xCoord;
          lValues[pixelIndex] = L;
          aValues[pixelIndex] = A;
          bValues[pixelIndex] = B;

          sumL += L;
          sumA += A;
          sumB += B;

          // Saturation
          const maxVal = Math.max(rVal, gVal, bVal);
          const minVal = Math.min(rVal, gVal, bVal);
          const sat = maxVal > 1e-5 ? (maxVal - minVal) / maxVal : 0;
          sumSat += sat;

          // Vignette calculations: corners vs center
          // Center: within radius 25% of w/h
          const distToCenter = Math.sqrt((xCoord - w/2)**2 + (yCoord - h/2)**2);
          if (distToCenter < w * 0.25) {
            centerSumL += L;
            centerCount++;
          } else if (distToCenter > w * 0.55) {
            // Corners: outside 55% radius
            cornerSumL += L;
            cornerCount++;
          }

          // High frequency detail (grain estimate): local difference to right and down neighbors
          if (xCoord < w - 1 && yCoord < h - 1) {
            const rRight = pixels[idx + 4] / 255.0;
            // Only measure in low contrast areas to avoid edges biasing the grain estimate
            const maxValRight = Math.max(rVal, rRight);
            const minValRight = Math.min(rVal, rRight);
            if (maxValRight - minValRight < 0.12) {
              diffSum += Math.abs(rVal - rRight);
              diffCount++;
            }
          }
        }
      }

      const meanL = sumL / count;
      const meanA = sumA / count;
      const meanB = sumB / count;
      const meanSat = sumSat / count;

      // Variance & StdDev for L, A, B
      let varL = 0, varA = 0, varB = 0;
      for (let i = 0; i < count; i++) {
        varL += (lValues[i] - meanL) ** 2;
        varA += (aValues[i] - meanA) ** 2;
        varB += (bValues[i] - meanB) ** 2;
      }
      const stdL = Math.max(Math.sqrt(varL / count), 1e-4);
      const stdA = Math.max(Math.sqrt(varA / count), 1e-4);
      const stdB = Math.max(Math.sqrt(varB / count), 1e-4);

      // Percentiles L_p10 and L_p90
      lValues.sort();
      const lp10 = lValues[Math.floor(count * 0.10)];
      const lp90 = lValues[Math.floor(count * 0.90)];

      // Vignette depth ratio
      let vignetteRatio = 1.0;
      if (centerCount > 0 && cornerCount > 0 && centerSumL > 0) {
        vignetteRatio = (cornerSumL / cornerCount) / (centerSumL / centerCount);
      }

      // Grain estimate
      const grainVal = diffCount > 0 ? (diffSum / diffCount) : 0;

      // Convert standard LAB to OpenCV LAB range [0, 255] for consistency with backend/pipeline
      const l_mean_cv = meanL * (255.0 / 100.0);
      const l_std_cv = stdL * (255.0 / 100.0);
      const a_mean_cv = meanA + 128.0;
      const a_std_cv = stdA;
      const b_mean_cv = meanB + 128.0;
      const b_std_cv = stdB;

      // Pack stats matching expected LAB keys, plus new extensions
      currentStyleStats = {
        l_mean: l_mean_cv,
        l_std: l_std_cv,
        a_mean: a_mean_cv,
        a_std: a_std_cv,
        b_mean: b_mean_cv,
        b_std: b_std_cv,
        l_p10: lp10,
        l_p90: lp90,
        sat_mean: meanSat,
        vignette_ratio: vignetteRatio,
        grain_val: grainVal
      };

      // Toast notification for user
      const mode = $('#style_transfer_mode')?.value || 'pixel';
      if (mode === 'pixel') {
        showToast('Style reference loaded for Pixel Match!', '', 'success');
      }
    } catch (err) {
      console.error('Error analyzing style reference:', err);
    }
  }

  function computeSourceLABStats(img) {
    try {
      const w = 64;
      const h = 64;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);
      const pixels = imgData.data;

      // Helper RGB to LAB
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

      let sumL = 0, sumA = 0, sumB = 0;
      let count = w * h;
      let lValues = new Float32Array(count);
      let aValues = new Float32Array(count);
      let bValues = new Float32Array(count);

      for (let i = 0; i < count; i++) {
        const idx = i * 4;
        const rVal = pixels[idx] / 255.0;
        const gVal = pixels[idx+1] / 255.0;
        const bVal = pixels[idx+2] / 255.0;

        const lab = rgb2lab(rVal, gVal, bVal);
        lValues[i] = lab[0];
        aValues[i] = lab[1];
        bValues[i] = lab[2];

        sumL += lab[0];
        sumA += lab[1];
        sumB += lab[2];
      }

      const meanL = sumL / count;
      const meanA = sumA / count;
      const meanB = sumB / count;

      let varL = 0, varA = 0, varB = 0;
      for (let i = 0; i < count; i++) {
        varL += (lValues[i] - meanL) ** 2;
        varA += (aValues[i] - meanA) ** 2;
        varB += (bValues[i] - meanB) ** 2;
      }
      const stdL = Math.max(Math.sqrt(varL / count), 1e-4);
      const stdA = Math.max(Math.sqrt(varA / count), 1e-4);
      const stdB = Math.max(Math.sqrt(varB / count), 1e-4);

      currentSourceStats = {
        l_mean: meanL * (255.0 / 100.0),
        l_std: stdL * (255.0 / 100.0),
        a_mean: meanA + 128.0,
        a_std: stdA,
        b_mean: meanB + 128.0,
        b_std: stdB
      };
    } catch (err) {
      console.error('Error computing source LAB stats:', err);
    }
  }

  function applyStyleToSliders() {
    if (!currentStyleStats) {
      showToast('No style reference loaded', '', 'error');
      return;
    }

    const stats = currentStyleStats;

    // Convert OpenCV range back to Standard LAB for slider analysis
    const l_mean_std = stats.l_mean * (100.0 / 255.0);
    const l_std_std = stats.l_std * (100.0 / 255.0);
    const b_mean_std = stats.b_mean - 128.0;

    // 1. Brightness
    // L_mean is usually around 50 for a neutral image. Range 0 to 100.
    // Map to brightness: 1.0 is default. range: 0.7 to 1.4.
    let brightness = 1.0 + (l_mean_std - 50.0) / 100.0;
    brightness = Math.max(0.7, Math.min(1.4, brightness));

    // 2. Contrast
    // L_std is standard deviation. Normal is around 18.
    // Map to contrast: 1.0 is default. range: 0.7 to 1.3.
    let contrast = 1.0 + (l_std_std - 18.0) / 45.0;
    contrast = Math.max(0.7, Math.min(1.3, contrast));

    // 3. Shadows
    // lp10 represents shadows. Normal black point is around 12.
    // Map to shadows slider: 0.0 is default. range: -0.5 to 0.5.
    let shadows = (stats.l_p10 - 12.0) / 30.0;
    shadows = Math.max(-0.5, Math.min(0.5, shadows));

    // 4. Highlights
    // lp90 represents highlights. Normal highlight point is around 85.
    // Map to highlights slider: 0.0 is default. range: -0.5 to 0.5.
    let highlights = (90.0 - stats.l_p90) / 30.0;
    highlights = Math.max(-0.5, Math.min(0.5, highlights));

    // 5. Warmth
    // b_mean represents yellow-blue axis. Warm is positive yellow, cool is negative blue.
    // Map to warmth slider: 0.0 is default. range: -0.5 to 0.5.
    let warmth = b_mean_std / 18.0;
    warmth = Math.max(-0.5, Math.min(0.5, warmth));

    // 6. Saturation & Vibrance
    // sat_mean is average saturation. Normal is around 0.22.
    // Map to saturation: 0.0 is default. range: -0.4 to 0.4.
    // Map to vibrance: 0.0 is default. range: -0.3 to 0.3.
    let saturation = (stats.sat_mean - 0.22) * 1.5;
    saturation = Math.max(-0.4, Math.min(0.4, saturation));

    let vibrance = (stats.sat_mean - 0.22) * 1.0;
    vibrance = Math.max(-0.3, Math.min(0.3, vibrance));

    // 7. Vignette
    // vignette_ratio < 0.88 means corners are dark.
    // Map to Vignette Outer Brightness: 0.0 is default. range: -0.5 to 0.0.
    let outerBrightness = 0.0;
    let vignetteEnabled = false;
    if (stats.vignette_ratio < 0.88) {
      vignetteEnabled = true;
      outerBrightness = (stats.vignette_ratio - 0.95);
      outerBrightness = Math.max(-0.5, Math.min(0.0, outerBrightness));
    }

    // 8. Grain
    // grain_val represents high frequency changes. Normal clean image is around 0.015.
    // Map to grain_strength: 0.0 is default. range: 0.0 to 0.8.
    let grainStrength = 0.0;
    let grainSize = 1;
    let grainEnabled = false;
    if (stats.grain_val > 0.022) {
      grainEnabled = true;
      grainStrength = (stats.grain_val - 0.020) * 10.0;
      grainStrength = Math.max(0.1, Math.min(0.7, grainStrength));
      grainSize = stats.grain_val > 0.035 ? 2 : 1;
    }

    // Apply values to DOM sliders and trigger input events to update label text bubbles
    function setSliderValue(id, val) {
      const slider = $('#' + id);
      if (slider) {
        slider.value = val;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // Enable corresponding sections
    enableSection('toneadjust');
    enableSection('saturation');
    if (vignetteEnabled) {
      enableSection('vignette');
    } else {
      disableSection('vignette');
    }
    if (grainEnabled) {
      enableSection('grain');
    } else {
      disableSection('grain');
    }

    // Set Slider Values
    setSliderValue('brightness', brightness.toFixed(2));
    setSliderValue('contrast', contrast.toFixed(2));
    setSliderValue('shadows', shadows.toFixed(2));
    setSliderValue('highlights', highlights.toFixed(2));
    setSliderValue('warmth', warmth.toFixed(2));
    setSliderValue('light_balance', '0.00'); // default
    
    setSliderValue('saturation', saturation.toFixed(2));
    setSliderValue('vibrance', vibrance.toFixed(2));

    if (vignetteEnabled) {
      setSliderValue('outer_brightness', outerBrightness.toFixed(2));
      setSliderValue('inner_brightness', '0.00');
    } else {
      setSliderValue('outer_brightness', '0.00');
      setSliderValue('inner_brightness', '0.00');
    }

    if (grainEnabled) {
      setSliderValue('grain_strength', grainStrength.toFixed(2));
      setSliderValue('grain_size', grainSize);
    } else {
      setSliderValue('grain_strength', '0.00');
      setSliderValue('grain_size', '1');
    }

    // Save history
    pushState();
    
    showToast('Style parameters applied to sliders!', '', 'success');
  }

  // ───────────────── Section Toggle (collapse) ─────────────────
  $$('.section-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      // Don't collapse if clicking the ON/OFF toggle button
      if (e.target.closest('.section-toggle')) return;
      const section = header.closest('.section');
      const isCollapsed = section.classList.contains('collapsed');
      section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
    });
  });

  // ───────────────── Section Enable / Disable ─────────────────
  // Track which sections are enabled (all OFF by default)
  const sectionEnabled = {};

  function enableSection(sectionName) {
    sectionEnabled[sectionName] = true;
    const btn = $$(`.section-toggle[data-toggle-section="${sectionName}"]`)[0];
    if (btn) {
      btn.classList.add('on');
      btn.textContent = 'ON';
      const section = btn.closest('.section');
      if (section) {
        section.classList.remove('sec-disabled');
      }
    }
  }

  function disableSection(sectionName) {
    sectionEnabled[sectionName] = false;
    const btn = $$(`.section-toggle[data-toggle-section="${sectionName}"]`)[0];
    if (btn) {
      btn.classList.remove('on');
      btn.textContent = 'OFF';
      const section = btn.closest('.section');
      if (section) {
        section.classList.add('sec-disabled');
      }
    }
  }

  $$('.section-toggle').forEach((btn) => {
    const sectionName = btn.dataset.toggleSection;
    sectionEnabled[sectionName] = false; // OFF by default
    
    // Set initial UI state to OFF
    btn.classList.remove('on');
    btn.textContent = 'OFF';
    const section = btn.closest('.section');
    if (section) {
      section.classList.add('sec-disabled');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent header collapse
      const isOn = sectionEnabled[sectionName];
      if (isOn) {
        disableSection(sectionName);
      } else {
        enableSection(sectionName);
      }
      
      pushState();
    });
  });

  function isSectionEnabled(name) {
    return sectionEnabled[name] !== false;
  }

  // ───────────────── Slider Value Labels ─────────────────
  $$('input[type="range"].slider').forEach((slider) => {
    const valEl = $(`#val_${slider.id}`);
    if (valEl) {
      slider.addEventListener('input', () => {
        const step = parseFloat(slider.step) || 1;
        const decimals = step < 1 ? Math.max(String(step).split('.')[1]?.length || 0, 2) : 0;
        valEl.textContent = parseFloat(slider.value).toFixed(decimals);
        if (webglActive && imageLoaded) {
          requestWebGLRender();
        }
      });
    }
  });

  // ───────────────── Reset Buttons ─────────────────
  const sectionDefaults = {
    noise: ['noise_level', 'blue_bias'],
    grain: ['grain_strength', 'grain_size', 'grain_luminosity_mask'],
    lenswarp: ['distortion', 'chromatic_aberration', 'edge_softness', 'aberration_radial'],
    stylefx: ['mode', 'strength', 'radius', 'threshold', 'seed'],
    vignette: ['outer_brightness', 'inner_brightness'],
    toneadjust: ['brightness', 'contrast', 'light_balance', 'highlights', 'shadows', 'warmth'],
    splittoning: ['split_shadow_color', 'split_highlight_color', 'split_balance'],
    gradientmap: ['gradient_preset', 'gradient_intensity'],
    metadata: ['preset', 'artist', 'focal_length_mm', 'fnumber', 'exposure_1_over_s', 'iso', 'quality', 'export_format'],
    dimensions: ['crop_enabled', 'crop_aspect_ratio', 'resize_scale', 'resize_width', 'resize_height'],
    colorlooks: ['lut_look', 'lut_intensity'],
    whitebalance: ['whitebalance_mode', 'color_temp', 'color_tint'],
    sharpness: ['sharpness_amount', 'sharpness_radius', 'sharpness_threshold'],
    saturation: ['saturation', 'vibrance'],
    styletransfer: ['style_transfer_mode', 'style_transfer_intensity']
  };

  $$('.reset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sectionName = btn.dataset.reset;
      const ids = sectionDefaults[sectionName] || [];
      ids.forEach((id) => {
        const el = $(`#${id}`);
        if (!el) return;
        if (el.type === 'checkbox') {
          el.checked = false;
        } else {
          const def = el.dataset.default || '';
          el.value = def;
        }
        // Trigger input event to update value labels
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });

      if (sectionName === 'dimensions') {
        cropRect = { x: 10, y: 10, w: 80, h: 80 };
        updateCropBoxUI();
      }

      if (sectionName === 'styletransfer') {
        updateStyleTransferUI();
      }

      showToast('toastReset', sectionName, 'info');
      pushState();
    });
  });

  // ───────────────── Process Photo ─────────────────
  btnProcess.addEventListener('click', async () => {
    if (!imageLoaded || isProcessing) return;
    if (!useClientSide && !apiReady) return;

    isProcessing = true;
    btnProcess.disabled = true;
    loadingOverlay.classList.remove('hidden');
    setStatus('processing');

    const params = collectParams();

    if (useClientSide) {
      try {
        const maxSide = 1600;
        const w = originalImage.width;
        const h = originalImage.height;
        let scaleCanvas = document.createElement('canvas');
        if (Math.max(w, h) > maxSide) {
          const ratio = maxSide / Math.max(w, h);
          scaleCanvas.width = Math.round(w * ratio);
          scaleCanvas.height = Math.round(h * ratio);
        } else {
          scaleCanvas.width = w;
          scaleCanvas.height = h;
        }
        const sctx = scaleCanvas.getContext('2d');
        sctx.drawImage(originalImage, 0, 0, scaleCanvas.width, scaleCanvas.height);

        // Process client-side!
        const resultCanvas = await OneArtProcessor.processImage(scaleCanvas, params);
        
        resultReady = true;
        resultImage.src = resultCanvas.toDataURL('image/jpeg', 0.92);
        resultImage.classList.remove('hidden');
        comparisonSlider.classList.remove('hidden');
        comparisonLabels.classList.remove('hidden');
        btnSave.classList.remove('hidden');
        if (btnExportLUT) btnExportLUT.classList.remove('hidden');

        setComparePosition(50);
        setStatus('ready', `Done — ${resultCanvas.width}×${resultCanvas.height}`);
        showToast('toastProcComplete', '', 'success');
      } catch (err) {
        toast('Processing error: ' + err.message, 'error');
        setStatus('error');
      } finally {
        isProcessing = false;
        btnProcess.disabled = !imageLoaded;
        loadingOverlay.classList.add('hidden');
      }
    } else {
      try {
        const res = await callApi('process_image', JSON.stringify(params));
        if (!res || !res.ok) {
          toast(res ? res.error : 'Processing failed', 'error');
          setStatus('error');
          return;
        }

        resultReady = true;
        resultImage.src = res.preview;
        resultImage.classList.remove('hidden');
        comparisonSlider.classList.remove('hidden');
        comparisonLabels.classList.remove('hidden');
        btnSave.classList.remove('hidden');
        if (btnExportLUT) btnExportLUT.classList.remove('hidden');

        // Reset compare position
        setComparePosition(50);

        setStatus('ready', `Done — ${res.width}×${res.height}`);
        showToast('toastProcComplete', '', 'success');
      } catch (err) {
        toast('Processing error: ' + err.message, 'error');
        setStatus('error');
      } finally {
        isProcessing = false;
        btnProcess.disabled = !imageLoaded;
        loadingOverlay.classList.add('hidden');
      }
    }
  });

  // ───────────────── Save ─────────────────
  btnSave.addEventListener('click', async () => {
    if (!resultReady) return;
    if (!useClientSide && !apiReady) return;

    setStatus('processing');
    loadingOverlay.classList.remove('hidden');

    const metadataParams = collectMetadataParams();

    if (useClientSide) {
      try {
        const params = collectParams();
        // Process original image at full resolution
        const finalCanvas = await OneArtProcessor.processImage(originalImage, params);
        
        const timestamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
        const nameParts = currentFilename.split('.');
        const ext = nameParts.pop();
        const baseName = nameParts.join('.');
        
        const formatExts = { JPEG: 'jpg', PNG: 'png', TIFF: 'tif', WebP: 'webp' };
        const mimeTypes = { JPEG: 'image/jpeg', PNG: 'image/png', TIFF: 'image/tiff', WebP: 'image/webp' };
        const targetExt = formatExts[metadataParams.export_format] || 'jpg';
        const targetMime = mimeTypes[metadataParams.export_format] || 'image/jpeg';
        const outName = `oneart_${baseName}_${timestamp}.${targetExt}`;

        const quality = (parseInt(metadataParams.quality) || 95) / 100;
        
        finalCanvas.toBlob((blob) => {
          if (!blob) {
            toast('Save failed', 'error');
            setStatus('error');
            loadingOverlay.classList.add('hidden');
            return;
          }
          
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = outName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          
          showToast('toastSaved', outName, 'success');
          setStatus('saved', outName);
          loadingOverlay.classList.add('hidden');
        }, targetMime, quality);

      } catch (err) {
        toast('Save error: ' + err.message, 'error');
        setStatus('error');
        loadingOverlay.classList.add('hidden');
      }
    } else {
      try {
        const res = await callApi('save_image', JSON.stringify(metadataParams));
        if (!res || !res.ok) {
          toast(res ? res.error : 'Save failed', 'error');
          setStatus('error');
          return;
        }
        showToast('toastSaved', res.filename, 'success');
        setStatus('saved', res.filename);
      } catch (err) {
        toast('Save error: ' + err.message, 'error');
        setStatus('error');
      } finally {
        loadingOverlay.classList.add('hidden');
      }
    }
  });

  // ───────────────── Comparison Slider ─────────────────
  let isDragging = false;

  function handleStartDrag(e) {
    isDragging = true;
    if (e.cancelable) e.preventDefault();
  }

  function handleMoveDrag(e) {
    if (!isDragging) return;
    const wrapper = previewContainer.querySelector('.comparison-wrapper');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(2, Math.min(98, pct));
    setComparePosition(pct);
  }

  function handleEndDrag() {
    isDragging = false;
  }

  comparisonSlider.addEventListener('mousedown', handleStartDrag);
  comparisonSlider.addEventListener('touchstart', handleStartDrag, { passive: false });

  document.addEventListener('mousemove', handleMoveDrag);
  document.addEventListener('touchmove', handleMoveDrag, { passive: false });

  document.addEventListener('mouseup', handleEndDrag);
  document.addEventListener('touchend', handleEndDrag);

  function setComparePosition(pct) {
    comparePosition = pct;
    comparisonSlider.style.left = pct + '%';
    resultImage.style.clipPath = `inset(0 0 0 ${pct}%)`;
    if (webglActive) {
      webglPreviewCanvas.style.clipPath = `inset(0 0 0 ${pct}%)`;
    }
  }

  function showResultImage(show) {
    if (webglActive) {
      webglPreviewCanvas.classList.toggle('hidden', !show);
      resultImage.classList.add('hidden');
    } else {
      resultImage.classList.toggle('hidden', !show);
      webglPreviewCanvas.classList.add('hidden');
    }
  }

  // ───────────────── Helpers ─────────────────

  // Prevent dragover default actions
  window.addEventListener("dragover", function(e) {
    e.preventDefault();
  }, false);
  window.addEventListener("drop", function(e) {
    e.preventDefault();
  }, false);

  function collectParams() {
    const noiseOn        = isSectionEnabled('noise');
    const grainOn        = isSectionEnabled('grain');
    const lenswarpOn     = isSectionEnabled('lenswarp');
    const stylefxOn      = isSectionEnabled('stylefx');
    const vignetteOn     = isSectionEnabled('vignette');
    const toneOn         = isSectionEnabled('toneadjust');
    const lutOn          = isSectionEnabled('colorlooks');
    const styleTransferOn= isSectionEnabled('styletransfer');
    const wbOn           = isSectionEnabled('whitebalance');
    const sharpOn        = isSectionEnabled('sharpness');
    const satOn          = isSectionEnabled('saturation');
    const curvesOn       = isSectionEnabled('curves');
    const rawdevelopOn   = isSectionEnabled('rawdevelop');
    const splitOn        = isSectionEnabled('splittoning');
    const gradOn         = isSectionEnabled('gradientmap');


    return {
      // Portrait Bokeh

      // Noise
      noise_level: noiseOn ? getVal('noise_level') : 0,
      blue_bias:   noiseOn ? getVal('blue_bias') : 1.0,
      // Grain
      grain_strength: grainOn ? getVal('grain_strength') : 0,
      grain_size:     grainOn ? getVal('grain_size') : 1,
      grain_luminosity_mask: grainOn ? $('#grain_luminosity_mask').checked : false,
      // Lens Warp
      distortion:            lenswarpOn ? getVal('distortion') : 0,
      chromatic_aberration:  lenswarpOn ? getVal('chromatic_aberration') : 0,
      edge_softness:         lenswarpOn ? getVal('edge_softness') : 0,
      aberration_radial:     lenswarpOn ? $('#aberration_radial').checked : false,
      // Style FX
      mode:      stylefxOn ? $(`#mode`).value : 'Bloom',
      strength:  stylefxOn ? getVal('strength') : 0,
      radius:    stylefxOn ? getVal('radius') : 0,
      threshold: stylefxOn ? getVal('threshold') : 1,
      seed:      stylefxOn ? getVal('seed') : 0,
      // Vignette
      outer_brightness: vignetteOn ? getVal('outer_brightness') : 0,
      inner_brightness: vignetteOn ? getVal('inner_brightness') : 0,
      // Tone Adjust
      brightness:    toneOn ? getVal('brightness') : 1,
      contrast:      toneOn ? getVal('contrast') : 1,
      light_balance: toneOn ? getVal('light_balance') : 0,
      highlights:    toneOn ? getVal('highlights') : 0,
      shadows:       toneOn ? getVal('shadows') : 0,
      warmth:        toneOn ? getVal('warmth') : 0,
      // Split Toning
      split_toning_enabled:  splitOn,
      split_shadow_color:    splitOn ? $(`#split_shadow_color`).value : '#102040',
      split_highlight_color: splitOn ? $(`#split_highlight_color`).value : '#ffaa20',
      split_balance:         splitOn ? getVal('split_balance') : 0.0,
      // Gradient Map
      gradient_map_enabled:  gradOn,
      gradient_preset:       gradOn ? $(`#gradient_preset`).value : 'Sunset',
      gradient_intensity:    gradOn ? getVal('gradient_intensity') : 1.0,
      // LUT Look
      lut_look:      lutOn ? $(`#lut_look`).value : 'None',
      lut_intensity: lutOn ? getVal('lut_intensity') : 0,
      // White Balance (Color Temperature)
      whitebalance_enabled: wbOn,
      whitebalance_mode: wbOn ? $('#whitebalance_mode').value : 'manual',
      color_temp: wbOn ? getVal('color_temp') : 6500,
      color_tint: wbOn ? getVal('color_tint') : 0,
      // Sharpness
      sharpness_enabled:   sharpOn,
      sharpness_amount:    sharpOn ? getVal('sharpness_amount') : 0,
      sharpness_radius:    sharpOn ? getVal('sharpness_radius') : 1.0,
      sharpness_threshold: sharpOn ? getVal('sharpness_threshold') : 3,
      // Saturation + Vibrance
      saturation_enabled: satOn,
      saturation: satOn ? getVal('saturation') : 0,
      vibrance:   satOn ? getVal('vibrance') : 0,
      // Crop
      crop_enabled: $('#crop_enabled').checked,
      crop_x: cropRect.x,
      crop_y: cropRect.y,
      crop_w: cropRect.w,
      crop_h: cropRect.h,
      resize_scale:  getVal('resize_scale'),
      resize_width:  $(`#resize_width`).value,
      resize_height: $(`#resize_height`).value,
      // Style Transfer (v5.1)
      style_transfer_enabled: styleTransferOn && (currentStyleStats !== null) && ($('#style_transfer_mode').value === 'pixel' || $('#style_transfer_mode').value === 'covariance'),
      style_transfer_mode: $('#style_transfer_mode').value,
      style_transfer_intensity: getVal('style_transfer_intensity'),
      style_transfer_stats: currentStyleStats,
      source_stats: currentSourceStats,
      // Creative FX (v4.0) — all off when section disabled
      // Curves (v6.0)
      curves_enabled:        curvesOn,
      curves: {
        rgb: Array.from(computeSpline(curvePoints.rgb)),
        red: Array.from(computeSpline(curvePoints.red)),
        green: Array.from(computeSpline(curvePoints.green)),
        blue: Array.from(computeSpline(curvePoints.blue))
      },
      // RAW Develop
      raw_develop_enabled:   rawdevelopOn,
      raw_demosaic:          rawdevelopOn ? $('#raw_demosaic').value : 'AHD',
      raw_exposure:          rawdevelopOn ? getVal('raw_exposure') : 0.0,
      raw_highlight_mode:    rawdevelopOn ? $('#raw_highlight_mode').value : 'blend'
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
      export_format: $(`#export_format`).value
    };
  }

  function getVal(id) {
    const el = $(`#${id}`);
    if (!el) return 0;
    return parseFloat(el.value) || 0;
  }

  async function callApi(method, ...args) {
    if (wsReady) {
      return new Promise((resolve, reject) => {
        wsRequestId++;
        const id = wsRequestId;
        pendingWsRequests.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, args }));
      });
    }
    if (window.pywebview && window.pywebview.api && window.pywebview.api[method]) {
      return window.pywebview.api[method](...args);
    }
    showToast('toastConnected', '', 'error');
    return null;
  }

  function initWebSocket() {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host || 'localhost:8000';
    const wsUrl = `${wsProto}//${wsHost}/ws`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[WS] Connected to FastAPI backend");
      wsReady = true;
      apiReady = true;
      showToast('toastConnected', 'FastAPI Backend', 'success');
      if (pywebviewNotice) pywebviewNotice.classList.add('hidden');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "progress") {
          if (window.onBatchItemProgress) {
            window.onBatchItemProgress(msg.filepath, msg.success, msg.result);
          }
        } else if (msg.id !== undefined) {
          const req = pendingWsRequests.get(msg.id);
          if (req) {
            pendingWsRequests.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(msg.error));
            } else {
              req.resolve(msg.result);
            }
          }
        }
      } catch (err) {
        console.error("[WS] Error parsing message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[WS] Disconnected, retrying in 3s...");
      wsReady = false;
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error("[WS] Socket error:", err);
    };
  }

  let renderRequestPending = false;
  function requestWebGLRender() {
    if (!webglActive || !imageLoaded) return;
    if (renderRequestPending) return;
    renderRequestPending = true;
    requestAnimationFrame(() => {
      renderWebGLPreview();
      renderRequestPending = false;
    });
  }

  function renderWebGLPreview() {
    if (!imageLoaded || !webglActive) return;
    const params = collectParams();
    const displayW = previewImage.naturalWidth || previewImage.width;
    const displayH = previewImage.naturalHeight || previewImage.height;
    
    if (webglPreviewCanvas.width !== displayW || webglPreviewCanvas.height !== displayH) {
      webglPreviewCanvas.width = displayW;
      webglPreviewCanvas.height = displayH;
    }
    
    const curves = {
      rgb: computeSpline(curvePoints.rgb),
      red: computeSpline(curvePoints.red),
      green: computeSpline(curvePoints.green),
      blue: computeSpline(curvePoints.blue)
    };
    
    OneArtWebGL.render(params, curves);
    
    resultImage.classList.add('hidden');
    webglPreviewCanvas.classList.remove('hidden');
    
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

  // ───────────────── v3 Logic Implementation ─────────────────

  // A. State / Undo-Redo
  // Natural Cubic Spline Solver for Tone Curves (v6.0)
  function computeSpline(points) {
    const n = points.length;
    const values = new Uint8Array(256);
    
    if (n === 0) {
      for (let i = 0; i < 256; i++) values[i] = i;
      return values;
    }
    if (n === 1) {
      for (let i = 0; i < 256; i++) values[i] = Math.max(0, Math.min(255, Math.round(points[0].y)));
      return values;
    }
    
    const pts = [...points].sort((a, b) => a.x - b.x);
    const x = pts.map(p => p.x);
    const y = pts.map(p => p.y);
    
    const h = [];
    for (let i = 0; i < n - 1; i++) {
      h.push(x[i+1] - x[i]);
    }
    
    const a = [];
    for (let i = 1; i < n - 1; i++) {
      a.push(3 * (y[i+1] - y[i]) / h[i] - 3 * (y[i] - y[i-1]) / h[i-1]);
    }
    
    const l = Array(n).fill(0);
    const mu = Array(n).fill(0);
    const z = Array(n).fill(0);
    
    l[0] = 1;
    mu[0] = 0;
    z[0] = 0;
    
    for (let i = 1; i < n - 1; i++) {
      l[i] = 2 * (x[i+1] - x[i-1]) - h[i-1] * mu[i-1];
      mu[i] = h[i] / l[i];
      z[i] = (a[i-1] - h[i-1] * z[i-1]) / l[i];
    }
    
    l[n-1] = 1;
    z[n-1] = 0;
    
    const c = Array(n).fill(0);
    const b = Array(n).fill(0);
    const d = Array(n).fill(0);
    
    for (let j = n - 2; j >= 0; j--) {
      c[j] = z[j] - mu[j] * c[j+1];
      b[j] = (y[j+1] - y[j]) / h[j] - h[j] * (c[j+1] + 2 * c[j]) / 3;
      d[j] = (c[j+1] - c[j]) / (3 * h[j]);
    }
    
    for (let i = 0; i < 256; i++) {
      let s = 0;
      while (s < n - 1 && i > x[s+1]) {
        s++;
      }
      const dx = i - x[s];
      let val = y[s] + b[s] * dx + c[s] * dx * dx + d[s] * dx * dx * dx;
      values[i] = Math.max(0, Math.min(255, Math.round(val)));
    }
    
    for (let i = 0; i < x[0]; i++) {
      values[i] = values[x[0]];
    }
    for (let i = x[n-1] + 1; i < 256; i++) {
      values[i] = values[x[n-1]];
    }
    
    return values;
  }

  // Draw curves on canvas
  function drawCurves() {
    const canvas = $('#curvesCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    
    // Clear
    ctx.fillStyle = '#07070b';
    ctx.fillRect(0, 0, w, h);
    
    // Draw Grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    const gridCount = 4;
    for (let i = 1; i < gridCount; i++) {
      const x = (w / gridCount) * i;
      const y = (h / gridCount) * i;
      
      // Vertical line
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      
      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    
    // Draw Diagonal baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Compute spline values
    const activePts = curvePoints[activeCurveChannel];
    const splineVals = computeSpline(activePts);
    
    // Draw Curve
    const colors = {
      rgb: '#f0a030',
      red: '#ff5555',
      green: '#55ff55',
      blue: '#5555ff'
    };
    ctx.strokeStyle = colors[activeCurveChannel] || '#f0a030';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const cx = i * (w / 255);
      const cy = (255 - splineVals[i]) * (h / 255);
      if (i === 0) {
        ctx.moveTo(cx, cy);
      } else {
        ctx.lineTo(cx, cy);
      }
    }
    ctx.stroke();
    
    // Draw Points
    activePts.forEach((pt, index) => {
      const cx = pt.x * (w / 255);
      const cy = (255 - pt.y) * (h / 255);
      
      ctx.beginPath();
      ctx.arc(cx, cy, index === activeCurvePointIndex ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = index === activeCurvePointIndex ? '#fff' : (colors[activeCurveChannel] || '#f0a030');
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  function initCurves() {
    const canvas = $('#curvesCanvas');
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    
    // Channel selection tabs
    $$('.curve-chan-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        $$('.curve-chan-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeCurveChannel = btn.dataset.channel;
        activeCurvePointIndex = -1;
        drawCurves();
      });
    });
    
    // Mouse interactivity
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      
      const xNorm = Math.round(mx * (255 / w));
      const yNorm = Math.round((h - my) * (255 / h));
      
      const activePts = curvePoints[activeCurveChannel];
      
      // Check if clicked near an existing point (radius of 8 pixels)
      let foundIndex = -1;
      for (let i = 0; i < activePts.length; i++) {
        const ptX = activePts[i].x * (w / 255);
        const ptY = (255 - activePts[i].y) * (h / 255);
        const dist = Math.sqrt((mx - ptX)**2 + (my - ptY)**2);
        if (dist < 8) {
          foundIndex = i;
          break;
        }
      }
      
      if (foundIndex !== -1) {
        activeCurvePointIndex = foundIndex;
      } else {
        // Add a new point if we clicked on the line and we have less than 10 points
        if (activePts.length < 10) {
          // Insert point maintaining sorted x
          const newPt = { x: xNorm, y: yNorm };
          activePts.push(newPt);
          activePts.sort((a, b) => a.x - b.x);
          activeCurvePointIndex = activePts.indexOf(newPt);
        }
      }
      
      drawCurves();
      updateCurveValueTexts(xNorm, yNorm);
    });
    
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      
      const xNorm = Math.max(0, Math.min(255, Math.round(mx * (255 / w))));
      const yNorm = Math.max(0, Math.min(255, Math.round((h - my) * (255 / h))));
      
      const activePts = curvePoints[activeCurveChannel];
      
      if (activeCurvePointIndex !== -1) {
        const pt = activePts[activeCurvePointIndex];
        
        // Endpoints can only move vertically (x=0 and x=255 are fixed)
        if (activeCurvePointIndex === 0) {
          pt.y = yNorm;
        } else if (activeCurvePointIndex === activePts.length - 1) {
          pt.y = yNorm;
        } else {
          // Internal points cannot cross their neighbors' x coords
          const minX = activePts[activeCurvePointIndex - 1].x + 1;
          const maxX = activePts[activeCurvePointIndex + 1].x - 1;
          pt.x = Math.max(minX, Math.min(maxX, xNorm));
          pt.y = yNorm;
        }
        
        drawCurves();
        updateCurveValueTexts(pt.x, pt.y);
        if (webglActive && imageLoaded) {
          requestWebGLRender();
        }
      } else {
        // Show current input/output under cursor
        const spline = computeSpline(activePts);
        updateCurveValueTexts(xNorm, spline[xNorm]);
      }
    });
    
    const endDrag = () => {
      if (activeCurvePointIndex !== -1) {
        activeCurvePointIndex = -1;
        drawCurves();
        pushState();
      }
    };
    
    canvas.addEventListener('mouseup', endDrag);
    canvas.addEventListener('mouseleave', endDrag);
    
    // Double click to delete point
    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      
      const activePts = curvePoints[activeCurveChannel];
      
      // Check if near an existing internal point
      let foundIndex = -1;
      for (let i = 1; i < activePts.length - 1; i++) {
        const ptX = activePts[i].x * (w / 255);
        const ptY = (255 - activePts[i].y) * (h / 255);
        const dist = Math.sqrt((mx - ptX)**2 + (my - ptY)**2);
        if (dist < 8) {
          foundIndex = i;
          break;
        }
      }
      
      if (foundIndex !== -1) {
        activePts.splice(foundIndex, 1);
        activeCurvePointIndex = -1;
        drawCurves();
        pushState();
      }
    });
    
    // Reset handler for Curves
    const resetBtn = $$('.reset-btn[data-reset="curves"]')[0];
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        curvePoints = {
          rgb: [{x: 0, y: 0}, {x: 255, y: 255}],
          red: [{x: 0, y: 0}, {x: 255, y: 255}],
          green: [{x: 0, y: 0}, {x: 255, y: 255}],
          blue: [{x: 0, y: 0}, {x: 255, y: 255}]
        };
        activeCurvePointIndex = -1;
        drawCurves();
        showToast('Curves reset to default', '', 'info');
        pushState();
      });
    }
    
    drawCurves();
  }
  
  function updateCurveValueTexts(x, y) {
    const valIn = $('#curve_val_in');
    const valOut = $('#curve_val_out');
    if (valIn && valOut) {
      valIn.textContent = x;
      valOut.textContent = y;
    }
  }

  function getFullState() {
    const state = {};
    $$('.slider, .select-input, .text-input, .number-input, .color-input').forEach(el => {
      if (el.type === 'checkbox') {
        state[el.id] = el.checked;
      } else if (el.id) {
        state[el.id] = el.value;
      }
    });
    state['crop_enabled'] = cropEnabledCheckbox.checked;
    state['sectionEnabled'] = { ...sectionEnabled };
    state['curvePoints'] = JSON.parse(JSON.stringify(curvePoints));
    return JSON.stringify(state);
  }

  function updateWhiteBalanceUI() {
    const mode = $('#whitebalance_mode').value;
    const tempGroup = $('#group_color_temp');
    const tintGroup = $('#group_color_tint');
    const isManual = (mode === 'manual');
    
    if (tempGroup && tintGroup) {
      if (isManual) {
        tempGroup.style.opacity = '1';
        tempGroup.style.pointerEvents = 'auto';
        $('#color_temp').disabled = false;
        
        tintGroup.style.opacity = '1';
        tintGroup.style.pointerEvents = 'auto';
        $('#color_tint').disabled = false;
      } else {
        tempGroup.style.opacity = '0.4';
        tempGroup.style.pointerEvents = 'none';
        $('#color_temp').disabled = true;
        
        tintGroup.style.opacity = '0.4';
        tintGroup.style.pointerEvents = 'none';
      }
    }
  }

  function loadState(stateStr) {
    try {
      const state = JSON.parse(stateStr);
      for (let id in state) {
        if (id === 'sectionEnabled' || id === 'crop_enabled' || id === 'curvePoints') continue;
        const el = $('#' + id);
        if (!el) continue;
        if (el.type === 'checkbox') {
          el.checked = state[id];
        } else {
          el.value = state[id];
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      // Restore section enabled states
      if (state.sectionEnabled) {
        for (let name in state.sectionEnabled) {
          if (state.sectionEnabled[name]) {
            enableSection(name);
          } else {
            disableSection(name);
          }
        }
      }
      
      if (state.curvePoints) {
        curvePoints = JSON.parse(JSON.stringify(state.curvePoints));
        drawCurves();
      }
      
      cropEnabledCheckbox.checked = state['crop_enabled'] || false;
      cropActive = cropEnabledCheckbox.checked;
      updateCropBoxUI();
      updateWhiteBalanceUI();
    } catch (e) {}
  }

  function pushState() {
    const state = getFullState();
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== state) {
      undoStack.push(state);
      redoStack = [];
      // Limit history to 20 states
      if (undoStack.length > 20) undoStack.shift();
      updateUndoRedoButtons();
    }
  }

  function undo() {
    if (undoStack.length > 1) {
      const current = undoStack.pop();
      redoStack.push(current);
      const prev = undoStack[undoStack.length - 1];
      loadState(prev);
      updateUndoRedoButtons();
    }
  }

  function redo() {
    if (redoStack.length > 0) {
      const state = redoStack.pop();
      undoStack.push(state);
      loadState(state);
      updateUndoRedoButtons();
    }
  }

  function updateUndoRedoButtons() {
    const canUndo = undoStack.length > 1;
    const canRedo = redoStack.length > 0;
    btnUndo.disabled = !canUndo;
    btnRedo.disabled = !canRedo;
    // Show count badges
    const undoCountEl = btnUndo.querySelector('.undo-count');
    const redoCountEl = btnRedo.querySelector('.undo-count');
    if (undoCountEl) undoCountEl.textContent = canUndo ? (undoStack.length - 1) : '';
    if (redoCountEl) redoCountEl.textContent = canRedo ? redoStack.length : '';
  }



  // C. Presets System
  // ── 15 Photo-Realistic Styles ─────────────────────────────────────────────
  // Each preset is designed to make AI-generated images look like real photos
  // by combining grain, noise, chromatic aberration, LUT color grades, and
  // realistic lighting conditions.
  const PREDEFINED_PRESETS = {

    // ── 1. Kodak Portra 400 ───────────────────────────────────────────────
    // Warm skin tones, creamy highlights, analog grain — the most beloved film stock
    kodak_portra: {
      lut_look: "Kodak Portra",
      lut_intensity: "0.90",
      noise_level: "0.022",
      grain_strength: "0.38",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.04",
      contrast: "0.94",
      highlights: "-0.12",
      shadows: "0.08",
      warmth: "0.18",
      saturation: "0.10",
      vibrance: "0.15",
      sharpness_amount: "0.35",
      sharpness_radius: "1.2",
      chromatic_aberration: "0.4",
      edge_softness: "0.18",
      outer_brightness: "-0.12",
      mode: "SoftPortrait",
      strength: "0.30"
    },

    // ── 2. Fuji Pro 400H ──────────────────────────────────────────────────
    // Pastel cool tones, lifted shadows, dreamy highlights — wedding & portrait film
    fuji_pro_400h: {
      lut_look: "Fuji Superia",
      lut_intensity: "0.80",
      noise_level: "0.018",
      grain_strength: "0.30",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.06",
      contrast: "0.88",
      highlights: "0.05",
      shadows: "0.15",
      warmth: "-0.08",
      saturation: "-0.08",
      vibrance: "0.12",
      sharpness_amount: "0.25",
      chromatic_aberration: "0.3",
      edge_softness: "0.22",
      outer_brightness: "-0.08",
      mode: "SoftPortrait",
      strength: "0.25"
    },

    // ── 3. Ilford HP5 B&W ─────────────────────────────────────────────────
    // Classic black & white, dramatic tonal range, visible grain, deep shadows
    ilford_hp5: {
      lut_look: "Monochrome Noir",
      lut_intensity: "1.00",
      noise_level: "0.035",
      grain_strength: "0.55",
      grain_size: "3",
      grain_luminosity_mask: false,
      brightness: "0.98",
      contrast: "1.22",
      highlights: "-0.18",
      shadows: "-0.25",
      warmth: "0.00",
      saturation: "-1.00",
      vibrance: "0.00",
      sharpness_amount: "0.50",
      sharpness_radius: "1.5",
      chromatic_aberration: "0.0",
      outer_brightness: "-0.20",
      inner_brightness: "0.05",
      mode: "Matte",
      strength: "0.20"
    },

    // ── 4. Golden Hour ────────────────────────────────────────────────────
    // Warm sunset glow, halation from backlit hair, glowing highlights
    golden_hour: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.70",
      noise_level: "0.015",
      grain_strength: "0.25",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.12",
      contrast: "1.05",
      highlights: "0.08",
      shadows: "0.05",
      warmth: "0.35",
      saturation: "0.15",
      vibrance: "0.20",
      chromatic_aberration: "0.6",
      edge_softness: "0.30",
      outer_brightness: "-0.15",
      mode: "Halation",
      strength: "0.45",
      radius: "35.0",
      threshold: "0.70"
    },

    // ── 5. Overcast Day ───────────────────────────────────────────────────
    // Flat diffuse light, no harsh shadows, muted colors, documentary feel
    overcast_day: {
      lut_look: "None",
      noise_level: "0.020",
      grain_strength: "0.28",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.02",
      contrast: "0.90",
      highlights: "-0.05",
      shadows: "0.12",
      warmth: "-0.05",
      saturation: "-0.12",
      vibrance: "0.08",
      sharpness_amount: "0.30",
      chromatic_aberration: "0.2",
      edge_softness: "0.10",
      outer_brightness: "-0.05",
      mode: "Matte",
      strength: "0.30"
    },

    // ── 6. Street Photography ─────────────────────────────────────────────
    // Pushed ISO grain, punchy contrast, raw unedited look, Tri-X character
    street_photography: {
      lut_look: "Monochrome Noir",
      lut_intensity: "0.45",
      noise_level: "0.048",
      grain_strength: "0.65",
      grain_size: "3",
      grain_luminosity_mask: false,
      brightness: "0.97",
      contrast: "1.28",
      highlights: "-0.22",
      shadows: "-0.20",
      warmth: "-0.04",
      saturation: "-0.20",
      vibrance: "0.05",
      sharpness_amount: "0.60",
      sharpness_radius: "1.0",
      sharpness_threshold: "2",
      chromatic_aberration: "0.5",
      outer_brightness: "-0.25",
      mode: "Matte",
      strength: "0.15"
    },

    // ── 7. Cinema Log (Flat) ──────────────────────────────────────────────
    // S-Log2/3 inspired flat look, lifted blacks, protected highlights
    cinema_log: {
      lut_look: "Teal & Orange",
      lut_intensity: "0.60",
      noise_level: "0.012",
      grain_strength: "0.20",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.00",
      contrast: "0.82",
      highlights: "0.15",
      shadows: "0.20",
      warmth: "0.03",
      saturation: "-0.05",
      vibrance: "0.10",
      sharpness_amount: "0.20",
      chromatic_aberration: "0.3",
      edge_softness: "0.15",
      outer_brightness: "-0.10",
      mode: "CinematicGrade",
      strength: "0.40"
    },

    // ── 8. Sony Venice Skin ───────────────────────────────────────────────
    // Hollywood cinema skin rendering, warm and rich, subtle halation
    sony_venice: {
      lut_look: "Kodak Portra",
      lut_intensity: "0.65",
      noise_level: "0.014",
      grain_strength: "0.22",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.05",
      contrast: "1.08",
      highlights: "-0.08",
      shadows: "0.03",
      warmth: "0.12",
      saturation: "0.08",
      vibrance: "0.18",
      sharpness_amount: "0.28",
      chromatic_aberration: "0.4",
      outer_brightness: "-0.12",
      inner_brightness: "0.03",
      mode: "Halation",
      strength: "0.25",
      radius: "20.0",
      threshold: "0.75"
    },

    // ── 9. Portrait Studio ────────────────────────────────────────────────
    // Clean studio flash, neutral tones, even exposure, professional look
    portrait_studio: {
      lut_look: "None",
      noise_level: "0.010",
      grain_strength: "0.15",
      grain_size: "1",
      grain_luminosity_mask: true,
      brightness: "1.08",
      contrast: "1.05",
      highlights: "-0.05",
      shadows: "0.05",
      warmth: "0.06",
      saturation: "0.05",
      vibrance: "0.10",
      sharpness_amount: "0.45",
      sharpness_radius: "1.2",
      sharpness_threshold: "1",
      chromatic_aberration: "0.2",
      edge_softness: "0.15",
      outer_brightness: "-0.08",
      mode: "SoftPortrait",
      strength: "0.20"
    },

    // ── 10. 90s Disposable Camera ─────────────────────────────────────────
    // Overexposed flash, hard grain, lo-fi color shift, red-eye warmth
    disposable_camera: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.55",
      noise_level: "0.055",
      grain_strength: "0.72",
      grain_size: "4",
      grain_luminosity_mask: false,
      brightness: "1.18",
      contrast: "1.12",
      highlights: "0.25",
      shadows: "0.05",
      warmth: "0.22",
      saturation: "0.18",
      vibrance: "0.12",
      sharpness_amount: "0.15",
      chromatic_aberration: "1.8",
      edge_softness: "0.05",
      outer_brightness: "-0.30",
      mode: "RetroFilm",
      strength: "0.65"
    },

    // ── 11. Polaroid SX-70 ────────────────────────────────────────────────
    // Faded, warm, dreamy with soft edges, lifted blacks and subdued colors
    polaroid_sx70: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.60",
      noise_level: "0.030",
      grain_strength: "0.40",
      grain_size: "3",
      grain_luminosity_mask: true,
      brightness: "1.08",
      contrast: "0.82",
      highlights: "0.10",
      shadows: "0.22",
      warmth: "0.28",
      saturation: "-0.15",
      vibrance: "0.05",
      sharpness_amount: "0.08",
      chromatic_aberration: "0.8",
      edge_softness: "0.35",
      outer_brightness: "-0.35",
      inner_brightness: "0.05",
      mode: "Matte",
      strength: "0.55"
    },

    // ── 12. Moody Indoor Tungsten ─────────────────────────────────────────
    // Warm orange tungsten cast, dark shadows, cozy atmosphere, high ISO noise
    moody_indoor: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.50",
      noise_level: "0.038",
      grain_strength: "0.50",
      grain_size: "3",
      grain_luminosity_mask: true,
      brightness: "0.90",
      contrast: "1.18",
      highlights: "-0.15",
      shadows: "-0.35",
      warmth: "0.40",
      saturation: "0.12",
      vibrance: "0.08",
      chromatic_aberration: "0.5",
      outer_brightness: "-0.40",
      inner_brightness: "0.00",
      mode: "Bloom",
      strength: "0.35",
      radius: "18.0",
      threshold: "0.55"
    },

    // ── 13. Fashion Editorial ─────────────────────────────────────────────
    // Punchy clean look, high contrast, crisp sharpness, neutral to cool tones
    fashion_editorial: {
      lut_look: "Teal & Orange",
      lut_intensity: "0.50",
      noise_level: "0.008",
      grain_strength: "0.10",
      grain_size: "1",
      grain_luminosity_mask: true,
      brightness: "1.05",
      contrast: "1.18",
      highlights: "-0.10",
      shadows: "-0.12",
      warmth: "-0.05",
      saturation: "0.15",
      vibrance: "0.25",
      sharpness_amount: "0.70",
      sharpness_radius: "1.0",
      sharpness_threshold: "1",
      chromatic_aberration: "0.15",
      edge_softness: "0.08",
      outer_brightness: "-0.10",
      mode: "CinematicGrade",
      strength: "0.35"
    },

    // ── 14. Travel Documentary ────────────────────────────────────────────
    // Natural saturated colors, clarity boost, honest exposure, slightly sharp
    travel_documentary: {
      lut_look: "Fuji Superia",
      lut_intensity: "0.55",
      noise_level: "0.018",
      grain_strength: "0.22",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.03",
      contrast: "1.10",
      highlights: "-0.08",
      shadows: "0.05",
      warmth: "0.08",
      saturation: "0.20",
      vibrance: "0.30",
      sharpness_amount: "0.55",
      sharpness_radius: "1.2",
      sharpness_threshold: "2",
      chromatic_aberration: "0.3",
      outer_brightness: "-0.08",
      mode: "Matte",
      strength: "0.10"
    },

    // ── 15. Expired Analog Film ───────────────────────────────────────────
    // Color drift, heavy grain, faded and foggy, lo-fi degraded look
    expired_film: {
      lut_look: "Cyberpunk",
      lut_intensity: "0.25",
      noise_level: "0.060",
      grain_strength: "0.80",
      grain_size: "4",
      grain_luminosity_mask: false,
      brightness: "1.10",
      contrast: "0.80",
      highlights: "0.20",
      shadows: "0.28",
      warmth: "0.32",
      saturation: "-0.25",
      vibrance: "-0.10",
      sharpness_amount: "0.05",
      chromatic_aberration: "2.5",
      edge_softness: "0.40",
      outer_brightness: "-0.20",
      mode: "RetroFilm",
      strength: "0.85"
    },

    // ════════════════════════════════════════════════════════════
    // ── v7.0 STYLES ─────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════

    // ── 🌍 GEOGRAPHIC ────────────────────────────────────────────

    // 16. Tokyo Neon Night — wet asphalt, cyan/magenta neon reflections
    tokyo_neon: {
      lut_look: "Cyberpunk",
      lut_intensity: "0.65",
      noise_level: "0.025",
      grain_strength: "0.30",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "0.85",
      contrast: "1.30",
      highlights: "0.15",
      shadows: "-0.40",
      warmth: "-0.12",
      saturation: "0.30",
      vibrance: "0.25",
      sharpness_amount: "0.55",
      sharpness_radius: "1.0",
      chromatic_aberration: "0.9",
      edge_softness: "0.05",
      outer_brightness: "-0.35",
      mode: "Bloom",
      strength: "0.50",
      radius: "15.0",
      threshold: "0.50"
    },

    // 17. Havana 1960s — faded tropical warmth, bleached reds, nostalgic green shadows
    havana_1960: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.55",
      noise_level: "0.032",
      grain_strength: "0.48",
      grain_size: "3",
      grain_luminosity_mask: true,
      brightness: "1.07",
      contrast: "0.90",
      highlights: "0.12",
      shadows: "0.10",
      warmth: "0.25",
      saturation: "-0.18",
      vibrance: "0.08",
      sharpness_amount: "0.15",
      chromatic_aberration: "0.6",
      edge_softness: "0.28",
      outer_brightness: "-0.18",
      mode: "Matte",
      strength: "0.45"
    },

    // 18. Sahara Desert — scorched ochre, blown highlights, near-monochrome shadows
    sahara_desert: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.80",
      noise_level: "0.018",
      grain_strength: "0.20",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.15",
      contrast: "1.10",
      highlights: "0.25",
      shadows: "-0.18",
      warmth: "0.45",
      saturation: "-0.25",
      vibrance: "-0.05",
      sharpness_amount: "0.40",
      chromatic_aberration: "0.3",
      edge_softness: "0.12",
      outer_brightness: "-0.20",
      mode: "CinematicGrade",
      strength: "0.30"
    },

    // 19. Scandinavian Winter — cold blue, flat diffuse, near-white highlights, minimal contrast
    scandinavia_winter: {
      lut_look: "None",
      noise_level: "0.016",
      grain_strength: "0.18",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.10",
      contrast: "0.82",
      highlights: "0.08",
      shadows: "0.18",
      warmth: "-0.30",
      saturation: "-0.22",
      vibrance: "0.05",
      sharpness_amount: "0.20",
      chromatic_aberration: "0.2",
      edge_softness: "0.08",
      outer_brightness: "-0.05",
      mode: "Matte",
      strength: "0.25"
    },

    // 20. Mumbai Monsoon — lush green, high humidity haze, warm reflective skin
    mumbai_monsoon: {
      lut_look: "Fuji Superia",
      lut_intensity: "0.60",
      noise_level: "0.022",
      grain_strength: "0.28",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "0.98",
      contrast: "0.92",
      highlights: "-0.08",
      shadows: "0.12",
      warmth: "0.10",
      saturation: "0.20",
      vibrance: "0.25",
      sharpness_amount: "0.18",
      chromatic_aberration: "0.4",
      edge_softness: "0.20",
      outer_brightness: "-0.12",
      mode: "SoftPortrait",
      strength: "0.22"
    },

    // ── 🕰 HISTORICAL ERAS ───────────────────────────────────────

    // 21. 1970s Kodachrome — punchy saturated reds, road-trip America
    kodachrome_70s: {
      lut_look: "Kodak Portra",
      lut_intensity: "0.85",
      noise_level: "0.028",
      grain_strength: "0.42",
      grain_size: "3",
      grain_luminosity_mask: true,
      brightness: "1.05",
      contrast: "1.18",
      highlights: "-0.10",
      shadows: "-0.08",
      warmth: "0.20",
      saturation: "0.30",
      vibrance: "0.20",
      sharpness_amount: "0.45",
      sharpness_radius: "1.2",
      chromatic_aberration: "0.5",
      edge_softness: "0.12",
      outer_brightness: "-0.15",
      mode: "RetroFilm",
      strength: "0.55"
    },

    // 22. 1990s Point-and-Shoot — oversaturated, harsh flash, purple shadows, green cast
    point_shoot_90s: {
      lut_look: "Fuji Superia",
      lut_intensity: "0.70",
      noise_level: "0.038",
      grain_strength: "0.55",
      grain_size: "3",
      grain_luminosity_mask: false,
      brightness: "1.12",
      contrast: "1.15",
      highlights: "0.18",
      shadows: "-0.05",
      warmth: "-0.08",
      saturation: "0.28",
      vibrance: "0.15",
      sharpness_amount: "0.60",
      sharpness_radius: "0.8",
      chromatic_aberration: "1.2",
      edge_softness: "0.05",
      outer_brightness: "-0.25",
      mode: "RetroFilm",
      strength: "0.50"
    },

    // 23. 1940s Noir Newsprint — brutal grain, near-binary contrast, no midtones
    noir_newsprint: {
      lut_look: "Monochrome Noir",
      lut_intensity: "1.00",
      noise_level: "0.055",
      grain_strength: "0.75",
      grain_size: "4",
      grain_luminosity_mask: false,
      brightness: "0.90",
      contrast: "1.50",
      highlights: "-0.25",
      shadows: "-0.45",
      warmth: "0.00",
      saturation: "-1.00",
      vibrance: "0.00",
      sharpness_amount: "0.70",
      sharpness_radius: "1.5",
      sharpness_threshold: "3",
      chromatic_aberration: "0.0",
      outer_brightness: "-0.30",
      mode: "Matte",
      strength: "0.10"
    },

    // 24. Early Color TV 1960s — bleeding chroma, teal+orange limited palette
    early_color_tv: {
      lut_look: "Teal & Orange",
      lut_intensity: "0.75",
      noise_level: "0.042",
      grain_strength: "0.60",
      grain_size: "4",
      grain_luminosity_mask: false,
      brightness: "1.05",
      contrast: "1.08",
      highlights: "0.10",
      shadows: "0.05",
      warmth: "0.12",
      saturation: "0.22",
      vibrance: "0.10",
      sharpness_amount: "0.10",
      chromatic_aberration: "1.5",
      edge_softness: "0.20",
      outer_brightness: "-0.22",
      mode: "RetroFilm",
      strength: "0.60"
    },

    // 25. Glasnost USSR 1987 — cold grey-blue, heavy Svema grain, desaturated
    ussr_svema: {
      lut_look: "Monochrome Noir",
      lut_intensity: "0.40",
      noise_level: "0.050",
      grain_strength: "0.70",
      grain_size: "4",
      grain_luminosity_mask: false,
      brightness: "0.92",
      contrast: "1.12",
      highlights: "-0.15",
      shadows: "-0.15",
      warmth: "-0.20",
      saturation: "-0.55",
      vibrance: "-0.10",
      sharpness_amount: "0.30",
      chromatic_aberration: "0.4",
      edge_softness: "0.15",
      outer_brightness: "-0.25",
      mode: "Matte",
      strength: "0.25"
    },

    // ── 🌈 COLOR THEORY ──────────────────────────────────────────

    // 26. Split-Tone Copper & Teal — teal shadows, copper-bronze highlights
    split_copper_teal: {
      lut_look: "Teal & Orange",
      lut_intensity: "0.80",
      noise_level: "0.010",
      grain_strength: "0.12",
      grain_size: "1",
      grain_luminosity_mask: true,
      brightness: "1.03",
      contrast: "1.12",
      highlights: "-0.05",
      shadows: "-0.10",
      warmth: "0.08",
      saturation: "0.12",
      vibrance: "0.20",
      sharpness_amount: "0.40",
      chromatic_aberration: "0.2",
      outer_brightness: "-0.12",
      mode: "CinematicGrade",
      strength: "0.45"
    },

    // 27. Bleach Bypass — high contrast, desaturated, metallic silver look (Saving Private Ryan)
    bleach_bypass: {
      lut_look: "Monochrome Noir",
      lut_intensity: "0.35",
      noise_level: "0.015",
      grain_strength: "0.22",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "0.95",
      contrast: "1.40",
      highlights: "-0.20",
      shadows: "-0.30",
      warmth: "-0.05",
      saturation: "-0.55",
      vibrance: "-0.15",
      sharpness_amount: "0.65",
      sharpness_radius: "1.2",
      sharpness_threshold: "2",
      chromatic_aberration: "0.15",
      outer_brightness: "-0.15",
      mode: "CinematicGrade",
      strength: "0.35"
    },

    // 28. Orange & Silver — warm skin tones on silver-grey neutrals, luxe editorial
    orange_silver: {
      lut_look: "Kodak Portra",
      lut_intensity: "0.60",
      noise_level: "0.008",
      grain_strength: "0.10",
      grain_size: "1",
      grain_luminosity_mask: true,
      brightness: "1.04",
      contrast: "1.08",
      highlights: "-0.08",
      shadows: "0.05",
      warmth: "0.18",
      saturation: "-0.10",
      vibrance: "0.20",
      sharpness_amount: "0.50",
      sharpness_radius: "1.0",
      chromatic_aberration: "0.15",
      outer_brightness: "-0.10",
      mode: "SoftPortrait",
      strength: "0.18"
    },

    // 29. Cyberpunk Acid — yellow-green + purple, near-black shadows, dystopian
    cyberpunk_acid: {
      lut_look: "Cyberpunk",
      lut_intensity: "0.85",
      noise_level: "0.020",
      grain_strength: "0.25",
      grain_size: "2",
      grain_luminosity_mask: false,
      brightness: "0.80",
      contrast: "1.45",
      highlights: "0.20",
      shadows: "-0.50",
      warmth: "-0.15",
      saturation: "0.40",
      vibrance: "0.30",
      sharpness_amount: "0.60",
      sharpness_radius: "1.0",
      chromatic_aberration: "1.2",
      edge_softness: "0.05",
      outer_brightness: "-0.45",
      mode: "Bloom",
      strength: "0.40",
      radius: "12.0",
      threshold: "0.45"
    },

    // 30. Muted Earth Tones — sand, clay, olive, slate — only natural pigments
    muted_earth: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.35",
      noise_level: "0.020",
      grain_strength: "0.28",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.00",
      contrast: "0.92",
      highlights: "-0.05",
      shadows: "0.08",
      warmth: "0.15",
      saturation: "-0.30",
      vibrance: "-0.05",
      sharpness_amount: "0.25",
      chromatic_aberration: "0.2",
      edge_softness: "0.12",
      outer_brightness: "-0.10",
      mode: "Matte",
      strength: "0.35"
    },

    // ── 🎬 CINEMA DIRECTORS ──────────────────────────────────────

    // 31. Wes Anderson Pastel — symmetrical pastel pink/yellow/olive, soft light
    wes_anderson: {
      lut_look: "Kodak Portra",
      lut_intensity: "0.50",
      noise_level: "0.012",
      grain_strength: "0.15",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.10",
      contrast: "0.88",
      highlights: "0.05",
      shadows: "0.18",
      warmth: "0.15",
      saturation: "-0.08",
      vibrance: "0.12",
      sharpness_amount: "0.30",
      chromatic_aberration: "0.2",
      edge_softness: "0.20",
      outer_brightness: "-0.08",
      mode: "SoftPortrait",
      strength: "0.20"
    },

    // 32. David Fincher Dark — very dark teal shadows, brutal contrast, near-zero light
    fincher_dark: {
      lut_look: "Teal & Orange",
      lut_intensity: "0.70",
      noise_level: "0.018",
      grain_strength: "0.25",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "0.78",
      contrast: "1.50",
      highlights: "-0.15",
      shadows: "-0.55",
      warmth: "-0.08",
      saturation: "-0.12",
      vibrance: "0.05",
      sharpness_amount: "0.55",
      sharpness_radius: "1.2",
      chromatic_aberration: "0.3",
      outer_brightness: "-0.50",
      inner_brightness: "-0.05",
      mode: "CinematicGrade",
      strength: "0.55"
    },

    // 33. Wong Kar-Wai — red+green duality, blurred motion softness, Hong Kong melancholy
    wong_kar_wai: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.45",
      noise_level: "0.030",
      grain_strength: "0.40",
      grain_size: "3",
      grain_luminosity_mask: true,
      brightness: "0.92",
      contrast: "1.15",
      highlights: "-0.12",
      shadows: "-0.20",
      warmth: "0.20",
      saturation: "0.25",
      vibrance: "0.15",
      sharpness_amount: "0.05",
      chromatic_aberration: "0.8",
      edge_softness: "0.45",
      outer_brightness: "-0.30",
      mode: "Halation",
      strength: "0.40",
      radius: "25.0",
      threshold: "0.60"
    },

    // 34. Dune (2021) — near-monochrome warm sand, lifted highlights, flat Villeneuve style
    dune_sand: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.45",
      noise_level: "0.014",
      grain_strength: "0.18",
      grain_size: "2",
      grain_luminosity_mask: true,
      brightness: "1.08",
      contrast: "0.88",
      highlights: "0.15",
      shadows: "0.10",
      warmth: "0.22",
      saturation: "-0.40",
      vibrance: "-0.10",
      sharpness_amount: "0.28",
      chromatic_aberration: "0.25",
      edge_softness: "0.15",
      outer_brightness: "-0.12",
      mode: "Matte",
      strength: "0.40"
    },

    // 35. La La Land Golden — pure clean gold warmth vs cold night blue, vivid contrast
    la_la_land: {
      lut_look: "Vintage Gold",
      lut_intensity: "0.65",
      noise_level: "0.010",
      grain_strength: "0.12",
      grain_size: "1",
      grain_luminosity_mask: true,
      brightness: "1.08",
      contrast: "1.15",
      highlights: "0.10",
      shadows: "-0.08",
      warmth: "0.28",
      saturation: "0.20",
      vibrance: "0.28",
      sharpness_amount: "0.45",
      chromatic_aberration: "0.3",
      edge_softness: "0.12",
      outer_brightness: "-0.15",
      mode: "Bloom",
      strength: "0.35",
      radius: "22.0",
      threshold: "0.65"
    }
  };

  function applyPreset(name) {
    if (name === 'default') {
      $$('.reset-btn').forEach(btn => btn.click());
      // Turn OFF all sections on default reset
      for (let key in sectionEnabled) {
        disableSection(key);
      }
      btnDeletePreset.classList.add('hidden');
      return;
    }
    
    let values = PREDEFINED_PRESETS[name];
    if (!values) {
      const saved = localStorage.getItem('oneart_presets');
      if (saved) {
        const custom = JSON.parse(saved);
        const item = custom[name];
        if (item && typeof item === 'object' && 'state' in item) {
          values = item.state;
        } else {
          values = item; // backward compatibility
        }
      }
    }
    
    if (values) {
      pushState();
      
      // Restore section enabled states first if saved
      if (values.sectionEnabled) {
        for (let sec in values.sectionEnabled) {
          if (values.sectionEnabled[sec]) {
            enableSection(sec);
          } else {
            disableSection(sec);
          }
        }
      }
      
      for (let key in values) {
        if (key === 'sectionEnabled') continue;
        const el = $('#' + key);
        if (el) {
          if (el.type === 'checkbox') {
            el.checked = values[key];
          } else {
            el.value = values[key];
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          
          // Fallback: automatically enable the parent section for modified control if sectionEnabled is missing
          if (!values.sectionEnabled) {
            const sectionEl = el.closest('.section');
            if (sectionEl) {
              const sectionName = sectionEl.dataset.section;
              if (sectionName) {
                enableSection(sectionName);
              }
            }
          }
        }
      }
      btnDeletePreset.classList.toggle('hidden', PREDEFINED_PRESETS[name] !== undefined);
      if (resultReady) {
        btnProcess.click();
      }
    }
  }

  function saveCustomPreset() {
    const name = prompt(currentLang === 'ru' ? 'Введите имя пресета:' : 'Enter preset name:');
    if (!name || !name.trim()) return;
    
    const key = 'custom_' + Date.now();
    const state = {};
    
    // Save sliders, selects, checkboxes, text and number inputs
    $$('.slider, .select-input, .text-input, .number-input, .color-input, input[type="checkbox"]').forEach(el => {
      if (el.id && el.id !== 'presets_select') {
        if (el.type === 'checkbox') {
          state[el.id] = el.checked;
        } else {
          state[el.id] = el.value;
        }
      }
    });
    
    // Also save section enabled states
    state['sectionEnabled'] = { ...sectionEnabled };
    
    const saved = localStorage.getItem('oneart_presets');
    const custom = saved ? JSON.parse(saved) : {};
    custom[key] = {
      name: name.trim(),
      state: state
    };
    localStorage.setItem('oneart_presets', JSON.stringify(custom));
    
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = name.trim();
    presetsSelect.appendChild(opt);
    presetsSelect.value = key;
    
    btnDeletePreset.classList.remove('hidden');
    toast(currentLang === 'ru' ? 'Пресет сохранен!' : 'Preset saved!', 'success');
  }

  function deleteCustomPreset() {
    const key = presetsSelect.value;
    if (!key.startsWith('custom_')) return;
    
    const saved = localStorage.getItem('oneart_presets');
    if (saved) {
      const custom = JSON.parse(saved);
      delete custom[key];
      localStorage.setItem('oneart_presets', JSON.stringify(custom));
    }
    
    const opt = Array.from(presetsSelect.options).find(o => o.value === key);
    if (opt) opt.remove();
    presetsSelect.value = 'default';
    applyPreset('default');
    btnDeletePreset.classList.add('hidden');
    toast(currentLang === 'ru' ? 'Пресет удален' : 'Preset deleted', 'info');
  }

  function loadCustomPresets() {
    const saved = localStorage.getItem('oneart_presets');
    if (saved) {
      const custom = JSON.parse(saved);
      for (let key in custom) {
        const opt = document.createElement('option');
        opt.value = key;
        const item = custom[key];
        if (item && typeof item === 'object' && 'state' in item) {
          opt.textContent = item.name || `Preset ${key.replace('custom_', '')}`;
        } else {
          opt.textContent = `Preset ${key.replace('custom_', '')}`;
        }
        presetsSelect.appendChild(opt);
      }
    }
  }

  // D. Crop Box Interaction
  function updateCropBoxUI() {
    if (!cropActive) {
      cropBox.classList.add('hidden');
      return;
    }
    cropBox.classList.remove('hidden');
    cropBox.style.left = cropRect.x + '%';
    cropBox.style.top = cropRect.y + '%';
    cropBox.style.width = cropRect.w + '%';
    cropBox.style.height = cropRect.h + '%';
  }

  function initCropInteraction() {
    cropEnabledCheckbox.addEventListener('change', () => {
      cropActive = cropEnabledCheckbox.checked;
      updateCropBoxUI();
      pushState();
    });

    function handleCropStart(e) {
      if (e.target.classList.contains('crop-handle')) {
        activeHandle = e.target.className.split(' ')[1];
      } else {
        activeHandle = 'move';
      }
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      dragStart.x = clientX;
      dragStart.y = clientY;
      rectStart.x = cropRect.x;
      rectStart.y = cropRect.y;
      rectStart.w = cropRect.w;
      rectStart.h = cropRect.h;
      e.stopPropagation();
      if (e.touches && e.cancelable) e.preventDefault();
    }

    function handleCropMove(e) {
      if (!activeHandle) return;
      const containerRect = comparisonWrapper.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = ((clientX - dragStart.x) / containerRect.width) * 100;
      const dy = ((clientY - dragStart.y) / containerRect.height) * 100;

      const aspect = cropAspectRatioSelect.value;
      let ratio = null;
      if (aspect === '1:1') ratio = 1.0;
      else if (aspect === '4:3') ratio = 4/3;
      else if (aspect === '16:9') ratio = 16/9;

      const pxRatio = containerRect.width / containerRect.height;

      if (activeHandle === 'move') {
        cropRect.x = Math.max(0, Math.min(100 - rectStart.w, rectStart.x + dx));
        cropRect.y = Math.max(0, Math.min(100 - rectStart.h, rectStart.y + dy));
      } else {
        let newW = rectStart.w;
        let newH = rectStart.h;
        let newX = rectStart.x;
        let newY = rectStart.y;

        if (activeHandle.includes('r')) {
          newW = Math.max(10, Math.min(100 - rectStart.x, rectStart.w + dx));
        } else if (activeHandle.includes('l')) {
          newW = Math.max(10, Math.min(rectStart.x + rectStart.w, rectStart.w - dx));
          newX = rectStart.x + rectStart.w - newW;
        }

        if (activeHandle.includes('b')) {
          newH = Math.max(10, Math.min(100 - rectStart.y, rectStart.h + dy));
        } else if (activeHandle.includes('t')) {
          newH = Math.max(10, Math.min(rectStart.y + rectStart.h, rectStart.h - dy));
          newY = rectStart.y + rectStart.h - newH;
        }

        if (ratio) {
          if (activeHandle.includes('r') || activeHandle.includes('l')) {
            newH = newW * pxRatio / ratio;
          } else {
            newW = newH * ratio / pxRatio;
          }
        }

        if (newX >= 0 && newY >= 0 && (newX + newW) <= 100 && (newY + newH) <= 100) {
          cropRect.x = newX;
          cropRect.y = newY;
          cropRect.w = newW;
          cropRect.h = newH;
        }
      }
      updateCropBoxUI();
      if (e.touches && e.cancelable) e.preventDefault();
    }

    function handleCropEnd() {
      if (activeHandle) {
        activeHandle = null;
        pushState();
      }
    }

    cropBox.addEventListener('mousedown', handleCropStart);
    cropBox.addEventListener('touchstart', handleCropStart, { passive: false });

    document.addEventListener('mousemove', handleCropMove);
    document.addEventListener('touchmove', handleCropMove, { passive: false });

    document.addEventListener('mouseup', handleCropEnd);
    document.addEventListener('touchend', handleCropEnd);
  }

  // E. Zoom & Pan
  function updateZoomTransform() {
    comparisonWrapper.style.transform = `scale(${currentZoom}) translate(${zoomX}px, ${zoomY}px)`;
  }

  function initZoomPan() {
    comparisonViewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomIntensity = 0.1;
      
      if (e.deltaY < 0) {
        currentZoom = Math.min(8.0, currentZoom + zoomIntensity * currentZoom);
      } else {
        currentZoom = Math.max(1.0, currentZoom - zoomIntensity * currentZoom);
      }
      
      if (currentZoom === 1.0) {
        zoomX = 0;
        zoomY = 0;
      }
      updateZoomTransform();
    }, { passive: false });

    function handlePanStart(e) {
      if (e.touches === undefined && e.button !== 0) return;
      if (currentZoom > 1.0 && !activeHandle && !isDragging) {
        isPanning = true;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        panStartX = clientX - zoomX;
        panStartY = clientY - zoomY;
        comparisonViewport.style.cursor = 'grabbing';
        if (e.touches && e.cancelable) e.preventDefault();
      }
    }

    function handlePanMove(e) {
      if (isPanning) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        zoomX = clientX - panStartX;
        zoomY = clientY - panStartY;
        updateZoomTransform();
        if (e.touches && e.cancelable) e.preventDefault();
      }
    }

    function handlePanEnd() {
      if (isPanning) {
        isPanning = false;
        comparisonViewport.style.cursor = 'grab';
      }
    }

    comparisonViewport.addEventListener('mousedown', handlePanStart);
    comparisonViewport.addEventListener('touchstart', handlePanStart, { passive: false });

    document.addEventListener('mousemove', handlePanMove);
    document.addEventListener('touchmove', handlePanMove, { passive: false });

    document.addEventListener('mouseup', handlePanEnd);
    document.addEventListener('touchend', handlePanEnd);

    btnResetZoom.addEventListener('click', () => {
      currentZoom = 1.0;
      zoomX = 0;
      zoomY = 0;
      updateZoomTransform();
    });
  }

  // F. Compare Modes
  function setCompareMode(mode) {
    compareMode = mode;
    btnCompareSplit.classList.toggle('active', mode === 'split');
    btnCompareSide.classList.toggle('active', mode === 'side');
    btnCompareHold.classList.toggle('active', mode === 'hold');
    
    comparisonWrapper.classList.remove('side-by-side');
    comparisonSlider.classList.remove('hidden');
    comparisonLabels.classList.remove('hidden');
    resultImage.style.clipPath = '';
    if (webglActive) webglPreviewCanvas.style.clipPath = '';
    showResultImage(true);
    previewImage.classList.remove('hidden');

    if (mode === 'split') {
      setComparePosition(50);
    } else if (mode === 'side') {
      comparisonSlider.classList.add('hidden');
      comparisonWrapper.classList.add('side-by-side');
    } else if (mode === 'hold') {
      comparisonSlider.classList.add('hidden');
      comparisonLabels.classList.add('hidden');
      resultImage.style.clipPath = 'none';
      if (webglActive) webglPreviewCanvas.style.clipPath = 'none';
    }
  }

  // G. Batch Queue & Execution
  function addFileToBatchQueue(item) {
    let previewUrl = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%239898a8"><path d="M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-1 14H6l3-4 2 2.5 3-3.5 4 5z"/></svg>';
    const queueId = 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const batchItem = {
      id: queueId,
      file: item.file || null,
      path: item.path || '',
      name: item.name,
      status: 'pending',
      previewUrl: previewUrl
    };

    batchQueue.push(batchItem);
    
    const card = document.createElement('div');
    card.className = 'batch-card pending';
    card.id = queueId;
    card.innerHTML = `
      <button class="batch-card-remove">&times;</button>
      <img class="batch-card-preview" src="${previewUrl}">
      <span class="batch-card-name" title="${item.name}">${item.name}</span>
      <span class="batch-card-status">Pending</span>
    `;

    card.querySelector('.batch-card-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      batchQueue = batchQueue.filter(x => x.id !== queueId);
      card.remove();
      updateBatchProcessButton();
    });

    batchGrid.appendChild(card);
    updateBatchProcessButton();

    if (item.file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        card.querySelector('.batch-card-preview').src = evt.target.result;
        batchItem.previewUrl = evt.target.result;
      };
      reader.readAsDataURL(item.file);
    }
  }

  function updateBatchProcessButton() {
    btnProcessBatch.disabled = batchQueue.length === 0;
  }

  function updateBatchProgress(percent, currentCount = 0) {
    batchProgressBar.style.width = percent + '%';
    batchProgressText.textContent = currentLang === 'ru'
      ? `Обработано файлов: ${currentCount} из ${batchQueue.length} (${percent}%)`
      : `Processed ${currentCount} of ${batchQueue.length} files (${percent}%)`;
  }

  // H. Initialization of All Handlers
  function initV3() {
    // Presets
    loadCustomPresets();
    presetsSelect.addEventListener('change', () => applyPreset(presetsSelect.value));
    btnSavePreset.addEventListener('click', saveCustomPreset);
    btnDeletePreset.addEventListener('click', deleteCustomPreset);    comparisonViewport.addEventListener('mouseenter', () => {
      if (compareMode === 'hold' && (resultReady || webglActive)) {
        holdOriginalActive = true;
        showResultImage(false);
      }
    });
    comparisonViewport.addEventListener('mouseleave', () => {
      if (compareMode === 'hold' && (resultReady || webglActive)) {
        holdOriginalActive = false;
        showResultImage(true);
      }
    });

    // Crop / Zoom / Compare
    initCropInteraction();
    initZoomPan();
    initCurves();
    
    // Init WebSocket
    initWebSocket();

    // Init WebGL
    try {
      if (OneArtWebGL.isSupported()) {
        OneArtWebGL.init(webglPreviewCanvas);
        webglActive = true;
        console.log("[WebGL] Engine successfully initialized.");
        
        previewImage.addEventListener('load', () => {
          if (webglActive) {
            OneArtWebGL.setImage(previewImage);
            computeSourceLABStats(previewImage);
            renderWebGLPreview();
          }
        });
      }
    } catch (err) {
      console.error("[WebGL] Initialization failed:", err);
      webglActive = false;
    }

    // Export 3D LUT binding
    if (btnExportLUT) {
      btnExportLUT.addEventListener('click', async () => {
        if (!resultReady) return;
        setStatus('processing');
        loadingOverlay.classList.remove('hidden');
        try {
          const params = collectParams();
          const res = await callApi('export_3d_lut', JSON.stringify(params));
          if (res && res.ok) {
            toast(currentLang === 'ru' ? '3D LUT успешно экспортирован: ' + res.filename : '3D LUT exported successfully: ' + res.filename, 'success');
          } else {
            toast(res ? res.error : 'Export failed', 'error');
          }
        } catch (err) {
          toast('Export error: ' + err.message, 'error');
        } finally {
          setStatus('ready');
          loadingOverlay.classList.add('hidden');
        }
      });
    }
    btnCompareSplit.addEventListener('click', () => setCompareMode('split'));
    btnCompareSide.addEventListener('click', () => setCompareMode('side'));
    btnCompareHold.addEventListener('click', () => setCompareMode('hold'));

    // Spacebar Compare Hook
    document.addEventListener('keydown', (e) => {
      if (e.key === ' ' && resultReady && !holdOriginalActive && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
        e.preventDefault();
        holdOriginalActive = true;
        resultImage.classList.add('hidden');
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' && holdOriginalActive) {
        holdOriginalActive = false;
        resultImage.classList.remove('hidden');
      }
    });

    // Undo / Redo — Sliders Hook
    $$('.slider, .select-input, .text-input, .number-input, .color-input, input[type="checkbox"]').forEach(el => {
      // On release: save history
      el.addEventListener('change', () => {
        pushState();
        if (webglActive && imageLoaded) {
          requestWebGLRender();
        }
      });
    });

    const btnRandomizeLeaks = $('#btnRandomizeLeaks');
    if (btnRandomizeLeaks && lightLeaksSeed) {
      btnRandomizeLeaks.addEventListener('click', () => {
        lightLeaksSeed.value = Math.floor(Math.random() * 999999);
        lightLeaksSeed.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    btnUndo.addEventListener('click', undo);
    btnRedo.addEventListener('click', redo);

    // White Balance mode change listener
    const wbModeSelect = $('#whitebalance_mode');
    if (wbModeSelect) {
      wbModeSelect.addEventListener('change', updateWhiteBalanceUI);
      wbModeSelect.addEventListener('input', updateWhiteBalanceUI);
    }

    // Modal Info Dialog listeners
    const btnInfo = $('#btnInfo');
    const btnInfoClose = $('#btnInfoClose');
    const infoModal = $('#infoModal');
    if (btnInfo && infoModal && btnInfoClose) {
      btnInfo.addEventListener('click', () => {
        infoModal.classList.remove('hidden');
      });
      btnInfoClose.addEventListener('click', () => {
        infoModal.classList.add('hidden');
      });
      infoModal.addEventListener('click', (e) => {
        if (e.target === infoModal) {
          infoModal.classList.add('hidden');
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
      }
    });

    // Batch UI Toggles
    btnToggleBatchMode.addEventListener('click', () => {
      batchModeActive = !batchModeActive;
      btnToggleBatchMode.classList.toggle('active', batchModeActive);
      
      if (batchModeActive) {
        uploadZone.classList.add('hidden');
        previewContainer.classList.add('hidden');
        batchContainer.classList.remove('hidden');
      } else {
        batchContainer.classList.add('hidden');
        if (imageLoaded) {
          previewContainer.classList.remove('hidden');
        } else {
          uploadZone.classList.remove('hidden');
        }
      }
    });

    btnSelectBatchFiles.addEventListener('click', () => {
      if (apiReady && !useClientSide) {
        callApi('pick_files').then(res => {
          if (res && res.ok && res.files) {
            res.files.forEach(filepath => {
              const name = filepath.split(/[\\/]/).pop();
              addFileToBatchQueue({ path: filepath, name: name });
            });
          }
        });
      } else {
        batchFileInput.click();
      }
    });

    batchFileInput.addEventListener('change', () => {
      if (batchFileInput.files.length > 0) {
        Array.from(batchFileInput.files).forEach(file => {
          addFileToBatchQueue({ file: file, name: file.name });
        });
      }
    });

    btnClearBatch.addEventListener('click', () => {
      batchQueue = [];
      batchGrid.innerHTML = '';
      updateBatchProcessButton();
      batchProgressWrapper.classList.add('hidden');
    });

    batchContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      batchContainer.classList.add('drag-over');
    });

    batchContainer.addEventListener('dragleave', () => {
      batchContainer.classList.remove('drag-over');
    });

    batchContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      batchContainer.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        Array.from(files).forEach(file => {
          addFileToBatchQueue({ file: file, name: file.name });
        });
      }
    });

    // Parallel Batch Progress Handler
    window.onBatchItemProgress = function(filepath, success, resultStr) {
      const item = batchQueue.find(q => q.path === filepath || q.name === filepath.split(/[\\/]/).pop());
      if (!item) return;
      
      const card = document.getElementById(item.id);
      if (success) {
        item.status = 'processed';
        if (card) {
          card.className = 'batch-card processed';
          card.querySelector('.batch-card-status').textContent = 'Completed';
        }
      } else {
        item.status = 'failed';
        if (card) {
          card.className = 'batch-card failed';
          card.querySelector('.batch-card-status').textContent = 'Failed';
          card.title = resultStr;
        }
      }
      
      const completedCount = batchQueue.filter(q => q.status === 'processed' || q.status === 'failed').length;
      const successCount = batchQueue.filter(q => q.status === 'processed').length;
      
      updateBatchProgress(Math.round((completedCount / batchQueue.length) * 100), completedCount);
      
      if (completedCount === batchQueue.length) {
        btnProcessBatch.disabled = false;
        btnClearBatch.disabled = false;
        btnSelectBatchFiles.disabled = false;
        
        toast(
          currentLang === 'ru'
            ? `Пакетная обработка завершена! Успешно: ${successCount} из ${batchQueue.length}`
            : `Batch complete! Succeeded: ${successCount} of ${batchQueue.length}`,
          successCount === batchQueue.length ? 'success' : 'info'
        );
      }
    };

    btnProcessBatch.addEventListener('click', async () => {
      if (batchQueue.length === 0) return;
      
      btnProcessBatch.disabled = true;
      btnClearBatch.disabled = true;
      btnSelectBatchFiles.disabled = true;
      
      batchProgressWrapper.classList.remove('hidden');
      updateBatchProgress(0);
      
      const params = collectParams();
      const metadata = collectMetadataParams();
      const allParams = { ...params, ...metadata };

      if (useClientSide) {
        let successCount = 0;
        for (let i = 0; i < batchQueue.length; i++) {
          const item = batchQueue[i];
          item.status = 'processing';
          const card = document.getElementById(item.id);
          if (card) {
            card.className = 'batch-card processing';
            card.querySelector('.batch-card-status').textContent = 'Processing...';
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
          
          let ok = false;
          try {
            const tempImg = new Image();
            const loadedPromise = new Promise((resolve, reject) => {
              tempImg.onload = () => resolve();
              tempImg.onerror = () => reject();
            });
            
            if (item.file) {
              const reader = new FileReader();
              const readPromise = new Promise((resolve) => {
                reader.onload = (evt) => resolve(evt.target.result);
              });
              reader.readAsDataURL(item.file);
              tempImg.src = await readPromise;
            } else {
              throw new Error("No file object");
            }
            
            await loadedPromise;
            const processedCanvas = await OneArtProcessor.processImage(tempImg, allParams);
            
            const q = (parseInt(allParams.quality) || 95) / 100;
            const blobPromise = new Promise(resolve => processedCanvas.toBlob(resolve, 'image/jpeg', q));
            const blob = await blobPromise;
            
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const nameParts = item.name.split('.');
            nameParts.pop();
            const baseName = nameParts.join('.');
            
            const formatExts = { JPEG: 'jpg', PNG: 'png', TIFF: 'tif', WebP: 'webp' };
            const targetExt = formatExts[allParams.export_format] || 'jpg';
            
            a.href = url;
            a.download = `oneart_${baseName}_processed.${targetExt}`;
            a.click();
            URL.revokeObjectURL(url);
            ok = true;
          } catch (e) {
            console.error(e);
          }
          
          if (ok) {
            item.status = 'processed';
            successCount++;
            if (card) {
              card.className = 'batch-card processed';
              card.querySelector('.batch-card-status').textContent = 'Completed';
            }
          } else {
            item.status = 'failed';
            if (card) {
              card.className = 'batch-card failed';
              card.querySelector('.batch-card-status').textContent = 'Failed';
            }
          }
          updateBatchProgress(Math.round(((i + 1) / batchQueue.length) * 100), i + 1);
        }
        
        btnProcessBatch.disabled = false;
        btnClearBatch.disabled = false;
        btnSelectBatchFiles.disabled = false;
        
        toast(
          currentLang === 'ru'
            ? `Пакетная обработка завершена! Успешно: ${successCount} из ${batchQueue.length}`
            : `Batch complete! Succeeded: ${successCount} of ${batchQueue.length}`,
          successCount === batchQueue.length ? 'success' : 'info'
        );
      } else {
        batchQueue.forEach(item => {
          item.status = 'pending';
          const card = document.getElementById(item.id);
          if (card) {
            card.className = 'batch-card pending';
            card.querySelector('.batch-card-status').textContent = 'Queued';
          }
        });
        
        const res = await callApi('process_batch_queue_parallel', JSON.stringify(batchQueue), JSON.stringify(allParams));
        if (!res || !res.ok) {
          toast(res ? res.error : 'Failed to launch parallel batch processing', 'error');
          btnProcessBatch.disabled = false;
          btnClearBatch.disabled = false;
          btnSelectBatchFiles.disabled = false;
        }
      }
    });
  }

  // Run V3 initialization
  initV3();
})();
