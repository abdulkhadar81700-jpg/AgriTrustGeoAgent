/**
 * AgriTrustGeoAgent - Interactive Field Parcel Boundary Manager
 * High-resolution satellite mapping, touch-friendly polygon drawing/editing,
 * real-time WGS84 geodesic area calculations, self-intersection validation,
 * and PostGIS EWKT serialization for Supabase PostgreSQL.
 */

const AgriTrustFieldManager = (() => {
  // State variables
  let map = null;
  let activeBasemap = 'satellite';
  let satelliteLayer = null;
  let streetLayer = null;
  let labelsLayer = null;

  // Drawing state machine: 'IDLE' | 'DRAWING' | 'CLOSED'
  let drawState = 'IDLE';
  let vertices = [];        // Array of { lat, lng }
  let vertexMarkers = [];   // Array of L.marker
  let previewPolyline = null; // L.polyline while drawing
  let polygonLayer = null;  // L.polygon when closed
  let existingFieldsLayers = null; // L.layerGroup for saved fields (initialized in initMap)
  let savedFieldsMap = {};  // Map of fieldId -> { field, poly }
  let editingFieldId = null; // null for new field, or UUID if editing existing field

  // Google Maps-style location tracking & fullscreen state
  let currentGpsMarker = null; // L.marker for current GPS position
  let currentAccuracyCircle = null; // L.circle for GPS accuracy radius
  let currentGpsPosition = null; // { lat, lng, accuracy, timestamp, address, coords, tier, source }
  let isFullscreen = false;
  let watchId = null; // Geolocation watchPosition listener ID
  let isTracking = false; // Whether continuous watch is active
  let isSamplingAccuracy = false; // Whether multi-sample convergence engine is active
  let bestPosition = null; // Best position encountered during sampling or session
  let externalGnssProvider = null; // Hook for external Bluetooth / USB / RTK GNSS receiver

  // DOM Elements cache
  let elements = {};

  /**
   * Initializes the Field Manager module.
   */
  function init() {
    cacheDOMElements();
    if (typeof L === 'undefined') {
      console.warn('[AgriTrustFieldManager] Leaflet (L) is not loaded yet. Retrying in 100ms...');
      setTimeout(init, 100);
      return;
    }
    if (!elements.mapContainer) {
      console.warn('[AgriTrustFieldManager] Map container #fieldMap not found in DOM.');
      return;
    }

    initMap();
    bindUIEvents();
    checkAuthState();

    // Listen for auth changes to refresh fields
    if (window.AgriTrustSupabase && window.AgriTrustSupabase.onAuthStateChange) {
      window.AgriTrustSupabase.onAuthStateChange((event, session) => {
        checkAuthState();
      });
    }

    // Listen for Supabase initialization readiness
    window.addEventListener('agritrust:supabaseReady', () => {
      checkAuthState();
    });
  }

  function cacheDOMElements() {
    elements = {
      mapWrapper: document.getElementById('fieldMapWrapper'),
      mapContainer: document.getElementById('fieldMap'),
      startDrawBtn: document.getElementById('btnStartDraw'),
      undoPointBtn: document.getElementById('btnUndoPoint'),
      clearPolyBtn: document.getElementById('btnClearPoly'),
      locateGpsBtn: document.getElementById('btnLocateGps'),
      basemapToggleBtn: document.getElementById('btnToggleBasemap'),
      fullscreenBtn: document.getElementById('btnToggleFullscreen'),
      locationCard: document.getElementById('fieldLocationCard'),
      closeLocationCardBtn: document.getElementById('btnCloseLocationCard'),
      locPrimaryPlace: document.getElementById('locPrimaryPlace'),
      locSubPlace: document.getElementById('locSubPlace'),
      locDistrict: document.getElementById('locDistrict'),
      locRegion: document.getElementById('locRegion'),
      locCoords: document.getElementById('locCoords'),
      locAccuracy: document.getElementById('locAccuracy'),
      locAccuracyTier: document.getElementById('locAccuracyTier'),
      locSource: document.getElementById('locSource'),
      locGnssTelemetry: document.getElementById('locGnssTelemetry'),
      locAltitude: document.getElementById('locAltitude'),
      locSpeed: document.getElementById('locSpeed'),
      locHeading: document.getElementById('locHeading'),
      locAccuracyWarning: document.getElementById('locAccuracyWarning'),
      locAccuracyWarningText: document.getElementById('locAccuracyWarningText'),
      locTrackingStatus: document.getElementById('locTrackingStatus'),
      btnImproveAccuracy: document.getElementById('btnImproveAccuracy'),
      improveBtnText: document.getElementById('improveBtnText'),
      manualJumpBtn: document.getElementById('btnManualJump'),
      coordJumpBtnText: document.getElementById('coordJumpBtnText'),
      coordInput: document.getElementById('manualCoordInput'),
      saveFieldForm: document.getElementById('fieldRegistrationForm'),
      saveFieldBtn: document.getElementById('btnSaveField'),
      feedbackBox: document.getElementById('fieldValidationNotice'),
      telemetryAreaAcres: document.getElementById('hudAreaAcres'),
      telemetryAreaHa: document.getElementById('hudAreaHa'),
      telemetryPoints: document.getElementById('hudPointCount'),
      telemetryValidity: document.getElementById('hudValidityBadge'),
      fieldNameInput: document.getElementById('fieldName'),
      cropVarietyInput: document.getElementById('cropVariety'),
      plantingDateInput: document.getElementById('plantingDate'),
      soilTextureSelect: document.getElementById('soilTexture'),
      fieldAcreageInput: document.getElementById('fieldAcreage'),
      registeredFieldsList: document.getElementById('registeredFieldsList'),
      authGateNotice: document.getElementById('fieldAuthGateNotice')
    };
  }

  /**
   * Initialize Leaflet Map with Esri World Imagery (High-Res Satellite) and OpenStreetMap
   */
  function initMap() {
    if (map) return;

    // Default view: Central Agricultural Belt fallback (coordinates 20.5937, 78.9629 or Kansas 38.5, -98.0)
    map = L.map('fieldMap', {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: false,
      attributionControl: true
    });

    // Reposition zoom controls to top-right for mobile convenience
    L.control.zoom({ position: 'topright' }).addTo(map);

    // High-Resolution Satellite Layer (Esri World Imagery)
    satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
    }).addTo(map);

    // Hybrid Borders & Roads Overlay
    labelsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      opacity: 0.8
    }).addTo(map);

    // OpenStreetMap Street/Topo Fallback Layer
    streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    });

    // Layer group for saved fields
    if (!existingFieldsLayers) {
      existingFieldsLayers = L.layerGroup();
    }
    existingFieldsLayers.addTo(map);

    // Map click handler for drawing
    map.on('click', handleMapClick);

    // Invalidate size on container resize
    setTimeout(() => {
      map.invalidateSize();
    }, 400);
  }

  /**
   * Bind event listeners for UI buttons
   */
  function bindUIEvents() {
    if (elements.startDrawBtn) {
      elements.startDrawBtn.addEventListener('click', toggleDrawingState);
    }
    if (elements.undoPointBtn) {
      elements.undoPointBtn.addEventListener('click', undoLastPoint);
    }
    if (elements.clearPolyBtn) {
      elements.clearPolyBtn.addEventListener('click', resetDrawing);
    }
    if (elements.locateGpsBtn) {
      elements.locateGpsBtn.addEventListener('click', handleExplicitGeolocation);
    }
    if (elements.basemapToggleBtn) {
      elements.basemapToggleBtn.addEventListener('click', toggleBasemap);
    }
    if (elements.fullscreenBtn) {
      elements.fullscreenBtn.addEventListener('click', toggleFullscreen);
    }
    if (elements.closeLocationCardBtn) {
      elements.closeLocationCardBtn.addEventListener('click', () => {
        if (elements.locationCard) elements.locationCard.style.display = 'none';
      });
    }
    if (elements.btnImproveAccuracy) {
      elements.btnImproveAccuracy.addEventListener('click', improveLocationAccuracy);
    }
    if (elements.manualJumpBtn) {
      elements.manualJumpBtn.addEventListener('click', handleUniversalSearch);
    }
    if (elements.coordInput) {
      elements.coordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleUniversalSearch();
        }
      });
    }
    if (elements.saveFieldForm) {
      elements.saveFieldForm.addEventListener('submit', handleFieldFormSubmit);
    }

    // Handle ESC key or OS gestures exiting fullscreen
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && elements.mapWrapper) {
        elements.mapWrapper.classList.remove('map-fullscreen-active');
        isFullscreen = false;
        if (elements.fullscreenBtn) {
          elements.fullscreenBtn.innerHTML = `
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"/></svg>
            Fullscreen
          `;
        }
        if (map) map.invalidateSize();
      }
    });
  }

  /**
   * Check Auth status and load registered fields if logged in
   */
  async function checkAuthState() {
    if (window.AgriTrustSupabase && window.AgriTrustSupabase.ready) {
      await window.AgriTrustSupabase.ready();
    }

    if (!window.AgriTrustSupabase || !window.AgriTrustSupabase.isReady()) {
      showAuthGateNotice('Supabase is not configured yet. Configure local .env to enable remote parcel persistence.', 'warning');
      return;
    }

    const user = await window.AgriTrustSupabase.getUser();
    if (user) {
      showAuthGateNotice(`Authenticated as ${user.email}. Saved field parcels will be associated with your farm ID.`, 'success');
      loadRegisteredFields();
    } else {
      showAuthGateNotice('Drawing in preview mode. Sign In or Register to save your field boundaries into the cloud database.', 'info');
      if (elements.registeredFieldsList) {
        elements.registeredFieldsList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Sign in to view your saved parcels.</p>';
      }
    }
  }

  function showAuthGateNotice(message, type = 'info') {
    if (!elements.authGateNotice) return;
    elements.authGateNotice.style.display = 'block';
    if (type === 'success') {
      elements.authGateNotice.style.backgroundColor = '#dcfce7';
      elements.authGateNotice.style.borderColor = '#86efac';
      elements.authGateNotice.style.color = '#166534';
    } else if (type === 'warning') {
      elements.authGateNotice.style.backgroundColor = '#fef3c7';
      elements.authGateNotice.style.borderColor = '#fcd34d';
      elements.authGateNotice.style.color = '#92400e';
    } else {
      elements.authGateNotice.style.backgroundColor = '#f1f5f9';
      elements.authGateNotice.style.borderColor = '#cbd5e1';
      elements.authGateNotice.style.color = '#334155';
    }
    elements.authGateNotice.innerHTML = message;
  }

  /**
   * Basemap Switcher (Satellite vs Street)
   */
  function toggleBasemap() {
    if (activeBasemap === 'satellite') {
      map.removeLayer(satelliteLayer);
      map.removeLayer(labelsLayer);
      map.addLayer(streetLayer);
      activeBasemap = 'street';
      if (elements.basemapToggleBtn) {
        elements.basemapToggleBtn.innerHTML = `
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064"/></svg>
          Switch to Satellite
        `;
      }
    } else {
      map.removeLayer(streetLayer);
      map.addLayer(satelliteLayer);
      map.addLayer(labelsLayer);
      activeBasemap = 'satellite';
      if (elements.basemapToggleBtn) {
        elements.basemapToggleBtn.innerHTML = `
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
          Switch to Street
        `;
      }
    }
  }

  /**
   * Fullscreen Mode Toggle for expansive satellite drawing
   */
  function toggleFullscreen() {
    if (!elements.mapWrapper) return;

    if (!isFullscreen) {
      elements.mapWrapper.classList.add('map-fullscreen-active');
      if (elements.mapWrapper.requestFullscreen) {
        elements.mapWrapper.requestFullscreen().catch(() => {});
      }
      isFullscreen = true;
      if (elements.fullscreenBtn) {
        elements.fullscreenBtn.innerHTML = `
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          Exit Fullscreen
        `;
      }
    } else {
      if (document.exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      elements.mapWrapper.classList.remove('map-fullscreen-active');
      isFullscreen = false;
      if (elements.fullscreenBtn) {
        elements.fullscreenBtn.innerHTML = `
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"/></svg>
          Fullscreen
        `;
      }
    }

    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 200);
  }

  /**
   * Detects whether the current device is a mobile device with hardware sensors
   */
  function isMobileDevice() {
    if (typeof navigator !== 'undefined') {
      if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
        return navigator.userAgentData.mobile;
      }
      if (navigator.userAgent) {
        return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      }
    }
    return false;
  }

  /**
   * Classifies location accuracy into discrete standardized tiers:
   * - HIGH ACCURACY: <= 20m (True satellite GNSS lock)
   * - MODERATE ACCURACY: 21 - 50m (Good Wi-Fi or assisted GPS)
   * - LOW ACCURACY: > 50m (Cellular or ISP network positioning)
   */
  function classifyAccuracyTier(accuracy) {
    if (typeof accuracy !== 'number' || isNaN(accuracy) || accuracy <= 0) {
      return { tier: 'target', label: 'TARGET', colorClass: 'tier-moderate' };
    }
    if (accuracy <= 20) {
      return { tier: 'high', label: 'HIGH ACCURACY', colorClass: 'tier-high' };
    }
    if (accuracy <= 50) {
      return { tier: 'moderate', label: 'MODERATE ACCURACY', colorClass: 'tier-moderate' };
    }
    return { tier: 'low', label: 'LOW ACCURACY', colorClass: 'tier-low' };
  }

  /**
   * Classifies the actual physical location source without false claims.
   * Laptops without GNSS chips are never labeled as GPS.
   */
  function classifyLocationSource(accuracy, coords) {
    if (externalGnssProvider) {
      return 'External GNSS Receiver (RTK / Bluetooth / USB)';
    }

    const isMobile = isMobileDevice();

    if (isMobile) {
      if (accuracy <= 20) {
        return 'Device GPS / Satellite GNSS (Hardware Receiver)';
      }
      if (accuracy <= 50) {
        return 'Device GPS / Wi-Fi Assisted Positioning';
      }
      return 'Cellular / Network Positioning (Coarse Triangulation)';
    } else {
      // Laptop / Desktop environment - typically no satellite hardware
      if (accuracy <= 50) {
        return 'Wi-Fi Access Point Triangulation (802.11 BSSID)';
      }
      return 'Cellular / ISP Network Positioning (Coarse Network Lookup)';
    }
  }

  /**
   * Computes great-circle distance between two points on WGS84 sphere in meters
   */
  function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Real Reverse Geocoding Service (Multi-Tier)
   * Resolves Village/Locality, Mandal/Sub-district, District, State, Country from real coordinates.
   * Strictly avoids mock, fake, or invented data.
   */
  async function resolveGeographicLocation(lat, lng) {
    let details = {
      primaryPlace: null,
      subPlace: null,
      district: null,
      region: null,
      state: null,
      country: null,
      postcode: null,
      displayName: null,
      source: null
    };

    // Tier 1: OpenStreetMap Nominatim
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const res = await fetch(nomUrl, {
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.address) {
          const a = data.address;
          const village = a.village || a.hamlet || a.town || a.city_district || a.suburb || a.neighbourhood || a.city;
          const mandal = a.subdistrict || a.tehsil || a.taluk || a.county || a.mandal;
          const district = a.state_district || a.district;
          const state = a.state;
          const country = a.country || 'India';

          details.primaryPlace = village || (mandal ? `${mandal} Area` : (district ? `${district} Region` : null));
          details.subPlace = mandal || null;
          details.district = district || null;
          details.region = [state, country].filter(Boolean).join(', ') || null;
          details.state = state || null;
          details.country = country;
          details.postcode = a.postcode || null;
          details.displayName = data.display_name || null;
          details.source = 'OpenStreetMap';
          return details;
        }
      }
    } catch (err) {
      console.warn('[AgriTrustFieldManager] Nominatim reverse geocode error:', err);
    }

    // Tier 2: BigDataCloud Client Reverse Geocode Fallback
    try {
      const bdcUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
      const res = await fetch(bdcUrl);
      if (res.ok) {
        const data = await res.json();
        if (data) {
          const adminList = (data.localityInfo?.administrative || []).map(x => x.name);
          const village = data.locality || data.city || null;
          let mandal = null;
          let district = null;
          for (const item of adminList) {
            if (/mandal|tehsil|taluk/i.test(item) && !mandal) mandal = item;
            if (/district/i.test(item) && !district) district = item;
          }
          const state = data.principalSubdivision || null;
          const country = data.countryName || 'India';

          details.primaryPlace = village || (mandal ? `${mandal} Area` : (district ? `${district} Area` : null));
          details.subPlace = mandal || null;
          details.district = district || null;
          details.region = [state, country].filter(Boolean).join(', ') || null;
          details.state = state || null;
          details.country = country;
          details.postcode = data.postcode || null;
          details.source = 'BigDataCloud';
          return details;
        }
      }
    } catch (err) {
      console.warn('[AgriTrustFieldManager] BigDataCloud fallback reverse geocode error:', err);
    }

    return details;
  }

  /**
   * Render resolved geographic details into the dedicated Location Information Card
   */
  function updateLocationDisplay(lat, lng, accuracy, details, coords = null) {
    if (!elements.locationCard) return;

    elements.locationCard.style.display = 'block';

    const primaryText = details?.primaryPlace || (details?.subPlace ? `${details.subPlace} Area` : (details?.district ? `${details.district} Area` : 'Unmapped Agricultural Area'));
    const subText = details?.subPlace || (details?.district ? '' : 'Sub-district / Mandal');
    const districtText = details?.district || '';
    const regionText = details?.region || 'State, Country';

    if (elements.locPrimaryPlace) elements.locPrimaryPlace.textContent = primaryText;
    if (elements.locSubPlace) {
      if (details?.subPlace) {
        elements.locSubPlace.textContent = details.subPlace;
        elements.locSubPlace.style.display = 'block';
      } else {
        elements.locSubPlace.style.display = 'none';
      }
    }
    if (elements.locDistrict) {
      if (details?.district) {
        elements.locDistrict.textContent = details.district;
        elements.locDistrict.style.display = 'block';
      } else {
        elements.locDistrict.style.display = 'none';
      }
    }
    if (elements.locRegion) elements.locRegion.textContent = regionText;
    if (elements.locCoords) elements.locCoords.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    // Accuracy badge and tier pill
    const tierInfo = classifyAccuracyTier(accuracy);
    if (elements.locAccuracy) {
      if (accuracy > 0) {
        elements.locAccuracy.textContent = `±${accuracy} m`;
      } else {
        elements.locAccuracy.textContent = 'Target Point';
      }
    }

    if (elements.locAccuracyTier) {
      elements.locAccuracyTier.textContent = tierInfo.label;
      elements.locAccuracyTier.className = `accuracy-tier-pill ${tierInfo.colorClass}`;
    }

    // Location Source
    const sourceLabel = classifyLocationSource(accuracy, coords);
    if (elements.locSource) {
      elements.locSource.textContent = sourceLabel;
    }

    // Extended GNSS Telemetry (Altitude, Speed, Heading)
    if (coords && (
      (coords.altitude !== null && coords.altitude !== undefined) ||
      (coords.speed !== null && coords.speed !== undefined) ||
      (coords.heading !== null && coords.heading !== undefined)
    )) {
      if (elements.locGnssTelemetry) elements.locGnssTelemetry.style.display = 'flex';
      if (elements.locAltitude) {
        elements.locAltitude.innerHTML = (coords.altitude !== null && coords.altitude !== undefined)
          ? `<small>ALT:</small> ${coords.altitude.toFixed(1)}m`
          : `<small>ALT:</small> --`;
      }
      if (elements.locSpeed) {
        elements.locSpeed.innerHTML = (coords.speed !== null && coords.speed !== undefined)
          ? `<small>SPD:</small> ${(coords.speed * 3.6).toFixed(1)} km/h`
          : `<small>SPD:</small> --`;
      }
      if (elements.locHeading) {
        elements.locHeading.innerHTML = (coords.heading !== null && coords.heading !== undefined)
          ? `<small>HDG:</small> ${coords.heading.toFixed(0)}°`
          : `<small>HDG:</small> --`;
      }
    } else {
      if (elements.locGnssTelemetry) elements.locGnssTelemetry.style.display = 'none';
    }

    // Low Accuracy Advisory Warning
    if (elements.locAccuracyWarning) {
      if (accuracy > 50) {
        elements.locAccuracyWarning.style.display = 'block';
        if (elements.locAccuracyWarningText) {
          if (isMobileDevice()) {
            elements.locAccuracyWarningText.innerHTML = `
              Location accuracy is currently low (&plusmn;${accuracy}m) due to cellular network triangulation.
              For high satellite precision (&le;15m), step outdoors with clear sky view, verify GPS is enabled, and tap <strong>"Improve Location Accuracy"</strong>.
            `;
          } else {
            elements.locAccuracyWarningText.innerHTML = `
              Location accuracy is currently low (&plusmn;${accuracy}m). Laptops typically lack internal satellite GPS receivers and rely on Wi-Fi or coarse ISP network positioning.
              For high-precision field boundaries, open AgriTrust on your smartphone or use manual map navigation.
            `;
          }
        }
      } else {
        elements.locAccuracyWarning.style.display = 'none';
      }
    }
  }

  /**
   * Applies a new GPS/sensor reading to map layers, state, and UI.
   * Completely decoupled from field boundary polygon creation.
   */
  async function applyGpsReading(lat, lng, accuracy, timestamp, coords = null, shouldFlyTo = false) {
    const tier = classifyAccuracyTier(accuracy);
    const source = classifyLocationSource(accuracy, coords);

    currentGpsPosition = {
      lat,
      lng,
      accuracy,
      timestamp,
      coords,
      tier,
      source,
      address: currentGpsPosition?.address || null,
      lastGeocodedLat: currentGpsPosition?.lastGeocodedLat || null,
      lastGeocodedLng: currentGpsPosition?.lastGeocodedLng || null
    };

    if (!bestPosition || accuracy < bestPosition.accuracy) {
      bestPosition = currentGpsPosition;
    }

    // Update or add accuracy radius circle
    if (currentAccuracyCircle && map.hasLayer(currentAccuracyCircle)) {
      currentAccuracyCircle.setLatLng([lat, lng]);
      currentAccuracyCircle.setRadius(accuracy);
    } else {
      currentAccuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: '#1a73e8',
        weight: 1.5,
        opacity: 0.6,
        fillColor: '#1a73e8',
        fillOpacity: 0.12
      }).addTo(map);
    }

    // Update or add Google Maps-style blue location dot with radar pulse
    if (currentGpsMarker && map.hasLayer(currentGpsMarker)) {
      currentGpsMarker.setLatLng([lat, lng]);
    } else {
      const gpsIcon = L.divIcon({
        className: 'gps-location-container',
        html: '<div class="gps-pulse-ring"></div><div class="gps-blue-dot"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      currentGpsMarker = L.marker([lat, lng], {
        icon: gpsIcon,
        zIndexOffset: 1000
      }).addTo(map);
    }

    if (shouldFlyTo) {
      const targetZoom = accuracy > 100 ? 15 : (accuracy > 30 ? 16 : 17);
      map.flyTo([lat, lng], targetZoom, { duration: 1.5 });
    }

    // Reverse geocode if not yet resolved or if moved >50m from last geocoded position
    let details = currentGpsPosition.address;
    const needsGeocode = !details || (
      currentGpsPosition.lastGeocodedLat &&
      getDistanceFromLatLonInM(lat, lng, currentGpsPosition.lastGeocodedLat, currentGpsPosition.lastGeocodedLng) > 50
    );

    if (needsGeocode) {
      details = await resolveGeographicLocation(lat, lng);
      currentGpsPosition.address = details;
      currentGpsPosition.lastGeocodedLat = lat;
      currentGpsPosition.lastGeocodedLng = lng;
    }

    updateLocationDisplay(lat, lng, accuracy, details, coords);

    // Update marker popup with full hierarchy, tier, and source
    const placeTitle = details?.primaryPlace || 'Device Position';
    const placeSub = [details?.subPlace, details?.district, details?.region].filter(Boolean).join(' • ');

    currentGpsMarker.bindPopup(`
      <div style="font-family: inherit; font-size: 0.8125rem; min-width: 220px; line-height: 1.4;">
        <strong style="color: #1a73e8; font-size: 0.9rem;">📍 ${escapeHTML(placeTitle)}</strong><br>
        ${placeSub ? `<span style="font-size: 0.75rem; color: #475569;">${escapeHTML(placeSub)}</span><br>` : ''}
        <div style="margin-top: 0.35rem; font-size: 0.75rem; border-top: 1px solid #e2e8f0; padding-top: 0.25rem;">
          <strong>Coordinates:</strong> ${lat.toFixed(6)}, ${lng.toFixed(6)}<br>
          <strong>Accuracy:</strong> <span style="font-weight: 700;" class="${tier.colorClass}">&plusmn;${accuracy}m (${tier.label})</span><br>
          <strong>Source:</strong> <span style="color: #475569;">${escapeHTML(source)}</span>
          ${coords && coords.altitude !== null && coords.altitude !== undefined ? `<br><strong>Altitude:</strong> ${coords.altitude.toFixed(1)}m` : ''}
        </div>
        ${accuracy > 50 ? '<div style="color: #b91c1c; font-size: 0.7rem; margin-top: 0.25rem;">⚠️ Approximate fix. Move outdoors or zoom in to plot boundary.</div>' : ''}
      </div>
    `);

    return currentGpsPosition;
  }

  /**
   * High-Accuracy Device Geolocation with Continuous Watch Tracking
   */
  function handleExplicitGeolocation() {
    if (!navigator.geolocation) {
      showValidationMessage('Geolocation is not supported by your device or browser. You can navigate the map manually or search for your village.', 'warning');
      return;
    }

    if (elements.locateGpsBtn) {
      elements.locateGpsBtn.disabled = true;
      elements.locateGpsBtn.classList.add('loading');
      elements.locateGpsBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2" stroke-dasharray="32" stroke-dashoffset="16"/></svg>
        Acquiring GPS Fix...
      `;
    }

    showValidationMessage('Acquiring high-accuracy device location from hardware sensors...', 'info');

    // If already watching, clear existing watch
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    let initialFixReceived = false;

    watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = Math.round(pos.coords.accuracy);
        const timestamp = pos.timestamp;

        if (elements.locateGpsBtn) {
          elements.locateGpsBtn.disabled = false;
          elements.locateGpsBtn.classList.remove('loading');
          elements.locateGpsBtn.innerHTML = `
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" stroke-width="2"/><circle cx="12" cy="12" r="8" stroke-width="2"/></svg>
            Locate My Field (GPS)
          `;
        }

        isTracking = true;
        if (elements.locTrackingStatus) {
          elements.locTrackingStatus.style.display = 'inline-flex';
        }

        const isFirst = !initialFixReceived;
        initialFixReceived = true;

        await applyGpsReading(lat, lng, accuracy, timestamp, pos.coords, isFirst);

        if (isFirst) {
          if (accuracy > 50) {
            showValidationMessage(`Location detected (&plusmn;${accuracy}m accuracy, approximate). Center placed over ${currentGpsPosition.address?.primaryPlace || 'area'}. Laptops or cellular devices without active satellite lock may report network positioning. You can click "Improve Location Accuracy" or navigate manually.`, 'warning');
          } else {
            showValidationMessage(`High-precision GPS fix acquired (&plusmn;${accuracy}m). Center placed over ${currentGpsPosition.address?.primaryPlace || 'field'}. Click "Start Drawing Parcel" to outline boundary.`, 'success');
          }
        }
      },
      (err) => {
        if (elements.locateGpsBtn) {
          elements.locateGpsBtn.disabled = false;
          elements.locateGpsBtn.classList.remove('loading');
          elements.locateGpsBtn.innerHTML = `
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" stroke-width="2"/><circle cx="12" cy="12" r="8" stroke-width="2"/></svg>
            Locate My Field (GPS)
          `;
        }

        let errMsg = 'Location access failed.';
        if (err.code === 1) {
          errMsg = 'Location permission was denied in your browser settings. To enable: click the permissions/lock icon next to the address bar, allow Location access, and click "Locate My Field" again. You can also search for your village name below.';
        } else if (err.code === 2) {
          errMsg = 'GPS position is unavailable from your device sensors. Please ensure Location Services are switched on in your device settings.';
        } else if (err.code === 3) {
          errMsg = 'GPS request timed out. Please ensure you have network connectivity or clear sky visibility and try again.';
        }

        showValidationMessage(errMsg, 'warning');
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0
      }
    );
  }

  /**
   * Improve Location Accuracy Multi-Sample Convergence Engine
   * Samples successive position readings, retains the lowest uncertainty fix,
   * and reports realistic feedback based on device capabilities.
   */
  async function improveLocationAccuracy() {
    if (isSamplingAccuracy) return;
    if (!navigator.geolocation) {
      showValidationMessage('Geolocation is not supported by your browser.', 'warning');
      return;
    }

    isSamplingAccuracy = true;
    if (elements.btnImproveAccuracy) {
      elements.btnImproveAccuracy.disabled = true;
      elements.btnImproveAccuracy.classList.add('sampling');
    }
    if (elements.improveBtnText) {
      elements.improveBtnText.textContent = 'Sampling GPS signals...';
    }

    showValidationMessage('Sampling multiple device location updates to achieve the tightest satellite accuracy fix...', 'info');

    let samples = [];
    let initialAccuracy = currentGpsPosition ? currentGpsPosition.accuracy : 99999;
    let bestAcc = initialAccuracy;
    let bestPos = currentGpsPosition;

    let sampleWatchId = null;
    let timerId = null;

    const finalizeSampling = () => {
      if (sampleWatchId !== null) {
        navigator.geolocation.clearWatch(sampleWatchId);
        sampleWatchId = null;
      }
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }

      isSamplingAccuracy = false;
      if (elements.btnImproveAccuracy) {
        elements.btnImproveAccuracy.disabled = false;
        elements.btnImproveAccuracy.classList.remove('sampling');
      }
      if (elements.improveBtnText) {
        elements.improveBtnText.textContent = 'Improve Location Accuracy';
      }

      if (bestPos && bestPos !== currentGpsPosition) {
        applyGpsReading(bestPos.lat, bestPos.lng, bestPos.accuracy, bestPos.timestamp, bestPos.coords, true);
      }

      const isMobile = isMobileDevice();
      if (bestAcc < initialAccuracy) {
        showValidationMessage(`Location accuracy improved from &plusmn;${initialAccuracy}m to &plusmn;${bestAcc}m (${classifyLocationSource(bestAcc, bestPos?.coords)}). Map centered on refined position.`, 'success');
      } else if (bestAcc <= 20) {
        showValidationMessage(`High-precision GPS fix confirmed (&plusmn;${bestAcc}m). Ready for field boundary creation.`, 'success');
      } else {
        if (!isMobile) {
          showValidationMessage(`Sampling complete. Best fix available on this laptop is &plusmn;${bestAcc}m. Note: Laptops lack built-in satellite GPS hardware and use Wi-Fi/ISP network positioning. For &le;10m accuracy, access AgriTrust from a smartphone outdoors with GPS enabled.`, 'info');
        } else {
          showValidationMessage(`Sampling complete. Best fix: &plusmn;${bestAcc}m. For higher accuracy (&le;15m), ensure you are outdoors away from tall obstructions and that Google Location Accuracy / GPS is enabled.`, 'info');
        }
      }
    };

    // Watch position during sampling window
    sampleWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = Math.round(pos.coords.accuracy);
        const timestamp = pos.timestamp;

        samples.push({ lat, lng, accuracy, timestamp, coords: pos.coords });

        if (elements.improveBtnText) {
          elements.improveBtnText.textContent = `Sampling (${samples.length} fixes, best: ±${Math.min(bestAcc, accuracy)}m)...`;
        }

        if (accuracy < bestAcc) {
          bestAcc = accuracy;
          bestPos = { lat, lng, accuracy, timestamp, coords: pos.coords };
          applyGpsReading(lat, lng, accuracy, timestamp, pos.coords, false);
        }

        // If we reach <= 8 meters, that is an outstanding GNSS fix; finalize early after 2+ samples
        if (bestAcc <= 8 && samples.length >= 2) {
          finalizeSampling();
        }
      },
      (err) => {
        console.warn('[AgriTrustFieldManager] Sampling update error:', err);
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0
      }
    );

    // Timeout after 7.5 seconds
    timerId = setTimeout(() => {
      finalizeSampling();
    }, 7500);
  }

  /**
   * Stops continuous geolocation tracking
   */
  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    isTracking = false;
    if (elements.locTrackingStatus) {
      elements.locTrackingStatus.style.display = 'none';
    }
  }

  /**
   * External GNSS receiver adapter hooks for RTK rover / Bluetooth / USB GNSS units
   */
  function registerExternalGnss(provider) {
    externalGnssProvider = provider;
    if (provider && typeof provider.onPosition === 'function') {
      provider.onPosition((pos) => {
        applyGpsReading(pos.latitude, pos.longitude, pos.accuracy || 1, pos.timestamp || Date.now(), pos, true);
      });
    }
  }

  function setExternalGnssPosition(data) {
    if (!data || typeof data.latitude !== 'number' || typeof data.longitude !== 'number') return;
    const accuracy = data.accuracy || 1;
    const timestamp = data.timestamp || Date.now();
    applyGpsReading(data.latitude, data.longitude, accuracy, timestamp, data, true);
  }

  /**
   * Universal Place Search & Coordinate Jump
   * Handles coordinates (lat, lng) or village/town/district place names via Nominatim geosearch
   */
  async function handleUniversalSearch() {
    const raw = elements.coordInput?.value.trim();
    if (!raw) {
      showValidationMessage('Enter a place name (e.g. "Guntur", "Tenali") or coordinates (e.g. 16.3067, 80.4365).', 'warning');
      return;
    }

    // 1. Check if input is "lat, lng" coordinates
    const coordParts = raw.split(/[\s,]+/);
    if (coordParts.length >= 2) {
      const lat = parseFloat(coordParts[0]);
      const lng = parseFloat(coordParts[1]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        map.flyTo([lat, lng], 17, { duration: 1.5 });
        showValidationMessage(`Centered map on coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}. Resolving location details...`, 'info');

        const details = await resolveGeographicLocation(lat, lng);
        updateLocationDisplay(lat, lng, 0, details);
        if (elements.locAccuracy) elements.locAccuracy.textContent = 'Manual Coordinate Target';
        if (elements.locAccuracyTier) {
          elements.locAccuracyTier.textContent = 'TARGET';
          elements.locAccuracyTier.className = 'accuracy-tier-pill tier-moderate';
        }
        if (elements.locSource) elements.locSource.textContent = 'Manual Coordinate Input';
        if (elements.locAccuracyWarning) elements.locAccuracyWarning.style.display = 'none';

        showValidationMessage(`Map focused on ${details.primaryPlace || `${lat.toFixed(4)}, ${lng.toFixed(4)}`}. Outline parcel boundaries when ready.`, 'success');
        return;
      }
    }

    // 2. Place / village name geosearch
    if (elements.manualJumpBtn) {
      elements.manualJumpBtn.disabled = true;
      if (elements.coordJumpBtnText) elements.coordJumpBtnText.textContent = 'Searching...';
    }

    showValidationMessage(`Searching real geographic records for "${raw}"...`, 'info');

    try {
      const searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(raw)}&limit=1&addressdetails=1`;
      const res = await fetch(searchUrl, {
        headers: { 'Accept': 'application/json' }
      });

      if (res.ok) {
        const results = await res.json();
        if (results && results.length > 0) {
          const item = results[0];
          const lat = parseFloat(item.lat);
          const lng = parseFloat(item.lon);

          map.flyTo([lat, lng], 16, { duration: 1.5 });

          const a = item.address || {};
          const village = a.village || a.hamlet || a.town || a.city_district || a.suburb || a.city || item.name;
          const mandal = a.subdistrict || a.tehsil || a.taluk || a.county;
          const district = a.state_district || a.district;
          const state = a.state;
          const country = a.country || 'India';

          const details = {
            primaryPlace: village || item.name,
            subPlace: mandal || null,
            district: district || null,
            region: [state, country].filter(Boolean).join(', ') || null,
            state: state || null,
            country: country,
            displayName: item.display_name
          };

          updateLocationDisplay(lat, lng, 0, details);
          if (elements.locAccuracy) elements.locAccuracy.textContent = 'Search Resolved Target';
          if (elements.locAccuracyTier) {
            elements.locAccuracyTier.textContent = 'TARGET';
            elements.locAccuracyTier.className = 'accuracy-tier-pill tier-moderate';
          }
          if (elements.locSource) elements.locSource.textContent = 'Geographic Search Record';
          if (elements.locAccuracyWarning) elements.locAccuracyWarning.style.display = 'none';

          showValidationMessage(`Located: ${item.display_name}. Zoom in to find your exact plot.`, 'success');
          return;
        }
      }

      showValidationMessage(`No geographic match found for "${raw}". Please verify spelling or enter latitude & longitude coordinates.`, 'warning');
    } catch (err) {
      console.warn('[AgriTrustFieldManager] Place search error:', err);
      showValidationMessage(`Search network request failed. You can pan the map manually or enter coordinates.`, 'error');
    } finally {
      if (elements.manualJumpBtn) {
        elements.manualJumpBtn.disabled = false;
        if (elements.coordJumpBtnText) elements.coordJumpBtnText.textContent = 'Search / Go';
      }
    }
  }

  /**
   * Toggle Drawing State Machine
   */
  function toggleDrawingState() {
    if (drawState === 'IDLE') {
      startDrawing();
    } else if (drawState === 'DRAWING') {
      if (vertices.length >= 3) {
        closePolygon();
      } else {
        showValidationMessage('You need at least 3 points to close a field parcel boundary.', 'warning');
      }
    } else if (drawState === 'CLOSED') {
      // Re-open for editing
      drawState = 'DRAWING';
      updateUIForState();
      showValidationMessage('Parcel reopened for editing. Click on the map to add more points, or click "Complete Parcel" when done.', 'info');
    }
  }

  function startDrawing() {
    resetDrawing();
    drawState = 'DRAWING';
    updateUIForState();
    elements.mapContainer.classList.add('map-drawing-active');
    showValidationMessage('Click anywhere on the satellite image to place the first corner of your field parcel.', 'info');
  }

  /**
   * Map Click Handler
   */
  function handleMapClick(e) {
    if (drawState !== 'DRAWING') return;

    const latlng = e.latlng;
    addVertex(latlng);
  }

  /**
   * Add Vertex to current boundary
   */
  function addVertex(latlng) {
    const point = { lat: latlng.lat, lng: latlng.lng };
    vertices.push(point);

    const vertexIndex = vertices.length - 1;
    const isFirstPoint = vertexIndex === 0;

    // Create marker for vertex
    const marker = createVertexMarker(point, vertexIndex, isFirstPoint);
    marker.addTo(map);
    vertexMarkers.push(marker);

    updatePolylinePreview();
    updateTelemetry();

    if (vertices.length === 1) {
      showValidationMessage('First point placed. Click the next boundary corner of your field.', 'info');
    } else if (vertices.length === 2) {
      showValidationMessage('Second corner placed. Continue outlining your parcel (minimum 3 points required).', 'info');
    } else {
      showValidationMessage(`${vertices.length} points placed. Click the first point (golden anchor) or "Complete Parcel" to close the boundary.`, 'info');
    }
  }

  /**
   * Create custom interactive Leaflet Marker for vertex
   */
  function createVertexMarker(point, index, isFirstPoint = false) {
    const markerClass = isFirstPoint ? 'field-vertex-marker first-vertex' : 'field-vertex-marker';
    const htmlContent = isFirstPoint
      ? `<div class="vertex-anchor first-anchor" title="Click to close parcel"><span class="vertex-num">1</span></div>`
      : `<div class="vertex-anchor"><span class="vertex-num">${index + 1}</span></div>`;

    const icon = L.divIcon({
      className: markerClass,
      html: htmlContent,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    const marker = L.marker([point.lat, point.lng], {
      icon: icon,
      draggable: drawState === 'CLOSED',
      riseOnHover: true
    });

    // Clicking first point closes polygon if >= 3 points
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (drawState === 'DRAWING' && index === 0 && vertices.length >= 3) {
        closePolygon();
      } else if (drawState === 'CLOSED') {
        // Option to delete this vertex
        promptDeleteVertex(index);
      }
    });

    // Drag handling when closed
    marker.on('drag', (ev) => {
      const newPos = ev.target.getLatLng();
      vertices[index] = { lat: newPos.lat, lng: newPos.lng };
      if (polygonLayer) {
        polygonLayer.setLatLngs(vertices);
      }
      updateTelemetry();
    });

    marker.on('dragend', () => {
      validateAndRenderGeometry();
    });

    return marker;
  }

  /**
   * Update transient polyline connecting points during DRAWING
   */
  function updatePolylinePreview() {
    if (previewPolyline) {
      map.removeLayer(previewPolyline);
      previewPolyline = null;
    }

    if (vertices.length > 1) {
      previewPolyline = L.polyline(vertices, {
        color: '#168a4d',
        weight: 3,
        dashArray: '6, 6',
        opacity: 0.9
      }).addTo(map);
    }
  }

  /**
   * Close Polygon ring
   */
  function closePolygon() {
    if (vertices.length < 3) {
      showValidationMessage('A valid parcel polygon requires at least 3 points.', 'warning');
      return;
    }

    drawState = 'CLOSED';
    elements.mapContainer.classList.remove('map-drawing-active');

    // Remove polyline preview
    if (previewPolyline) {
      map.removeLayer(previewPolyline);
      previewPolyline = null;
    }

    // Enable dragging on all vertex markers
    vertexMarkers.forEach((m) => {
      m.dragging.enable();
    });

    validateAndRenderGeometry();
    updateUIForState();
  }

  /**
   * Render closed polygon and run geometric checks
   */
  function validateAndRenderGeometry() {
    if (polygonLayer) {
      map.removeLayer(polygonLayer);
      polygonLayer = null;
    }

    // Validate geometry
    const validation = validatePolygon(vertices);

    if (validation.valid) {
      polygonLayer = L.polygon(vertices, {
        color: '#168a4d',
        weight: 3,
        fillColor: '#22c55e',
        fillOpacity: 0.28
      }).addTo(map);

      updateTelemetry(true);
      showValidationMessage(`Parcel boundary validated! Total area: ${elements.telemetryAreaAcres?.textContent} acres (${elements.telemetryAreaHa?.textContent} ha). Drag corners to adjust. Fill in details and click "Save Parcel Boundary".`, 'success');
    } else {
      polygonLayer = L.polygon(vertices, {
        color: '#be123c',
        weight: 3,
        fillColor: '#f43f5e',
        fillOpacity: 0.28,
        dashArray: '4, 4'
      }).addTo(map);

      updateTelemetry(false);
      showValidationMessage(`Invalid Boundary: ${validation.error}`, 'error');
    }
  }

  /**
   * Delete individual vertex point
   */
  function promptDeleteVertex(index) {
    if (vertices.length <= 3) {
      showValidationMessage('Cannot delete point: A field parcel requires a minimum of 3 boundary vertices.', 'warning');
      return;
    }

    vertices.splice(index, 1);
    rebuildVertexMarkers();
    validateAndRenderGeometry();
    showValidationMessage(`Point ${index + 1} deleted. Boundary updated.`, 'info');
  }

  function rebuildVertexMarkers() {
    vertexMarkers.forEach((m) => map.removeLayer(m));
    vertexMarkers = [];

    vertices.forEach((p, i) => {
      const marker = createVertexMarker(p, i, i === 0);
      marker.addTo(map);
      marker.dragging.enable();
      vertexMarkers.push(marker);
    });
  }

  /**
   * Undo Last Point
   */
  function undoLastPoint() {
    if (vertices.length === 0) return;

    vertices.pop();
    const lastMarker = vertexMarkers.pop();
    if (lastMarker) {
      map.removeLayer(lastMarker);
    }

    if (drawState === 'CLOSED') {
      drawState = 'DRAWING';
      elements.mapContainer.classList.add('map-drawing-active');
      if (polygonLayer) {
        map.removeLayer(polygonLayer);
        polygonLayer = null;
      }
      vertexMarkers.forEach((m) => m.dragging.disable());
    }

    updatePolylinePreview();
    updateTelemetry();
    updateUIForState();

    showValidationMessage(vertices.length > 0 ? `Removed last point. ${vertices.length} points remaining.` : 'All points removed. Click map to place first corner.', 'info');
  }

  /**
   * Reset / Clear Drawing
   */
  function resetDrawing() {
    drawState = 'IDLE';
    vertices = [];

    vertexMarkers.forEach((m) => map.removeLayer(m));
    vertexMarkers = [];

    if (previewPolyline) {
      map.removeLayer(previewPolyline);
      previewPolyline = null;
    }

    if (polygonLayer) {
      map.removeLayer(polygonLayer);
      polygonLayer = null;
    }

    elements.mapContainer.classList.remove('map-drawing-active');
    updateTelemetry();
    updateUIForState();
    showValidationMessage('Parcel drawing cleared. Click "Start Drawing Parcel" to outline a field.', 'info');
  }

  /**
   * Calculate WGS84 Geodesic Surface Area of polygon in Square Meters
   * Formula: Spherical excess on WGS84 ellipsoid model
   */
  function calculateGeodesicArea(coords) {
    if (!coords || coords.length < 3) return 0;

    const R = 6378137; // Earth radius in meters
    let total = 0;

    for (let i = 0; i < coords.length; i++) {
      const p1 = coords[i];
      const p2 = coords[(i + 1) % coords.length];

      const radLat1 = p1.lat * (Math.PI / 180);
      const radLat2 = p2.lat * (Math.PI / 180);
      const radLng1 = p1.lng * (Math.PI / 180);
      const radLng2 = p2.lng * (Math.PI / 180);

      total += (radLng2 - radLng1) * (2 + Math.sin(radLat1) + Math.sin(radLat2));
    }

    const areaM2 = Math.abs((total * R * R) / 2.0);
    return areaM2;
  }

  /**
   * Geometric Validation:
   * 1. At least 3 points
   * 2. Area > 0
   * 3. No self-intersecting segments (ensures PostGIS ST_IsValid)
   */
  function validatePolygon(coords) {
    if (!coords || coords.length < 3) {
      return { valid: false, error: 'At least 3 boundary vertices are required.' };
    }

    const areaM2 = calculateGeodesicArea(coords);
    if (areaM2 <= 1.0) {
      return { valid: false, error: 'Calculated parcel area is too small or degenerate.' };
    }

    // Check for self-intersections
    if (hasSelfIntersection(coords)) {
      return {
        valid: false,
        error: 'Parcel edges cross over each other. PostGIS requires a simple, non-self-intersecting polygon. Please drag corners to uncross edges.'
      };
    }

    return { valid: true, areaM2 };
  }

  /**
   * Helper: Line segment intersection detection
   */
  function hasSelfIntersection(points) {
    const n = points.length;
    if (n < 4) return false;

    for (let i = 0; i < n; i++) {
      const a1 = points[i];
      const a2 = points[(i + 1) % n];

      for (let j = i + 1; j < n; j++) {
        // Adjacent edges share a vertex, skip them
        if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) {
          continue;
        }

        const b1 = points[j];
        const b2 = points[(j + 1) % n];

        if (doSegmentsIntersect(a1, a2, b1, b2)) {
          return true;
        }
      }
    }
    return false;
  }

  function doSegmentsIntersect(p1, p2, p3, p4) {
    function ccw(A, B, C) {
      return (C.lat - A.lat) * (B.lng - A.lng) > (B.lat - A.lat) * (C.lng - A.lng);
    }
    return (ccw(p1, p3, p4) !== ccw(p2, p3, p4)) && (ccw(p1, p2, p3) !== ccw(p1, p2, p4));
  }

  /**
   * Update Telemetry HUD and Form Acreage
   */
  function updateTelemetry(isValid = null) {
    const count = vertices.length;
    if (elements.telemetryPoints) {
      elements.telemetryPoints.textContent = count;
    }

    if (count >= 3) {
      const areaM2 = calculateGeodesicArea(vertices);
      const acres = (areaM2 * 0.000247105).toFixed(2);
      const ha = (areaM2 * 0.0001).toFixed(2);

      if (elements.telemetryAreaAcres) elements.telemetryAreaAcres.textContent = acres;
      if (elements.telemetryAreaHa) elements.telemetryAreaHa.textContent = ha;
      if (elements.fieldAcreageInput) elements.fieldAcreageInput.value = acres;

      if (elements.telemetryValidity) {
        if (isValid === true) {
          elements.telemetryValidity.textContent = 'Valid Geometry';
          elements.telemetryValidity.className = 'telemetry-badge valid';
        } else if (isValid === false) {
          elements.telemetryValidity.textContent = 'Self-Intersecting';
          elements.telemetryValidity.className = 'telemetry-badge invalid';
        } else {
          elements.telemetryValidity.textContent = 'Open Ring';
          elements.telemetryValidity.className = 'telemetry-badge pending';
        }
      }
    } else {
      if (elements.telemetryAreaAcres) elements.telemetryAreaAcres.textContent = '0.00';
      if (elements.telemetryAreaHa) elements.telemetryAreaHa.textContent = '0.00';
      if (elements.fieldAcreageInput) elements.fieldAcreageInput.value = '';
      if (elements.telemetryValidity) {
        elements.telemetryValidity.textContent = 'Incomplete';
        elements.telemetryValidity.className = 'telemetry-badge pending';
      }
    }
  }

  /**
   * Update UI button labels and active states
   */
  function updateUIForState() {
    if (!elements.startDrawBtn) return;

    if (drawState === 'IDLE') {
      elements.startDrawBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        Start Drawing Parcel
      `;
      elements.startDrawBtn.className = 'btn btn-primary';
      if (elements.saveFieldBtn) elements.saveFieldBtn.disabled = true;
    } else if (drawState === 'DRAWING') {
      elements.startDrawBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        Complete Parcel (${vertices.length} pts)
      `;
      elements.startDrawBtn.className = 'btn btn-success';
      if (elements.saveFieldBtn) elements.saveFieldBtn.disabled = true;
    } else if (drawState === 'CLOSED') {
      elements.startDrawBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
        Edit Boundary Points
      `;
      elements.startDrawBtn.className = 'btn btn-secondary';
      if (elements.saveFieldBtn) elements.saveFieldBtn.disabled = false;
    }
  }

  function showValidationMessage(msg, type = 'info') {
    if (!elements.feedbackBox) return;
    elements.feedbackBox.style.display = 'block';

    if (type === 'success') {
      elements.feedbackBox.style.backgroundColor = '#dcfce7';
      elements.feedbackBox.style.borderColor = '#86efac';
      elements.feedbackBox.style.color = '#166534';
    } else if (type === 'warning') {
      elements.feedbackBox.style.backgroundColor = '#fef3c7';
      elements.feedbackBox.style.borderColor = '#fcd34d';
      elements.feedbackBox.style.color = '#92400e';
    } else if (type === 'error') {
      elements.feedbackBox.style.backgroundColor = '#fee2e2';
      elements.feedbackBox.style.borderColor = '#fca5a5';
      elements.feedbackBox.style.color = '#991b1b';
    } else {
      elements.feedbackBox.style.backgroundColor = '#f1f5f9';
      elements.feedbackBox.style.borderColor = '#cbd5e1';
      elements.feedbackBox.style.color = '#334155';
    }

    if (typeof msg === 'string' && (msg.includes('<a ') || msg.includes('<strong>') || msg.includes('<br>') || msg.includes('&rarr;'))) {
      elements.feedbackBox.innerHTML = msg;
    } else {
      elements.feedbackBox.textContent = msg;
    }
  }

  /**
   * Serialize vertices into PostGIS EWKT (SRID=4326;POLYGON((lon1 lat1, lon2 lat2, ...)))
   */
  function toPostGISEWKT(coords) {
    if (coords.length < 3) return null;

    // Coordinate string format: "longitude latitude"
    const pointsList = coords.map((c) => `${c.lng.toFixed(7)} ${c.lat.toFixed(7)}`);
    // Close the ring by repeating the first coordinate
    pointsList.push(`${coords[0].lng.toFixed(7)} ${coords[0].lat.toFixed(7)}`);

    return `SRID=4326;POLYGON((${pointsList.join(', ')}))`;
  }

  /**
   * Form Submit: Save Field Parcel to Supabase
   */
  async function handleFieldFormSubmit(e) {
    e.preventDefault();

    if (drawState !== 'CLOSED') {
      showValidationMessage('Please complete and close your field polygon before saving.', 'warning');
      return;
    }

    const validation = validatePolygon(vertices);
    if (!validation.valid) {
      showValidationMessage(`Cannot save invalid geometry: ${validation.error}`, 'error');
      return;
    }

    const name = elements.fieldNameInput?.value.trim();
    const cropVariety = elements.cropVarietyInput?.value.trim();
    const plantingDate = elements.plantingDateInput?.value || null;
    const soilTexture = elements.soilTextureSelect?.value || null;
    const acreageVal = parseFloat(elements.fieldAcreageInput?.value);

    if (!name) {
      showValidationMessage('Please provide a name for this field parcel (e.g., "North 40 Corn").', 'warning');
      return;
    }

    if (!cropVariety) {
      showValidationMessage('Please enter the crop variety (e.g., "Maize (Zea mays)", "Soybeans").', 'warning');
      return;
    }

    if (isNaN(acreageVal) || acreageVal <= 0) {
      showValidationMessage('Calculated parcel area must be greater than zero. Please close your boundary polygon on the map.', 'warning');
      return;
    }

    // Convert to PostGIS EWKT
    const ewkt = toPostGISEWKT(vertices);
    if (!ewkt) {
      showValidationMessage('Error generating PostGIS geometry from boundary.', 'error');
      return;
    }

    // Check auth
    if (!window.AgriTrustSupabase) {
      showValidationMessage('Supabase client is not available.', 'error');
      return;
    }

    const user = await window.AgriTrustSupabase.getUser();
    if (!user) {
      showValidationMessage('You must be signed in to save this field. Please sign in via the portal modal.', 'warning');
      // Trigger login modal
      const loginModal = document.getElementById('authModal');
      if (loginModal) {
        loginModal.classList.add('active');
      }
      return;
    }

    if (elements.saveFieldBtn) {
      elements.saveFieldBtn.disabled = true;
      elements.saveFieldBtn.textContent = 'Saving to Database...';
    }

    let result;
    if (editingFieldId) {
      showValidationMessage('Updating existing parcel boundary in Supabase...', 'info');
      result = await window.AgriTrustSupabase.updateField(editingFieldId, {
        name,
        crop_variety: cropVariety,
        planting_date: plantingDate,
        acreage: acreageVal,
        boundary: ewkt,
        soil_texture_type: soilTexture
      });
    } else {
      showValidationMessage('Saving parcel geometry into Supabase fields table with PostGIS validation...', 'info');
      result = await window.AgriTrustSupabase.saveField({
        name,
        crop_variety: cropVariety,
        planting_date: plantingDate,
        acreage: acreageVal,
        boundary: ewkt,
        soil_texture_type: soilTexture
      });
    }

    if (elements.saveFieldBtn) {
      elements.saveFieldBtn.disabled = false;
      elements.saveFieldBtn.textContent = 'Save Parcel Boundary';
    }

    if (result.success) {
      const safeName = escapeHTML(name);
      const msg = editingFieldId
        ? `Field "${safeName}" successfully updated in Supabase PostGIS! <a href="#dashboard" style="color: #166534; font-weight: 600; text-decoration: underline; margin-left: 0.5rem;">View in Farm Dashboard &rarr;</a>`
        : `Field "${safeName}" successfully registered in Supabase PostGIS! ID: ${result.field?.id || 'Created'}. <a href="#dashboard" style="color: #166534; font-weight: 600; text-decoration: underline; margin-left: 0.5rem;">View in Farm Dashboard &rarr;</a>`;
      showValidationMessage(msg, 'success');
      // Reset editing ID, form and reload fields
      editingFieldId = null;
      elements.saveFieldForm.reset();
      resetDrawing();
      loadRegisteredFields();
      window.dispatchEvent(new CustomEvent('agritrust:fieldSaved', { detail: { field: result.field } }));
    } else {
      showValidationMessage(`Error saving field: ${result.message}`, 'error');
    }
  }

  /**
   * Load and render existing grower fields from Supabase
   */
  async function loadRegisteredFields() {
    if (!window.AgriTrustSupabase) return;

    const result = await window.AgriTrustSupabase.fetchUserFields();
    existingFieldsLayers.clearLayers();
    savedFieldsMap = {};

    if (!result.success || !result.fields || result.fields.length === 0) {
      if (elements.registeredFieldsList) {
        elements.registeredFieldsList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0;">No registered parcels found for this account. Use the map to draw your first field!</p>';
      }
      return;
    }

    if (elements.registeredFieldsList) {
      elements.registeredFieldsList.innerHTML = '';
    }

    result.fields.forEach((field) => {
      savedFieldsMap[field.id] = { field: field, poly: null };

      // Add to list
      if (elements.registeredFieldsList) {
        const item = document.createElement('div');
        item.className = 'registered-field-card';
        item.innerHTML = `
          <div class="field-card-header">
            <h6 class="field-card-name">${escapeHTML(field.name)}</h6>
            <span class="field-card-acreage">${field.acreage} ac</span>
          </div>
          <div class="field-card-meta">
            <span>Crop: <strong>${escapeHTML(field.crop_variety)}</strong></span>
            ${field.soil_texture_type ? `<span>Soil: ${escapeHTML(field.soil_texture_type)}</span>` : ''}
          </div>
          <button type="button" class="btn btn-subtle btn-sm js-focus-field" data-id="${field.id}">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            Focus on Map
          </button>
        `;

        item.querySelector('.js-focus-field').addEventListener('click', () => {
          focusOnSavedField(field);
        });

        elements.registeredFieldsList.appendChild(item);
      }

      // Render polygon on map if boundary can be parsed
      renderSavedFieldPolygon(field);
    });
  }

  /**
   * Parse EWKT / WKT or GeoJSON to Leaflet polygon
   */
  function renderSavedFieldPolygon(field) {
    if (!field.boundary) return;

    let latLngs = parseBoundaryGeometry(field.boundary);
    if (!latLngs || latLngs.length < 3) return;

    const poly = L.polygon(latLngs, {
      color: '#0284c7', // Satellite cyan/blue for existing saved fields
      weight: 2,
      fillColor: '#38bdf8',
      fillOpacity: 0.2
    });

    poly.bindPopup(`
      <div style="font-family: sans-serif; font-size: 0.85rem;">
        <strong style="color: #0369a1; font-size: 0.95rem;">${escapeHTML(field.name)}</strong><br>
        <strong>Acreage:</strong> ${field.acreage} ac<br>
        <strong>Crop:</strong> ${escapeHTML(field.crop_variety)}<br>
        ${field.planting_date ? `<strong>Planted:</strong> ${field.planting_date}<br>` : ''}
        ${field.soil_texture_type ? `<strong>Soil:</strong> ${escapeHTML(field.soil_texture_type)}<br>` : ''}
        <span style="font-size: 0.75rem; color: #64748b;">PostGIS Verified Parcel</span>
      </div>
    `);

    field._leafletLayer = poly;
    if (savedFieldsMap[field.id]) {
      savedFieldsMap[field.id].poly = poly;
    }
    existingFieldsLayers.addLayer(poly);
  }

  function focusOnSavedField(field) {
    if (field._leafletLayer) {
      map.fitBounds(field._leafletLayer.getBounds(), { padding: [40, 40], maxZoom: 17 });
      field._leafletLayer.openPopup();
    }
  }

  function focusField(fieldId) {
    const entry = savedFieldsMap[fieldId];
    if (entry && entry.poly) {
      const el = document.getElementById('fields');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      map.fitBounds(entry.poly.getBounds(), { padding: [40, 40], maxZoom: 17 });
      entry.poly.openPopup();
      return true;
    }
    return false;
  }

  function loadFieldForEditing(field) {
    const el = document.getElementById('fields');
    if (el) el.scrollIntoView({ behavior: 'smooth' });

    editingFieldId = field.id;

    // Parse existing boundary
    const latLngs = parseBoundaryGeometry(field.boundary);
    if (!latLngs || latLngs.length < 3) return;

    resetDrawing();
    editingFieldId = field.id;
    vertices = latLngs.map((pt) => ({ lat: pt[0], lng: pt[1] }));
    rebuildVertexMarkers();
    closePolygon();

    if (elements.fieldNameInput) elements.fieldNameInput.value = field.name || '';
    if (elements.cropVarietyInput) elements.cropVarietyInput.value = field.crop_variety || '';
    if (elements.plantingDateInput) elements.plantingDateInput.value = field.planting_date || '';
    if (elements.soilTextureSelect) elements.soilTextureSelect.value = field.soil_texture_type || '';
    if (elements.fieldAcreageInput) elements.fieldAcreageInput.value = field.acreage || '';

    if (polygonLayer) {
      map.fitBounds(polygonLayer.getBounds(), { padding: [40, 40], maxZoom: 17 });
    }
    showValidationMessage(`Editing parcel "${field.name}". Drag boundary corners to adjust, then click "Save Parcel Boundary".`, 'info');
  }

  /**
   * Parses EWKT ("SRID=4326;POLYGON((lng lat, ...))") or GeoJSON into Leaflet [[lat, lng], ...]
  /**
   * Parses EWKT, WKT, GeoJSON (object or string), or Hex-encoded PostGIS EWKB
   * into Leaflet format [[lat, lng], ...]
   */
  function parseBoundaryGeometry(boundary) {
    if (!boundary) return null;

    try {
      // 1. Direct GeoJSON Object
      if (typeof boundary === 'object' && boundary.coordinates) {
        const ring = boundary.coordinates[0];
        return ring.map((pt) => [pt[1], pt[0]]);
      }

      if (typeof boundary === 'string') {
        const s = boundary.trim();

        // 2. Serialized GeoJSON String
        if (s.startsWith('{') && s.endsWith('}')) {
          try {
            const parsed = JSON.parse(s);
            if (parsed && parsed.coordinates) {
              const ring = parsed.coordinates[0];
              return ring.map((pt) => [pt[1], pt[0]]);
            }
          } catch (e) {
            // Not valid JSON, continue to WKT/EWKB
          }
        }

        // 3. WKT or EWKT String (e.g., SRID=4326;POLYGON((...)) or POLYGON((...)))
        const wktMatch = s.match(/POLYGON\s*\(\(\s*(.+?)\s*\)\)/i);
        if (wktMatch) {
          const coordPairs = wktMatch[1].split(',');
          const latLngs = [];
          coordPairs.forEach((pair) => {
            const parts = pair.trim().split(/\s+/);
            if (parts.length >= 2) {
              const lng = parseFloat(parts[0]);
              const lat = parseFloat(parts[1]);
              if (!isNaN(lat) && !isNaN(lng)) {
                latLngs.push([lat, lng]);
              }
            }
          });
          if (latLngs.length >= 3) return latLngs;
        }

        // 4. Hex-encoded PostGIS EWKB / WKB (Standard PostgREST geometry format)
        const cleanHex = s.replace(/^\\x/i, '');
        if (cleanHex.length >= 32 && /^[0-9a-fA-F]+$/.test(cleanHex)) {
          const latLngs = parseHexEWKB(cleanHex);
          if (latLngs && latLngs.length >= 3) return latLngs;
        }
      }
    } catch (err) {
      console.warn('[AgriTrustFieldManager] Could not parse boundary:', err);
    }
    return null;
  }

  /**
   * Pure JavaScript Binary Decoder for PostGIS Hex EWKB Polygons
   */
  function parseHexEWKB(hexStr) {
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
      const baseType = geomType & 0xFF; // 3 = Polygon, 6 = MultiPolygon

      let offset = 5;
      if (hasSrid) {
        offset += 4; // Skip 4-byte SRID
      }

      if (baseType === 3) { // Polygon
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
          if (!isNaN(lat) && !isNaN(lng)) {
            latLngs.push([lat, lng]);
          }
        }
        return latLngs;
      } else if (baseType === 6) { // MultiPolygon (outer ring of first polygon)
        const numPolys = view.getUint32(offset, isLittle);
        offset += 4;
        if (numPolys === 0) return null;
        const polyEndian = view.getUint8(offset) === 1;
        offset += 5;
        const numRings = view.getUint32(offset, polyEndian);
        offset += 4;
        if (numRings === 0) return null;
        const numPoints = view.getUint32(offset, polyEndian);
        offset += 4;
        const latLngs = [];
        for (let i = 0; i < numPoints; i++) {
          const lng = view.getFloat64(offset, polyEndian);
          const lat = view.getFloat64(offset + 8, polyEndian);
          offset += 16;
          if (!isNaN(lat) && !isNaN(lng)) {
            latLngs.push([lat, lng]);
          }
        }
        return latLngs;
      }
    } catch (err) {
      console.warn('[AgriTrustFieldManager] Hex EWKB decoding error:', err);
    }
    return null;
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  return {
    init,
    calculateGeodesicArea,
    validatePolygon,
    toPostGISEWKT,
    focusField,
    loadFieldForEditing,
    startDrawing,
    resetDrawing,
    refreshFields: loadRegisteredFields,
    resolveGeographicLocation,
    getCurrentGpsPosition: () => currentGpsPosition,
    toggleFullscreen,
    searchLocation: handleUniversalSearch,
    locateGps: handleExplicitGeolocation,
    improveLocationAccuracy,
    stopTracking,
    registerExternalGnss,
    setExternalGnssPosition,
    classifyAccuracyTier,
    classifyLocationSource,
    isMobileDevice,
    applyGpsReading
  };
})();

// Explicitly bind AgriTrustFieldManager to global window and globalThis scopes
if (typeof window !== 'undefined') {
  window.AgriTrustFieldManager = AgriTrustFieldManager;
}
if (typeof globalThis !== 'undefined') {
  globalThis.AgriTrustFieldManager = AgriTrustFieldManager;
}

// Auto-initialize on DOM ready or immediately if DOM is already loaded
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      AgriTrustFieldManager.init();
    });
  } else {
    AgriTrustFieldManager.init();
  }
}

