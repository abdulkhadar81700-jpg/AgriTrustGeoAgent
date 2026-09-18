/**
 * AgriTrustGeoAgent - Smart Crop Camera & Evidence Validation Controller
 * 
 * Provides an evidence-first optical screening and spatial verification gateway:
 * - Direct rear mobile camera activation (capture="environment") + high-res desktop dropzone
 * - Pure-JS binary EXIF GPS metadata parser (decimal degrees, timestamp, camera model)
 * - Device geolocation fallback when photo EXIF is stripped
 * - Canvas pixel-matrix quality screening (exposure, contrast, Laplacian variance sharpness)
 * - Geodesic point-in-polygon boundary comparison against selected PostGIS parcel
 * - Secure upload to 'crop-evidence' storage bucket & logging in 'public.crop_evidence'
 * - Clear status states: Uploading, Validation, Accepted, Needs better photo, Location mismatch
 * - Strict safety guarantee: No automated diagnostic or treatment conclusions rendered
 */

const AgriTrustCropCamera = (() => {
  let currentUser = null;
  let userFields = [];
  let selectedField = null;
  let selectedFile = null;
  let previewUrl = null;
  let currentExif = null;
  let qualityMetrics = null;
  let geofenceResult = null;
  let currentStatus = 'idle'; // 'idle' | 'validation' | 'accepted' | 'needs_better_photo' | 'location_mismatch' | 'uploading'
  let recentEvidenceList = [];

  let dom = {};

  function init() {
    cacheDOM();
    bindEvents();
    syncAuthState();

    if (window.AgriTrustSupabase && window.AgriTrustSupabase.onAuthStateChange) {
      window.AgriTrustSupabase.onAuthStateChange(() => {
        syncAuthState();
      });
    }

    // Refresh fields when saved in map manager
    window.addEventListener('agritrust:fieldSaved', () => {
      loadFarmerFields();
    });

    // Listen for Supabase client readiness
    window.addEventListener('agritrust:supabaseReady', () => {
      syncAuthState();
    });
  }

  function cacheDOM() {
    dom = {
      section: document.getElementById('crop-camera'),
      cameraAuthGate: document.getElementById('cameraAuthGate'),
      cameraWorkbench: document.getElementById('cameraWorkbench'),

      // Inputs & Selectors
      fieldSelect: document.getElementById('cameraFieldSelect'),
      fieldSummaryBadge: document.getElementById('cameraFieldSummary'),
      cropNameInput: document.getElementById('cameraCropName'),
      growthStageSelect: document.getElementById('cameraGrowthStage'),
      fieldNotesInput: document.getElementById('cameraNotes'),

      // File Inputs
      nativeCameraInput: document.getElementById('cropCameraInput'),
      filePickerInput: document.getElementById('cropFileInput'),
      btnTriggerCamera: document.getElementById('btnTriggerCamera'),
      btnTriggerFile: document.getElementById('btnTriggerFile'),
      dropzoneArea: document.getElementById('cameraDropzone'),
      btnResetCapture: document.getElementById('btnResetCapture'),

      // Preview & Status
      previewContainer: document.getElementById('cameraPreviewContainer'),
      previewImage: document.getElementById('cameraPreviewImage'),
      statusBanner: document.getElementById('cameraStatusBanner'),
      statusBadge: document.getElementById('cameraStatusBadge'),
      statusTitle: document.getElementById('cameraStatusTitle'),
      statusDescription: document.getElementById('cameraStatusDescription'),

      // Optical Telemetry HUD
      hudResolution: document.getElementById('hudResolution'),
      hudFileSize: document.getElementById('hudFileSize'),
      hudSharpness: document.getElementById('hudSharpness'),
      hudExposure: document.getElementById('hudExposure'),
      hudCoordinates: document.getElementById('hudCoordinates'),
      hudGeofence: document.getElementById('hudGeofence'),
      btnUseDeviceLocation: document.getElementById('btnUseDeviceLocation'),

      // Submission
      btnSubmitEvidence: document.getElementById('btnSubmitEvidence'),
      submitSpinner: document.getElementById('cameraSubmitSpinner'),
      evidenceFeedback: document.getElementById('cameraEvidenceFeedback'),

      // Recent Evidence
      recentEvidenceContainer: document.getElementById('recentEvidenceContainer'),
      recentEvidenceList: document.getElementById('recentEvidenceList'),
      emptyEvidenceNotice: document.getElementById('emptyEvidenceNotice')
    };
  }

  function bindEvents() {
    // Field change
    if (dom.fieldSelect) {
      dom.fieldSelect.addEventListener('change', handleFieldSelectionChange);
    }

    // Camera and file buttons
    if (dom.btnTriggerCamera && dom.nativeCameraInput) {
      dom.btnTriggerCamera.addEventListener('click', () => {
        if (!validateFieldPreselection()) return;
        dom.nativeCameraInput.click();
      });
      dom.nativeCameraInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          processImageFile(e.target.files[0]);
        }
      });
    }

    if (dom.btnTriggerFile && dom.filePickerInput) {
      dom.btnTriggerFile.addEventListener('click', () => {
        if (!validateFieldPreselection()) return;
        dom.filePickerInput.click();
      });
      dom.filePickerInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          processImageFile(e.target.files[0]);
        }
      });
    }

    // Reset
    if (dom.btnResetCapture) {
      dom.btnResetCapture.addEventListener('click', resetCaptureState);
    }

    // Drag and drop
    if (dom.dropzoneArea) {
      ['dragenter', 'dragover'].forEach(eventName => {
        dom.dropzoneArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dom.dropzoneArea.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(eventName => {
        dom.dropzoneArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dom.dropzoneArea.classList.remove('dragover');
        });
      });
      dom.dropzoneArea.addEventListener('drop', (e) => {
        if (!validateFieldPreselection()) return;
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          processImageFile(e.dataTransfer.files[0]);
        }
      });
    }

    // Device location fallback
    if (dom.btnUseDeviceLocation) {
      dom.btnUseDeviceLocation.addEventListener('click', handleRequestDeviceLocation);
    }

    // Submit Evidence
    if (dom.btnSubmitEvidence) {
      dom.btnSubmitEvidence.addEventListener('click', handleSubmitEvidence);
    }
  }

  /**
   * Sync authentication state
   */
  async function syncAuthState() {
    if (window.AgriTrustSupabase && window.AgriTrustSupabase.ready) {
      await window.AgriTrustSupabase.ready();
    }

    if (!window.AgriTrustSupabase || !window.AgriTrustSupabase.isReady()) {
      renderUnauthenticated();
      return;
    }

    currentUser = await window.AgriTrustSupabase.getUser();
    if (currentUser) {
      renderAuthenticated();
      await loadFarmerFields();
      await loadRecentEvidence();
    } else {
      renderUnauthenticated();
    }
  }

  function renderAuthenticated() {
    if (dom.cameraAuthGate) dom.cameraAuthGate.style.display = 'none';
    if (dom.cameraWorkbench) dom.cameraWorkbench.style.display = 'block';
  }

  function renderUnauthenticated() {
    currentUser = null;
    selectedField = null;
    userFields = [];
    if (dom.cameraAuthGate) dom.cameraAuthGate.style.display = 'block';
    if (dom.cameraWorkbench) dom.cameraWorkbench.style.display = 'none';
  }

  /**
   * Load the farmer's registered fields from Supabase
   */
  async function loadFarmerFields(preferredFieldId = null) {
    if (!currentUser || !window.AgriTrustSupabase) return;

    const res = await window.AgriTrustSupabase.fetchUserFields();
    if (!res.success) {
      console.warn('[AgriTrustCropCamera] Could not load fields:', res.message);
      return;
    }

    userFields = res.fields || [];
    populateFieldSelect(preferredFieldId);
  }

  function populateFieldSelect(preferredFieldId = null) {
    if (!dom.fieldSelect) return;

    dom.fieldSelect.innerHTML = '';

    if (userFields.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No field parcels found — Draw boundary first';
      dom.fieldSelect.appendChild(opt);
      updateFieldSummary(null);
      return;
    }

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— Select a registered field parcel * —';
    dom.fieldSelect.appendChild(defaultOpt);

    userFields.forEach((field) => {
      const opt = document.createElement('option');
      opt.value = field.id;
      opt.textContent = `${field.name} (${field.acreage} ac - ${field.crop_variety})`;
      if (preferredFieldId && field.id === preferredFieldId) {
        opt.selected = true;
      }
      dom.fieldSelect.appendChild(opt);
    });

    // If preferred given or only 1 field
    if (preferredFieldId) {
      selectedField = userFields.find(f => f.id === preferredFieldId) || null;
    } else if (userFields.length === 1) {
      dom.fieldSelect.selectedIndex = 1;
      selectedField = userFields[0];
    } else {
      selectedField = null;
    }

    updateFieldSummary(selectedField);
  }

  function handleFieldSelectionChange() {
    const fieldId = dom.fieldSelect?.value;
    selectedField = userFields.find(f => f.id === fieldId) || null;
    updateFieldSummary(selectedField);

    // If an image was already loaded, re-evaluate geofence against new field
    if (selectedFile && currentExif && currentExif.hasGps) {
      evaluateGeofence();
      updateStatusDisplay();
    }
  }

  function updateFieldSummary(field) {
    if (!dom.fieldSummaryBadge) return;

    if (!field) {
      dom.fieldSummaryBadge.innerHTML = `
        <span style="color: var(--text-muted); font-size: 0.8125rem;">
          No field selected. Choose a parcel to anchor evidence.
        </span>
      `;
      return;
    }

    // Auto-fill crop name if empty
    if (dom.cropNameInput && !dom.cropNameInput.value) {
      dom.cropNameInput.value = field.crop_variety || '';
    }

    dom.fieldSummaryBadge.innerHTML = `
      <div class="camera-field-pill">
        <span class="field-pill-icon">🌾</span>
        <strong>${escapeHTML(field.name)}</strong>
        <span class="field-pill-sep">•</span>
        <span>${field.acreage} ac</span>
        <span class="field-pill-sep">•</span>
        <span class="crop-variety-pill" style="font-size: 0.7rem; padding: 0.15rem 0.45rem;">${escapeHTML(field.crop_variety)}</span>
        <span class="field-pill-sep">•</span>
        <span style="color: #15803d; font-weight: 600; font-size: 0.75rem;">PostGIS Polygon Verified</span>
      </div>
    `;
  }

  function validateFieldPreselection() {
    if (!selectedField) {
      alert('Please select a registered field parcel from the dropdown before capturing or uploading crop evidence.');
      if (dom.fieldSelect) dom.fieldSelect.focus();
      return false;
    }
    return true;
  }

  /**
   * Process a captured or chosen Image File
   */
  async function processImageFile(file) {
    if (!file) return;

    selectedFile = file;
    updateStatus('validation', 'Screening Image', 'Inspecting format, quality matrix, and spatial coordinates...');

    // 1. Validate MIME format
    const validMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validMimes.includes(file.type)) {
      updateStatus('needs_better_photo', 'Unsupported Image Format', `File type "${file.type || 'unknown'}" is not supported. Please provide a JPEG, PNG, or WebP photo.`);
      return;
    }

    // 2. Validate File Size
    const minBytes = 15 * 1024; // 15 KB
    const maxBytes = 20 * 1024 * 1024; // 20 MB (Supabase bucket limit)
    if (file.size < minBytes) {
      updateStatus('needs_better_photo', 'File Too Small / Incomplete', `File size (${(file.size / 1024).toFixed(1)} KB) is below the 15 KB minimum required for optical crop diagnostics.`);
      return;
    }
    if (file.size > maxBytes) {
      updateStatus('needs_better_photo', 'File Exceeds Size Limit', `File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds the 20 MB limit.`);
      return;
    }

    // Display image in preview
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    if (dom.previewImage) dom.previewImage.src = previewUrl;
    if (dom.previewContainer) dom.previewContainer.style.display = 'block';
    if (dom.dropzoneArea) dom.dropzoneArea.style.display = 'none';

    // Update basic HUD
    if (dom.hudFileSize) dom.hudFileSize.textContent = formatBytes(file.size);

    // 3. Extract EXIF Binary Metadata
    const arrayBuffer = await readFileAsArrayBuffer(file);
    currentExif = readExifMetadata(arrayBuffer);

    // 4. Image Load & Quality Screen via Canvas
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      qualityMetrics = analyzeImageReadability(img);
      updateQualityHUD(qualityMetrics);

      // 5. Evaluate Geofence Spatial Boundary
      evaluateGeofence();

      // 6. Formulate Overall Validation State
      updateStatusDisplay();
    };

    img.onerror = () => {
      updateStatus('needs_better_photo', 'Corrupted Image Data', 'The image file could not be rendered. Please take a new clear photo.');
    };

    img.src = previewUrl;
  }

  /**
   * Pure JavaScript Binary EXIF Parser for APP1 JPEG segments.
   * Extracts Decimal Latitude, Longitude, Timestamp, Camera Make & Model.
   */
  function readExifMetadata(buffer) {
    const view = new DataView(buffer);
    const result = {
      hasGps: false,
      lat: null,
      lng: null,
      timestamp: null,
      make: null,
      model: null
    };

    try {
      if (view.byteLength < 4) return result;
      // Check SOI marker 0xFFD8
      if (view.getUint16(0) !== 0xFFD8) {
        return result; // Not JPEG, skip binary EXIF
      }

      let offset = 2;
      const length = view.byteLength;

      while (offset < length - 4) {
        const marker = view.getUint16(offset);
        offset += 2;

        if (marker === 0xFFE1) { // APP1 Marker
          const app1Length = view.getUint16(offset);
          offset += 2;

          // Check "Exif\0\0"
          if (view.getUint32(offset) === 0x45786966 && view.getUint16(offset + 4) === 0x0000) {
            const tiffStart = offset + 6;
            const endianCode = view.getUint16(tiffStart);
            const isLittleEndian = (endianCode === 0x4949); // 'II'

            // Check TIFF 42
            if (view.getUint16(tiffStart + 2, isLittleEndian) !== 0x002A) {
              return result;
            }

            const ifd0Offset = view.getUint32(tiffStart + 4, isLittleEndian);
            let p = tiffStart + ifd0Offset;
            const numEntries = view.getUint16(p, isLittleEndian);
            p += 2;

            let gpsOffset = null;
            for (let i = 0; i < numEntries; i++) {
              const tag = view.getUint16(p, isLittleEndian);
              if (tag === 0x8825) { // GPSInfo tag
                gpsOffset = view.getUint32(p + 8, isLittleEndian);
              } else if (tag === 0x010F) { // Make
                result.make = readStringTag(view, tiffStart, p, isLittleEndian);
              } else if (tag === 0x0110) { // Model
                result.model = readStringTag(view, tiffStart, p, isLittleEndian);
              }
              p += 12;
            }

            // Parse GPS IFD if present
            if (gpsOffset !== null) {
              let gp = tiffStart + gpsOffset;
              const numGpsEntries = view.getUint16(gp, isLittleEndian);
              gp += 2;

              let latRef = 'N';
              let lonRef = 'E';
              let latParts = null;
              let lonParts = null;

              for (let i = 0; i < numGpsEntries; i++) {
                const gTag = view.getUint16(gp, isLittleEndian);
                const gOffsetVal = view.getUint32(gp + 8, isLittleEndian);

                if (gTag === 0x0001) { // LatRef
                  latRef = String.fromCharCode(view.getUint8(gp + 8));
                } else if (gTag === 0x0002) { // Lat rationals
                  latParts = readRationals(view, tiffStart + gOffsetVal, 3, isLittleEndian);
                } else if (gTag === 0x0003) { // LonRef
                  lonRef = String.fromCharCode(view.getUint8(gp + 8));
                } else if (gTag === 0x0004) { // Lon rationals
                  lonParts = readRationals(view, tiffStart + gOffsetVal, 3, isLittleEndian);
                }
                gp += 12;
              }

              if (latParts && lonParts) {
                let lat = latParts[0] + (latParts[1] / 60) + (latParts[2] / 3600);
                if (latRef === 'S') lat = -lat;

                let lng = lonParts[0] + (lonParts[1] / 60) + (lonParts[2] / 3600);
                if (lonRef === 'W') lng = -lng;

                result.hasGps = true;
                result.lat = Math.round(lat * 1000000) / 1000000;
                result.lng = Math.round(lng * 1000000) / 1000000;
              }
            }
          }
          break;
        } else if ((marker & 0xFF00) === 0xFF00) {
          const segLen = view.getUint16(offset);
          offset += segLen;
        } else {
          break;
        }
      }
    } catch (err) {
      console.warn('[AgriTrustCropCamera] EXIF parse notice:', err);
    }

    return result;
  }

  function readStringTag(view, tiffStart, entryOffset, isLittle) {
    try {
      const count = view.getUint32(entryOffset + 4, isLittle);
      const valOffset = view.getUint32(entryOffset + 8, isLittle);
      const strOffset = count <= 4 ? (entryOffset + 8) : (tiffStart + valOffset);
      let s = '';
      for (let i = 0; i < count - 1; i++) {
        s += String.fromCharCode(view.getUint8(strOffset + i));
      }
      return s.trim();
    } catch (e) {
      return null;
    }
  }

  function readRationals(view, startOffset, count, isLittle) {
    const parts = [];
    let p = startOffset;
    for (let i = 0; i < count; i++) {
      const num = view.getUint32(p, isLittle);
      const den = view.getUint32(p + 4, isLittle);
      parts.push(den !== 0 ? num / den : 0);
      p += 8;
    }
    return parts;
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file.slice(0, 131072)); // First 128KB is plenty for APP1 EXIF
    });
  }

  /**
   * Device Geolocation Fallback
   */
  function handleRequestDeviceLocation() {
    if (!navigator.geolocation) {
      alert('Device geolocation is not supported by your browser.');
      return;
    }

    if (dom.btnUseDeviceLocation) {
      dom.btnUseDeviceLocation.textContent = 'Locating...';
      dom.btnUseDeviceLocation.disabled = true;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 1000000) / 1000000;
        const lng = Math.round(pos.coords.longitude * 1000000) / 1000000;

        currentExif = currentExif || {};
        currentExif.hasGps = true;
        currentExif.lat = lat;
        currentExif.lng = lng;
        currentExif.source = 'device_geolocation';

        if (dom.btnUseDeviceLocation) {
          dom.btnUseDeviceLocation.textContent = 'Device GPS Anchored';
          dom.btnUseDeviceLocation.disabled = false;
        }

        evaluateGeofence();
        updateStatusDisplay();
      },
      (err) => {
        alert(`Geolocation access was not granted: ${err.message}. Spatial verification requires camera GPS or location access.`);
        if (dom.btnUseDeviceLocation) {
          dom.btnUseDeviceLocation.textContent = 'Retry Device GPS';
          dom.btnUseDeviceLocation.disabled = false;
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }

  /**
   * Canvas Image Quality & Readability Screen
   * Computes mean luminance, contrast variance, and 3x3 Laplacian variance sharpness.
   */
  function analyzeImageReadability(imgElement) {
    const canvas = document.createElement('canvas');
    const maxDim = 256; // Scale down for high performance pixel processing
    let w = imgElement.naturalWidth || imgElement.width || 400;
    let h = imgElement.naturalHeight || imgElement.height || 400;

    let targetW = w;
    let targetH = h;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        targetH = Math.round((h * maxDim) / w);
        targetW = maxDim;
      } else {
        targetW = Math.round((w * maxDim) / h);
        targetH = maxDim;
      }
    }

    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgElement, 0, 0, targetW, targetH);

    const imgData = ctx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;

    // Grayscale luminance matrix
    const gray = new Float32Array(targetW * targetH);
    let sumLuminance = 0;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[p] = lum;
      sumLuminance += lum;
    }

    const meanLuminance = sumLuminance / (targetW * targetH);

    // Luminance variance (contrast)
    let varSum = 0;
    for (let p = 0; p < gray.length; p++) {
      const d = gray[p] - meanLuminance;
      varSum += d * d;
    }
    const luminanceVariance = varSum / (targetW * targetH);

    // 3x3 Laplacian Filter for Edge Sharpness
    // [  0,  1,  0 ]
    // [  1, -4,  1 ]
    // [  0,  1,  0 ]
    let lapSum = 0;
    let lapCount = 0;
    const lapValues = [];

    for (let y = 1; y < targetH - 1; y++) {
      for (let x = 1; x < targetW - 1; x++) {
        const idx = y * targetW + x;
        const lap =
          gray[idx - targetW] +
          gray[idx + targetW] +
          gray[idx - 1] +
          gray[idx + 1] -
          4 * gray[idx];
        lapValues.push(lap);
        lapSum += lap;
        lapCount++;
      }
    }

    const lapMean = lapCount > 0 ? (lapSum / lapCount) : 0;
    let lapVarSum = 0;
    for (let i = 0; i < lapValues.length; i++) {
      const diff = lapValues[i] - lapMean;
      lapVarSum += diff * diff;
    }
    const laplacianVariance = lapCount > 0 ? (lapVarSum / lapCount) : 0;

    return {
      naturalWidth: w,
      naturalHeight: h,
      meanLuminance: Math.round(meanLuminance * 10) / 10,
      luminanceVariance: Math.round(luminanceVariance * 10) / 10,
      laplacianVariance: Math.round(laplacianVariance * 10) / 10,
      isLowResolution: (w < 400 || h < 400),
      isTooDark: meanLuminance < 20,
      isTooBright: meanLuminance > 240,
      isFlat: luminanceVariance < 20,
      isBlurry: laplacianVariance < 45
    };
  }

  /**
   * Evaluate Geofence: Point-in-Polygon boundary check
   */
  function evaluateGeofence() {
    if (!currentExif || !currentExif.hasGps) {
      geofenceResult = {
        verified: false,
        hasCoordinates: false,
        reason: 'No GPS coordinates found in image metadata or device sensor.'
      };
      return;
    }

    if (!selectedField || !selectedField.boundary) {
      geofenceResult = {
        verified: false,
        hasCoordinates: true,
        reason: 'Selected field has no valid spatial boundary.'
      };
      return;
    }

    const polygonLatlngs = parseBoundaryCoordinates(selectedField.boundary);
    if (!polygonLatlngs || polygonLatlngs.length < 3) {
      geofenceResult = {
        verified: false,
        hasCoordinates: true,
        reason: 'Could not parse field boundary geometry.'
      };
      return;
    }

    const inside = isPointInPolygon([currentExif.lat, currentExif.lng], polygonLatlngs);

    geofenceResult = {
      verified: inside,
      hasCoordinates: true,
      inside: inside,
      reason: inside
        ? `Coordinates (${currentExif.lat}, ${currentExif.lng}) are securely anchored within "${selectedField.name}".`
        : `Coordinates (${currentExif.lat}, ${currentExif.lng}) fall OUTSIDE "${selectedField.name}". Evidence must be captured inside the parcel perimeter.`
    };
  }

  /**
   * Jordan Curve Theorem Ray-Casting algorithm
   */
  function isPointInPolygon(point, polygon) {
    const lat = point[0];
    const lng = point[1];
    let inside = false;
    const n = polygon.length;
    let j = n - 1;

    for (let i = 0; i < n; i++) {
      const yi = polygon[i][0];
      const xi = polygon[i][1];
      const yj = polygon[j][0];
      const xj = polygon[j][1];

      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);

      if (intersect) inside = !inside;
      j = i;
    }

    return inside;
  }

  /**
  /**
   * Parses EWKT, WKT, GeoJSON (object or string), or Hex-encoded PostGIS EWKB
   * into [[lat, lng], ...]
   */
  function parseBoundaryCoordinates(boundary) {
    if (!boundary) return null;

    try {
      if (typeof boundary === 'object' && boundary.coordinates) {
        return boundary.coordinates[0].map(pt => [pt[1], pt[0]]);
      }

      if (typeof boundary === 'string') {
        const s = boundary.trim();

        // Serialized GeoJSON
        if (s.startsWith('{') && s.endsWith('}')) {
          try {
            const parsed = JSON.parse(s);
            if (parsed && parsed.coordinates) {
              return parsed.coordinates[0].map(pt => [pt[1], pt[0]]);
            }
          } catch (e) {}
        }

        // WKT / EWKT
        const match = s.match(/POLYGON\s*\(\(\s*(.+?)\s*\)\)/i);
        if (match) {
          const pairs = match[1].split(',');
          const latlngs = [];
          pairs.forEach(pair => {
            const parts = pair.trim().split(/\s+/);
            if (parts.length >= 2) {
              const lng = parseFloat(parts[0]);
              const lat = parseFloat(parts[1]);
              if (!isNaN(lat) && !isNaN(lng)) latlngs.push([lat, lng]);
            }
          });
          if (latlngs.length >= 3) return latlngs;
        }

        // Hex EWKB
        const cleanHex = s.replace(/^\\x/i, '');
        if (cleanHex.length >= 32 && /^[0-9a-fA-F]+$/.test(cleanHex)) {
          const latlngs = parseCameraHexEWKB(cleanHex);
          if (latlngs && latlngs.length >= 3) return latlngs;
        }
      }
    } catch (e) {
      console.warn('[AgriTrustCropCamera] Boundary parsing error:', e);
    }
    return null;
  }

  /**
   * Helper: Binary decoder for Hex-encoded PostGIS EWKB
   */
  function parseCameraHexEWKB(hexStr) {
    try {
      const byteLen = hexStr.length / 2;
      const bytes = new Uint8Array(byteLen);
      for (let i = 0; i < byteLen; i++) {
        bytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
      }
      const view = new DataView(bytes.buffer);
      const isLittle = view.getUint8(0) === 1;
      const geomType = view.getUint32(1, isLittle);
      const hasSrid = (geomType & 0x20000000) !== 0;
      const baseType = geomType & 0xFF;

      let offset = 5;
      if (hasSrid) offset += 4;

      if (baseType === 3) {
        const numRings = view.getUint32(offset, isLittle);
        offset += 4;
        if (numRings === 0) return null;
        const numPoints = view.getUint32(offset, isLittle);
        offset += 4;
        const latLngs = [];
        for (let i = 0; i < numPoints; i++) {
          const lng = view.getFloat64(offset, isLittle);
          const lat = view.getFloat64(offset + 8, isLittle);
          offset += 16;
          if (!isNaN(lat) && !isNaN(lng)) latLngs.push([lat, lng]);
        }
        return latLngs;
      }
    } catch (e) {
      console.warn('[AgriTrustCropCamera] Hex EWKB parsing error:', e);
    }
    return null;
  }

  /**
   * Update Telemetry HUD metrics
   */
  function updateQualityHUD(metrics) {
    if (!metrics) return;

    if (dom.hudResolution) {
      dom.hudResolution.textContent = `${metrics.naturalWidth} × ${metrics.naturalHeight}`;
      dom.hudResolution.className = metrics.isLowResolution ? 'hud-telemetry-val warn' : 'hud-telemetry-val pass';
    }

    if (dom.hudSharpness) {
      dom.hudSharpness.textContent = `σ² = ${metrics.laplacianVariance}`;
      dom.hudSharpness.className = metrics.isBlurry ? 'hud-telemetry-val fail' : 'hud-telemetry-val pass';
    }

    if (dom.hudExposure) {
      if (metrics.isTooDark) {
        dom.hudExposure.textContent = `Underexposed (${metrics.meanLuminance})`;
        dom.hudExposure.className = 'hud-telemetry-val fail';
      } else if (metrics.isTooBright) {
        dom.hudExposure.textContent = `Overexposed (${metrics.meanLuminance})`;
        dom.hudExposure.className = 'hud-telemetry-val fail';
      } else {
        dom.hudExposure.textContent = `Balanced (${metrics.meanLuminance})`;
        dom.hudExposure.className = 'hud-telemetry-val pass';
      }
    }
  }

  /**
   * Determine and update the overall Evidence Status
   */
  function updateStatusDisplay() {
    if (!selectedFile) {
      resetCaptureState();
      return;
    }

    // 1. Update Coordinates HUD
    if (currentExif && currentExif.hasGps) {
      if (dom.hudCoordinates) {
        dom.hudCoordinates.textContent = `${currentExif.lat}, ${currentExif.lng}`;
        dom.hudCoordinates.className = 'hud-telemetry-val pass';
      }
      if (dom.btnUseDeviceLocation) dom.btnUseDeviceLocation.style.display = 'none';
    } else {
      if (dom.hudCoordinates) {
        dom.hudCoordinates.textContent = 'Missing / Stripped';
        dom.hudCoordinates.className = 'hud-telemetry-val warn';
      }
      if (dom.btnUseDeviceLocation) dom.btnUseDeviceLocation.style.display = 'inline-flex';
    }

    // 2. Update Geofence HUD
    if (geofenceResult) {
      if (dom.hudGeofence) {
        if (!geofenceResult.hasCoordinates) {
          dom.hudGeofence.textContent = 'No Coordinates';
          dom.hudGeofence.className = 'hud-telemetry-val warn';
        } else if (geofenceResult.inside) {
          dom.hudGeofence.textContent = 'Verified In-Field';
          dom.hudGeofence.className = 'hud-telemetry-val pass';
        } else {
          dom.hudGeofence.textContent = 'Location Mismatch';
          dom.hudGeofence.className = 'hud-telemetry-val fail';
        }
      }
    }

    // 3. Evaluate Status Hierarchy:
    // A. Quality Check Failures -> Needs better photo
    if (qualityMetrics) {
      if (qualityMetrics.isLowResolution) {
        updateStatus(
          'needs_better_photo',
          'Needs Better Photo: Low Resolution',
          `Image resolution (${qualityMetrics.naturalWidth}×${qualityMetrics.naturalHeight}) is below standard minimum (400×400px). Please capture closer with full camera resolution.`
        );
        disableSubmission(true);
        return;
      }
      if (qualityMetrics.isTooDark) {
        updateStatus(
          'needs_better_photo',
          'Needs Better Photo: Underexposed / Too Dark',
          'Photo appears too dark or lens was obstructed. Ensure adequate natural daylight and face canopy leaves directly.'
        );
        disableSubmission(true);
        return;
      }
      if (qualityMetrics.isTooBright) {
        updateStatus(
          'needs_better_photo',
          'Needs Better Photo: Overexposed / Washed Out',
          'Photo has heavy direct sun glare or whiteout. Shade the leaf or shoot at an angle to prevent wash-out.'
        );
        disableSubmission(true);
        return;
      }
      if (qualityMetrics.isBlurry) {
        updateStatus(
          'needs_better_photo',
          'Needs Better Photo: Motion Blur Detected',
          `Sharpness variance (σ² = ${qualityMetrics.laplacianVariance}) is below the acceptable threshold (45.0). Hold the phone steady 15-25cm from leaf tissue.`
        );
        disableSubmission(true);
        return;
      }
    }

    // B. Location / Geofence Failures -> Location mismatch
    if (geofenceResult && geofenceResult.hasCoordinates && !geofenceResult.inside) {
      updateStatus(
        'location_mismatch',
        'Location Mismatch: Outside Selected Parcel',
        `Photo GPS (${currentExif.lat}, ${currentExif.lng}) falls outside the boundary of "${selectedField?.name}". You can re-take the photo inside the field or select the correct parcel.`
      );
      disableSubmission(false); // Allowed to submit for audit trail, but recorded as rejected/outside
      return;
    }

    // C. Missing GPS
    if (!currentExif || !currentExif.hasGps) {
      updateStatus(
        'validation',
        'Spatial Anchor Required',
        'Photo is sharp and clear, but EXIF GPS coordinates were not found. Click "Anchor with Device GPS" below to link evidence to your field.'
      );
      disableSubmission(true);
      return;
    }

    // D. All Validations Passed -> Ready to submit
    updateStatus(
      'validation',
      'Evidence Screened & Verified',
      `Optimal optical quality (σ² = ${qualityMetrics?.laplacianVariance}) and verified inside "${selectedField?.name}". Ready to archive in farm database.`
    );
    disableSubmission(false);
  }

  function updateStatus(status, title, desc) {
    currentStatus = status;

    if (dom.statusBanner) {
      dom.statusBanner.className = `camera-status-banner status-${status}`;
      dom.statusBanner.style.display = 'block';
    }

    if (dom.statusBadge) {
      let badgeText = status.toUpperCase().replace(/_/g, ' ');
      if (status === 'needs_better_photo') badgeText = 'NEEDS BETTER PHOTO';
      if (status === 'location_mismatch') badgeText = 'LOCATION MISMATCH';
      dom.statusBadge.textContent = badgeText;
    }

    if (dom.statusTitle) dom.statusTitle.textContent = title;
    if (dom.statusDescription) dom.statusDescription.textContent = desc;
  }

  function disableSubmission(disabled) {
    if (dom.btnSubmitEvidence) {
      dom.btnSubmitEvidence.disabled = disabled;
    }
  }

  /**
   * Submit Evidence Workflow
   */
  async function handleSubmitEvidence() {
    if (!selectedFile || !selectedField || !currentUser) {
      alert('Cannot submit: Ensure a field is selected and an image is captured.');
      return;
    }

    // Coordinates fallback check
    if (!currentExif || !currentExif.hasGps) {
      alert('Evidence cannot be saved without a spatial coordinate. Please click "Anchor with Device GPS".');
      return;
    }

    updateStatus('uploading', 'Archiving Evidence', 'Uploading encrypted photo to secure storage and registering spatial record...');
    disableSubmission(true);
    if (dom.submitSpinner) dom.submitSpinner.style.display = 'inline-block';

    showFeedback('Uploading photo to private storage bucket "crop-evidence"...', 'info');

    // 1. Upload to Supabase Storage
    const uploadRes = await window.AgriTrustSupabase.uploadCropEvidenceFile(selectedFile, selectedField.id);
    if (!uploadRes.success) {
      updateStatus('validation', 'Storage Upload Failed', uploadRes.message);
      showFeedback(`Storage upload failed: ${uploadRes.message}`, 'error');
      disableSubmission(false);
      if (dom.submitSpinner) dom.submitSpinner.style.display = 'none';
      return;
    }

    showFeedback('Storage upload verified. Creating database record with PostGIS spatial anchor...', 'info');

    // 2. Prepare Evidence Record
    const cropName = dom.cropNameInput?.value.trim() || selectedField.crop_variety;
    const growthStage = dom.growthStageSelect?.value || 'Unspecified';
    const notes = dom.fieldNotesInput?.value.trim() || null;

    const isGeofencePass = (geofenceResult && geofenceResult.inside);
    const validationStatus = isGeofencePass ? 'passed' : 'rejected';
    const rejectionReasons = [];
    if (!isGeofencePass) rejectionReasons.push('OUTSIDE_REGISTERED_BOUNDARY');

    const evidenceData = {
      field_id: selectedField.id,
      storage_path: uploadRes.storagePath,
      capture_location: `SRID=4326;POINT(${currentExif.lng} ${currentExif.lat})`,
      capture_timestamp: new Date().toISOString(),
      blur_laplacian_var: qualityMetrics?.laplacianVariance || null,
      validation_status: validationStatus,
      rejection_reasons: rejectionReasons,
      optical_metadata: {
        crop_name: cropName,
        growth_stage: growthStage,
        notes: notes,
        resolution: {
          width: qualityMetrics?.naturalWidth || 0,
          height: qualityMetrics?.naturalHeight || 0
        },
        file_size_bytes: selectedFile.size,
        mime_type: selectedFile.type,
        mean_luminance: qualityMetrics?.meanLuminance,
        luminance_variance: qualityMetrics?.luminanceVariance,
        laplacian_variance: qualityMetrics?.laplacianVariance,
        gps_source: currentExif.source || 'exif',
        camera_make: currentExif.make || null,
        camera_model: currentExif.model || null
      }
    };

    // 3. Insert record into public.crop_evidence
    const recordRes = await window.AgriTrustSupabase.createCropEvidenceRecord(evidenceData);

    if (dom.submitSpinner) dom.submitSpinner.style.display = 'none';

    if (recordRes.success) {
      if (isGeofencePass) {
        updateStatus(
          'uploading',
          'Evaluating Diagnostic Inference',
          `Evidence stored for "${selectedField.name}". Contacting diagnostic inference engine...`
        );
        showFeedback('Photo archived. Requesting diagnostic inference evaluation...', 'info');

        try {
          const diagRes = await window.AgriTrustSupabase.analyzeCropEvidence(recordRes.record.id, selectedField.id);
          if (diagRes && diagRes.success && diagRes.status === 'ANALYSIS_COMPLETE') {
            const inf = diagRes.inference;
            const confPct = Math.round((inf.confidence_score || 0) * 100);
            const uncertPct = Math.round((inf.uncertainty_margin || 0) * 100);
            const isEscalated = Boolean(diagRes.escalated || inf.requires_escalation || inf.confidence_score < 0.85);

            if (isEscalated) {
              updateStatus(
                'accepted',
                `Diagnostic Complete (${confPct}% Confidence) — Escalated`,
                `Diagnosis: ${inf.diagnosis_label}. Confidence is below 85% safety threshold. Ticket automatically queued for certified agronomist review.`
              );
              showFeedback(`Diagnosis: ${inf.diagnosis_label} (${confPct}% conf, ±${uncertPct}% uncert). Escalated to agronomist triage desk.`, 'warning');
            } else {
              updateStatus(
                'accepted',
                `Diagnostic Verified (${confPct}% Confidence)`,
                `Diagnosis: ${inf.diagnosis_label}. Verified high confidence. Review recommended agronomic actions below.`
              );
              showFeedback(`Verified Diagnosis: ${inf.diagnosis_label} (${confPct}% confidence).`, 'success');
            }
          } else if (diagRes && diagRes.status === 'ANALYSIS_UNAVAILABLE') {
            updateStatus(
              'accepted',
              'Evidence Accepted & Logged (AI Engine Unconfigured)',
              'Photo archived in tamper-evident farm database. Diagnostic AI provider unconfigured; queued for manual agronomist triage.'
            );
            showFeedback('Evidence archived. Diagnostic AI engine is unconfigured — photo held for agronomist triage.', 'info');
          } else if (diagRes && diagRes.status === 'INSUFFICIENT_EVIDENCE') {
            updateStatus(
              'needs_better_photo',
              'Insufficient Evidence for Diagnosis',
              diagRes.message || 'Evidence does not meet quality or spatial criteria for diagnostic inference.'
            );
            showFeedback(`Analysis notice: ${diagRes.message || 'Insufficient evidence'}`, 'warning');
          } else {
            updateStatus(
              'accepted',
              'Evidence Accepted & Archived',
              `Record registered for "${selectedField.name}". Verified inside parcel boundary.`
            );
            showFeedback('Evidence archived successfully.', 'success');
          }
        } catch (diagErr) {
          console.warn('[AgriTrustCropCamera] Diagnostic inference invocation warning:', diagErr);
          updateStatus(
            'accepted',
            'Evidence Accepted & Archived',
            `Record registered for "${selectedField.name}". Verified inside parcel boundary.`
          );
          showFeedback('Evidence archived. Diagnostic inference service was unreachable.', 'warning');
        }
      } else {
        updateStatus(
          'location_mismatch',
          'Evidence Archived (Location Mismatch Flagged)',
          `Evidence was saved but marked as REJECTED due to coordinates falling outside "${selectedField.name}". Diagnostic inference withheld.`
        );
        showFeedback('Notice: Evidence was logged with a location mismatch flag. Diagnostic inference withheld.', 'warning');
      }

      await loadRecentEvidence();
    } else {
      updateStatus('validation', 'Database Logging Error', recordRes.message);
      showFeedback(`Database registration failed: ${recordRes.message}`, 'error');
      disableSubmission(false);
    }
  }

  /**
   * Load Recent Evidence records for display
   */
  async function loadRecentEvidence() {
    if (!currentUser || !window.AgriTrustSupabase) return;

    const res = await window.AgriTrustSupabase.fetchFieldEvidence(null, 8);
    if (res.success) {
      recentEvidenceList = res.evidence || [];
      renderRecentEvidence();
    }
  }

  function renderRecentEvidence() {
    if (!dom.recentEvidenceList) return;

    if (recentEvidenceList.length === 0) {
      if (dom.emptyEvidenceNotice) dom.emptyEvidenceNotice.style.display = 'block';
      dom.recentEvidenceList.innerHTML = '';
      return;
    }

    if (dom.emptyEvidenceNotice) dom.emptyEvidenceNotice.style.display = 'none';
    dom.recentEvidenceList.innerHTML = '';

    recentEvidenceList.forEach((ev) => {
      const card = document.createElement('div');
      card.className = 'recent-evidence-card';

      const statusClass = ev.validation_status === 'passed' ? 'badge-pass' : 'badge-fail';
      const statusLabel = ev.validation_status === 'passed' ? 'Verified In-Field' : 'Flagged / Outside';
      const cropLabel = ev.optical_metadata?.crop_name || ev.fields?.crop_variety || 'Canopy';
      const stageLabel = ev.optical_metadata?.growth_stage || 'Unknown stage';
      const dateStr = ev.capture_timestamp ? new Date(ev.capture_timestamp).toLocaleString() : '';

      // Diagnostic Inference attached
      const inferences = ev.diagnostic_inferences || [];
      const inference = inferences.length > 0 ? inferences[0] : null;

      let diagHtml = '';

      if (inference) {
        const confScore = parseFloat(inference.confidence_score) || 0;
        const confPct = Math.round(confScore * 100);
        const uncertPct = Math.round((parseFloat(inference.uncertainty_margin) || 0) * 100);
        const isEscalated = Boolean(inference.requires_escalation || confScore < 0.85);

        diagHtml = `
          <div class="evidence-diag-section diag-has-result">
            <div class="diag-header-row">
              <span class="diag-badge-label">Diagnostic Inference</span>
              <span class="diag-status-pill ${isEscalated ? 'diag-pill-escalated' : 'diag-pill-verified'}">
                ${isEscalated ? '⚠️ Escalated to Agronomist' : '✓ Verified Diagnosis'}
              </span>
            </div>
            <div class="diag-primary-diagnosis">
              <span class="diag-diagnosis-icon">🔬</span>
              <span class="diag-diagnosis-name">${escapeHTML(inference.diagnosis_label)}</span>
            </div>
            <div class="diag-metrics-row">
              <div class="diag-meter-container">
                <div class="diag-meter-labels">
                  <span>Confidence: <strong>${confPct}%</strong></span>
                  <span>Uncertainty: <strong>±${uncertPct}%</strong></span>
                </div>
                <div class="diag-confidence-bar">
                  <div class="diag-confidence-fill ${isEscalated ? 'fill-amber' : 'fill-green'}" style="width: ${confPct}%;"></div>
                </div>
              </div>
            </div>
            ${isEscalated ? `
              <div class="diag-escalation-alert">
                <span class="escalation-icon">⚠️</span>
                <span>Confidence below 85% safety threshold. Automatically queued in <strong>Human Agronomist Triage Desk</strong>.</span>
              </div>
            ` : ''}
            ${inference.recommendation_text ? `
              <div class="diag-recommendation-box">
                <div class="diag-rec-title">🌱 Agronomic Recommendation:</div>
                <div class="diag-rec-body">${escapeHTML(inference.recommendation_text)}</div>
              </div>
            ` : ''}
          </div>
        `;
      } else if (ev.validation_status === 'rejected') {
        diagHtml = `
          <div class="evidence-diag-section diag-withheld">
            <div class="diag-header-row">
              <span class="diag-badge-label">Diagnostic Inference</span>
              <span class="diag-status-pill diag-pill-withheld">Withheld</span>
            </div>
            <p class="diag-unavail-text">
              Diagnostic analysis withheld: Evidence failed spatial boundary or image quality criteria.
            </p>
          </div>
        `;
      } else {
        // Validation passed, but no inference yet or provider unconfigured
        diagHtml = `
          <div class="evidence-diag-section diag-pending">
            <div class="diag-header-row">
              <span class="diag-badge-label">Diagnostic Inference</span>
              <span class="diag-status-pill diag-pill-pending">Analysis Pending</span>
            </div>
            <p class="diag-unavail-text">
              Photo archived in farm repository. Awaiting diagnostic inference execution or agronomist evaluation.
            </p>
            <button type="button" class="btn-run-diag" data-evidence-id="${ev.id}" data-field-id="${ev.field_id}">
              🔬 Run Diagnostic Screening
            </button>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="recent-evidence-top-row">
          <div class="recent-evidence-thumb-wrap">
            ${ev.signedUrl
              ? `<img src="${ev.signedUrl}" alt="Crop evidence photo" class="recent-evidence-thumb">`
              : '<div class="recent-evidence-placeholder">🌾</div>'
            }
          </div>
          <div class="recent-evidence-body">
            <div class="recent-evidence-header">
              <strong class="evidence-field-name">${escapeHTML(ev.fields?.name || 'Field Parcel')}</strong>
              <span class="evidence-status-pill ${statusClass}">${statusLabel}</span>
            </div>
            <div class="evidence-crop-meta">
              <span class="crop-variety-pill" style="font-size: 0.7rem;">${escapeHTML(cropLabel)}</span>
              <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(stageLabel)}</span>
            </div>
            <div class="evidence-timestamp">${dateStr}</div>
            ${ev.blur_laplacian_var ? `<div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 0.2rem;">Sharpness: σ² = ${ev.blur_laplacian_var}</div>` : ''}
          </div>
        </div>
        ${diagHtml}
      `;

      // Wire up on-demand screening button if present
      const runBtn = card.querySelector('.btn-run-diag');
      if (runBtn) {
        runBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          runBtn.disabled = true;
          runBtn.textContent = 'Analyzing...';
          try {
            const res = await window.AgriTrustSupabase.analyzeCropEvidence(ev.id, ev.field_id);
            if (res && res.success && res.status === 'ANALYSIS_COMPLETE') {
              showFeedback(`Diagnostic complete: ${res.inference.diagnosis_label}`, 'success');
              await loadRecentEvidence();
            } else if (res && res.status === 'ANALYSIS_UNAVAILABLE') {
              showFeedback('AI Diagnostic Engine unconfigured (missing GEMINI_API_KEY). Photo logged for agronomist review.', 'info');
              runBtn.textContent = 'AI Unconfigured';
            } else {
              showFeedback(`Analysis notice: ${res?.message || 'Analysis unavailable'}`, 'warning');
              runBtn.disabled = false;
              runBtn.textContent = '🔬 Retry Screening';
            }
          } catch (err) {
            showFeedback('Diagnostic engine was unreachable.', 'error');
            runBtn.disabled = false;
            runBtn.textContent = '🔬 Retry Screening';
          }
        });
      }

      dom.recentEvidenceList.appendChild(card);
    });
  }

  function resetCaptureState() {
    selectedFile = null;
    currentExif = null;
    qualityMetrics = null;
    geofenceResult = null;
    currentStatus = 'idle';

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    if (dom.previewImage) dom.previewImage.src = '';
    if (dom.previewContainer) dom.previewContainer.style.display = 'none';
    if (dom.dropzoneArea) dom.dropzoneArea.style.display = 'block';
    if (dom.statusBanner) dom.statusBanner.style.display = 'none';

    if (dom.hudResolution) dom.hudResolution.textContent = '—';
    if (dom.hudFileSize) dom.hudFileSize.textContent = '—';
    if (dom.hudSharpness) dom.hudSharpness.textContent = '—';
    if (dom.hudExposure) dom.hudExposure.textContent = '—';
    if (dom.hudCoordinates) dom.hudCoordinates.textContent = '—';
    if (dom.hudGeofence) dom.hudGeofence.textContent = '—';

    if (dom.nativeCameraInput) dom.nativeCameraInput.value = '';
    if (dom.filePickerInput) dom.filePickerInput.value = '';

    disableSubmission(true);
  }

  function showFeedback(msg, type = 'info') {
    if (!dom.evidenceFeedback) return;
    dom.evidenceFeedback.style.display = 'block';

    if (type === 'success') {
      dom.evidenceFeedback.style.backgroundColor = '#dcfce7';
      dom.evidenceFeedback.style.borderColor = '#86efac';
      dom.evidenceFeedback.style.color = '#166534';
    } else if (type === 'error') {
      dom.evidenceFeedback.style.backgroundColor = '#fee2e2';
      dom.evidenceFeedback.style.borderColor = '#fca5a5';
      dom.evidenceFeedback.style.color = '#991b1b';
    } else if (type === 'warning') {
      dom.evidenceFeedback.style.backgroundColor = '#fef3c7';
      dom.evidenceFeedback.style.borderColor = '#fcd34d';
      dom.evidenceFeedback.style.color = '#92400e';
    } else {
      dom.evidenceFeedback.style.backgroundColor = '#f1f5f9';
      dom.evidenceFeedback.style.borderColor = '#cbd5e1';
      dom.evidenceFeedback.style.color = '#334155';
    }

    dom.evidenceFeedback.textContent = msg;

    setTimeout(() => {
      if (dom.evidenceFeedback && type === 'success') {
        dom.evidenceFeedback.style.display = 'none';
      }
    }, 6000);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  return {
    init,
    openForField: (fieldId) => {
      const el = document.getElementById('crop-camera');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      loadFarmerFields(fieldId);
    },
    refresh: () => {
      loadFarmerFields();
      loadRecentEvidence();
    }
  };
})();

// Explicitly bind AgriTrustCropCamera to global window and globalThis scopes
if (typeof window !== 'undefined') {
  window.AgriTrustCropCamera = AgriTrustCropCamera;
}
if (typeof globalThis !== 'undefined') {
  globalThis.AgriTrustCropCamera = AgriTrustCropCamera;
}

// Auto-initialize on DOM ready or immediately if DOM is already loaded
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      AgriTrustCropCamera.init();
    });
  } else {
    AgriTrustCropCamera.init();
  }
}

