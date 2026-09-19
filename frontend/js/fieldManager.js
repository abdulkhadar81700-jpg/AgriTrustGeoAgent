/**
 * AgriTrustGeoAgent - Google Maps Platform Field Parcel & Location Manager
 * 
 * Enterprise Agricultural GIS powered by Google Maps Platform:
 * - Official Google Maps Roadmap & Satellite/Hybrid imagery
 * - Google Places global search & autocomplete (villages, mandals, towns, cities, districts, countries)
 * - Google Geocoding & Reverse Geocoding with full administrative hierarchy
 * - Device high-accuracy GPS sensor integration with live tracking & accuracy circle
 * - Farmer GPS field corner capture ("Walk & Record") for precision parcel surveying
 * - Interactive Google Polygon drawing, editing, and spherical geodesic area calculations
 * - Authoritative PostGIS EWKT serialization for Supabase PostgreSQL
 * - Real Google Directions turn-by-turn road navigation to field parcels
 */

const AgriTrustFieldManager = (() => {
  // Core Google Maps objects
  let map = null;
  let activeMapTypeId = 'hybrid'; // 'hybrid' (satellite + labels) | 'roadmap' (streets)
  let googleMapsLoaded = false;
  let googleMapsLoadError = null;
  let geocoder = null;
  let placesAutocomplete = null;
  let directionsService = null;
  let directionsRenderer = null;

  // Drawing state machine: 'IDLE' | 'DRAWING' | 'CLOSED'
  let drawState = 'IDLE';
  let vertices = [];          // Array of { lat, lng }
  let vertexMarkers = [];     // Array of google.maps.Marker
  let previewPolyline = null; // google.maps.Polyline while drawing
  let activePolygon = null;   // google.maps.Polygon when closed
  let savedFieldPolygons = {}; // Map of fieldId -> google.maps.Polygon
  let savedFieldsMap = {};    // Map of fieldId -> { field, poly }
  let activeNdviOverlays = {}; // Map of fieldId -> google.maps.GroundOverlay
  let editingFieldId = null;  // null for new field, or UUID if editing existing field

  // Routing state
  let activeRouteData = null;  // { origin, destination, result }
  let selectedRouteMode = 'driving';

  // Geocoding & Multilingual state
  let currentLanguage = 'en'; // 'en' | 'te' | 'hi'
  let activeSearchMarker = null; // google.maps.Marker for search target
  let activeSearchInfoWindow = null;

  // Geolocation, GPS & Tracking state
  let currentGpsMarker = null;       // google.maps.Marker with blue radar dot
  let currentAccuracyCircle = null;  // google.maps.Circle for reported GPS accuracy radius
  let currentGpsPosition = null;     // { lat, lng, accuracy, timestamp, address, coords, tier, source }
  let isFullscreen = false;
  let watchId = null;                // Geolocation watchPosition listener ID
  let isTracking = false;            // Continuous tracking toggle state
  let autoCenterOnGps = true;        // Whether map follows GPS position automatically
  let isSamplingAccuracy = false;    // Whether multi-sample convergence engine is active
  let bestPosition = null;           // Best position encountered during sampling or session
  let externalGnssProvider = null;   // Hook for external Bluetooth / USB / RTK GNSS receiver

  // DOM Elements cache
  let elements = {};

  /**
   * Safe HTML Escaping Helper
   */
  function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  /**
   * DOM Elements Cache
   */
  function cacheDOMElements() {
    elements = {
      mapWrapper: document.getElementById('fieldMapWrapper'),
      mapContainer: document.getElementById('fieldMap'),
      startDrawBtn: document.getElementById('btnStartDraw'),
      captureGpsCornerBtn: document.getElementById('btnCaptureGpsCorner'),
      undoPointBtn: document.getElementById('btnUndoPoint'),
      clearPolyBtn: document.getElementById('btnClearPoly'),
      locateGpsBtn: document.getElementById('btnLocateGps'),
      toggleTrackingBtn: document.getElementById('btnToggleTracking'),
      trackingBtnLabel: document.getElementById('trackingBtnLabel'),
      basemapToggleBtn: document.getElementById('btnToggleBasemap'),
      toggleRoutingBtn: document.getElementById('btnToggleRouting'),
      fullscreenBtn: document.getElementById('btnToggleFullscreen'),
      routePanel: document.getElementById('fieldRoutePanel'),
      closeRoutePanelBtn: document.getElementById('btnCloseRoutePanel'),
      routeModeBtns: document.querySelectorAll('.route-mode-btn'),
      routeOriginName: document.getElementById('routeOriginName'),
      routeDestName: document.getElementById('routeDestName'),
      routeMetrics: document.getElementById('routeMetrics'),
      routeDirectDistance: document.getElementById('routeDirectDistance'),
      routeRoadDistance: document.getElementById('routeRoadDistance'),
      routeTravelTime: document.getElementById('routeTravelTime'),
      routingNotice: document.getElementById('routingNotice'),
      routingNoticeText: document.getElementById('routingNoticeText'),
      clearRouteBtn: document.getElementById('btnClearRoute'),
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
      clearSearchBtn: document.getElementById('btnClearSearch'),
      searchResultsDropdown: document.getElementById('searchResultsDropdown'),
      langButtons: document.querySelectorAll('.map-lang-btn'),
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
   * Asynchronously load the official Google Maps JavaScript API
   * Retrieves the client API key from /api/config.
   */
  async function loadGoogleMapsSDK() {
    if (window.google && window.google.maps) {
      googleMapsLoaded = true;
      return true;
    }

    // Intercept Google Maps authentication failure gracefully
    window.gm_authFailure = () => {
      console.error('[Google Maps Platform] Authentication failed. Check API key and HTTP referrer restrictions.');
      googleMapsLoadError = 'auth_failure';
      renderSetupBanner('auth_failure');
    };

    let apiKey = '';
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        apiKey = (cfg.googleMapsApiKey || '').trim();
      }
    } catch (e) {
      console.warn('[AgriTrustFieldManager] Could not read /api/config for Google Maps key:', e);
    }

    if (!apiKey) {
      googleMapsLoadError = 'missing_key';
      renderSetupBanner('missing_key');
      return false;
    }

    return new Promise((resolve) => {
      window.__agritrustGoogleMapsCallback = () => {
        googleMapsLoaded = true;
        resolve(true);
      };

      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places,geometry&callback=__agritrustGoogleMapsCallback`;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        console.error('[Google Maps Platform] Failed to load Google Maps script.');
        googleMapsLoadError = 'network_error';
        renderSetupBanner('network_error');
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  /**
   * Render Google Maps Setup Guide Banner if key is missing or restricted
   */
  function renderSetupBanner(reason) {
    if (!elements.mapWrapper) return;

    let existingBanner = elements.mapWrapper.querySelector('.google-maps-setup-banner');
    if (existingBanner) existingBanner.remove();

    const banner = document.createElement('div');
    banner.className = 'google-maps-setup-banner';

    if (reason === 'auth_failure') {
      banner.innerHTML = `
        <div class="setup-icon">⚠️</div>
        <h4>Google Maps API Authorization Required</h4>
        <p>Google rejected the configured API key. This typically occurs when key restrictions (HTTP referrers) do not match your current host or when required APIs are not enabled.</p>
        <div class="setup-guide">
          1. Open <strong>Google Cloud Console &rarr; APIs &amp; Services &rarr; Credentials</strong>.<br>
          2. Ensure these APIs are enabled: <strong>Maps JavaScript API</strong>, <strong>Places API</strong>, and <strong>Geocoding API</strong>.<br>
          3. Under <em>Application Restrictions</em>, allow HTTP referrer:
          <pre>${window.location.origin}/*</pre>
        </div>
      `;
    } else {
      banner.innerHTML = `
        <div class="setup-icon">🗺️</div>
        <h4>Google Maps Platform Configuration</h4>
        <p>To enable genuine Google Satellite imagery, Google Roadmap view, Google Places search, and PostGIS field parcel mapping, configure your Google Maps API key.</p>
        <div class="setup-guide">
          1. Open Google Cloud Console and select or create a project.<br>
          2. Enable <strong>Maps JavaScript API</strong>, <strong>Places API</strong>, and <strong>Geocoding API</strong>.<br>
          3. Add your key to <code>.env</code> and restart the server:
          <pre>GOOGLE_MAPS_API_KEY=AIzaSyYourKeyHere...</pre>
          4. Refresh this page to activate the Google Maps Platform experience.
        </div>
      `;
    }

    elements.mapWrapper.appendChild(banner);
  }

  /**
   * Initialize Google Map
   */
  async function initMap() {
    if (map) return;

    const loaded = await loadGoogleMapsSDK();
    if (!loaded || !window.google || !window.google.maps) {
      return;
    }

    // Remove any setup banner if successfully loaded
    const banner = elements.mapWrapper?.querySelector('.google-maps-setup-banner');
    if (banner) banner.remove();

    // Instantiate Google Services
    geocoder = new google.maps.Geocoder();
    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
      suppressMarkers: false,
      polylineOptions: {
        strokeColor: '#2563eb',
        strokeWeight: 5,
        strokeOpacity: 0.85
      }
    });

    // Default view: neutral global overview (lat: 20, lng: 0, zoom: 2)
    // No hardcoded regional bias; will dynamically center on saved fields or device GPS
    map = new google.maps.Map(elements.mapContainer, {
      center: { lat: 20.0, lng: 0.0 },
      zoom: 2,
      mapTypeId: google.maps.MapTypeId.HYBRID, // Default to Google Satellite with Roads & Labels
      mapTypeControl: false,                   // Controlled via custom sleek toolbar
      zoomControl: true,
      zoomControlOptions: {
        position: google.maps.ControlPosition.RIGHT_BOTTOM
      },
      streetViewControl: false,
      fullscreenControl: false,                // Controlled via custom fullscreen handler
      gestureHandling: 'greedy'                // Touch-friendly on mobile
    });

    directionsRenderer.setMap(map);

    // Map click handler for polygon drawing
    map.addListener('click', (e) => {
      handleMapClick(e.latLng);
    });

    // If user drags the map manually during live tracking, pause auto-centering
    map.addListener('dragstart', () => {
      if (isTracking) {
        autoCenterOnGps = false;
        if (elements.locTrackingStatus) {
          elements.locTrackingStatus.innerHTML = '<span class="live-dot" style="background:#f59e0b;"></span> TRACKING (MANUAL PAN)';
        }
      }
    });

    // Initialize Google Places Autocomplete
    initGooglePlacesAutocomplete();

    // Check auth and load saved fields
    checkAuthState();
  }

  /**
   * Google Places Global Autocomplete Search
   */
  function initGooglePlacesAutocomplete() {
    if (!elements.coordInput || !window.google?.maps?.places) return;

    placesAutocomplete = new google.maps.places.Autocomplete(elements.coordInput, {
      fields: ['geometry', 'name', 'formatted_address', 'address_components']
    });

    // Bind autocomplete to map bounds
    placesAutocomplete.bindTo('bounds', map);

    placesAutocomplete.addListener('place_changed', () => {
      const place = placesAutocomplete.getPlace();

      if (!place || !place.geometry || !place.geometry.location) {
        // Fallback: check if the user entered direct latitude & longitude coordinates
        handleDirectCoordinateSearch();
        return;
      }

      if (elements.clearSearchBtn) {
        elements.clearSearchBtn.style.display = 'block';
      }

      // Smoothly fly and fit bounds
      if (place.geometry.viewport) {
        map.fitBounds(place.geometry.viewport);
      } else {
        map.setCenter(place.geometry.location);
        map.setZoom(16);
      }

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      const placeName = place.name || place.formatted_address || 'Search Target';

      setSearchTargetMarker(place.geometry.location, placeName, place.formatted_address);

      // Extract Google address components
      const details = parseGoogleAddressComponents(place.address_components, place.formatted_address);
      updateLocationDisplay(lat, lng, 0, details);

      if (elements.locAccuracy) elements.locAccuracy.textContent = 'Google Places Match';
      if (elements.locAccuracyTier) {
        elements.locAccuracyTier.textContent = 'VERIFIED';
        elements.locAccuracyTier.className = 'accuracy-tier-pill tier-high';
      }
      if (elements.locSource) elements.locSource.textContent = 'Google Places Platform';
      if (elements.locAccuracyWarning) elements.locAccuracyWarning.style.display = 'none';

      showValidationMessage(`Focused on ${placeName}. Ready to outline field boundaries or get directions.`, 'success');
    });

    // Clear search button binding
    if (elements.clearSearchBtn) {
      elements.clearSearchBtn.addEventListener('click', () => {
        elements.coordInput.value = '';
        elements.clearSearchBtn.style.display = 'none';
        if (activeSearchMarker) {
          activeSearchMarker.setMap(null);
          activeSearchMarker = null;
        }
        if (activeSearchInfoWindow) {
          activeSearchInfoWindow.close();
          activeSearchInfoWindow = null;
        }
      });
    }

    // Input keydown handler for Enter or input changes
    elements.coordInput.addEventListener('input', (e) => {
      if (elements.clearSearchBtn) {
        elements.clearSearchBtn.style.display = e.target.value.length > 0 ? 'block' : 'none';
      }
    });

    elements.coordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // If Places dropdown didn't fire place_changed, execute universal search
        setTimeout(() => {
          handleDirectCoordinateSearch();
        }, 200);
      }
    });

    // Multilingual language switch buttons
    if (elements.langButtons) {
      elements.langButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          setLanguage(btn.dataset.lang);
        });
      });
    }
  }

  /**
   * Sets prominent search target marker with info window
   */
  function setSearchTargetMarker(latLng, title, formattedAddress) {
    if (activeSearchMarker) {
      activeSearchMarker.setMap(null);
    }
    if (activeSearchInfoWindow) {
      activeSearchInfoWindow.close();
    }

    activeSearchMarker = new google.maps.Marker({
      map,
      position: latLng,
      title: title,
      animation: google.maps.Animation.DROP,
      icon: {
        path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
        scale: 6,
        fillColor: '#ea580c',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2
      }
    });

    activeSearchInfoWindow = new google.maps.InfoWindow({
      content: `
        <div style="font-family: inherit; font-size: 0.85rem; line-height: 1.4; max-width: 240px;">
          <strong style="color: #ea580c; font-size: 0.95rem;">📍 ${escapeHTML(title)}</strong><br>
          ${formattedAddress ? `<span style="font-size: 0.75rem; color: #475569;">${escapeHTML(formattedAddress)}</span><br>` : ''}
          <small style="color: #64748b; margin-top: 4px; display: inline-block;">Google Places Verified Location</small>
        </div>
      `
    });

    activeSearchMarker.addListener('click', () => {
      activeSearchInfoWindow.open(map, activeSearchMarker);
    });

    activeSearchInfoWindow.open(map, activeSearchMarker);
  }

  /**
   * Helper to parse Google address components into our clean hierarchy
   */
  function parseGoogleAddressComponents(components, formattedAddress = '') {
    const details = {
      primaryPlace: null,
      subPlace: null,
      district: null,
      region: null,
      state: null,
      country: null,
      postcode: null,
      displayName: formattedAddress
    };

    if (!Array.isArray(components)) return details;

    let locality = null;
    let sublocality = null;
    let neighborhood = null;
    let admin2 = null; // District / County
    let admin3 = null; // Tehsil / Taluk / Mandal
    let admin1 = null; // State / Province
    let country = null;
    let postal = null;

    components.forEach(c => {
      const types = c.types || [];
      if (types.includes('locality')) locality = c.long_name;
      else if (types.includes('sublocality_level_1') || types.includes('sublocality')) sublocality = c.long_name;
      else if (types.includes('neighborhood')) neighborhood = c.long_name;
      else if (types.includes('administrative_area_level_3')) admin3 = c.long_name;
      else if (types.includes('administrative_area_level_2')) admin2 = c.long_name;
      else if (types.includes('administrative_area_level_1')) admin1 = c.long_name;
      else if (types.includes('country')) country = c.long_name;
      else if (types.includes('postal_code')) postal = c.long_name;
    });

    details.primaryPlace = sublocality || neighborhood || locality || admin2 || 'Location';
    details.subPlace = admin3 || (sublocality && locality ? locality : null);
    details.district = admin2 || null;
    details.state = admin1 || null;
    details.country = country || null;
    details.postcode = postal || null;
    details.region = [admin1, country].filter(Boolean).join(', ') || null;

    return details;
  }

  /**
   * Parses direct latitude, longitude coordinate entries
   */
  function parseCoordinates(str) {
    if (!str || typeof str !== 'string') return null;
    const clean = str.trim();
    const match = clean.match(/^([-+]?\d{1,2}(?:\.\d+)?)[,\s]+([-+]?\d{1,3}(?:\.\d+)?)$/);
    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
    return null;
  }

  /**
   * Direct Coordinate or Universal Search
   */
  async function handleDirectCoordinateSearch() {
    const raw = elements.coordInput?.value.trim();
    if (!raw) return;

    const coords = parseCoordinates(raw);
    if (coords) {
      if (map && window.google?.maps) {
        const latLng = new google.maps.LatLng(coords.lat, coords.lng);
        map.setCenter(latLng);
        map.setZoom(17);
        setSearchTargetMarker(latLng, `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`, 'Direct Coordinates');
      }

      const details = await resolveGoogleReverseGeocode(coords.lat, coords.lng);
      updateLocationDisplay(coords.lat, coords.lng, 0, details);

      if (elements.locAccuracy) elements.locAccuracy.textContent = 'Coordinate Target';
      if (elements.locAccuracyTier) {
        elements.locAccuracyTier.textContent = 'TARGET';
        elements.locAccuracyTier.className = 'accuracy-tier-pill tier-high';
      }
      if (elements.locSource) elements.locSource.textContent = 'Direct Coordinates';

      showValidationMessage(`Focused on coordinates (${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}). Outline boundaries when ready.`, 'success');
    }
  }

  /**
   * Google Reverse Geocoding via Geocoder
   */
  async function resolveGoogleReverseGeocode(lat, lng) {
    if (!geocoder) {
      if (window.google?.maps?.Geocoder) {
        geocoder = new google.maps.Geocoder();
      } else {
        return {
          primaryPlace: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          subPlace: null,
          district: null,
          region: null,
          country: null,
          displayName: `Point (${lat.toFixed(5)}, ${lng.toFixed(5)})`
        };
      }
    }

    return new Promise((resolve) => {
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        if (status === 'OK' && results && results[0]) {
          const res = results[0];
          const details = parseGoogleAddressComponents(res.address_components, res.formatted_address);
          resolve(details);
        } else {
          resolve({
            primaryPlace: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            subPlace: null,
            district: null,
            region: null,
            country: null,
            displayName: `Point (${lat.toFixed(5)}, ${lng.toFixed(5)})`
          });
        }
      });
    });
  }

  /**
   * Toggle Basemap: Google Hybrid (Satellite + Labels) <-> Google Roadmap
   */
  function toggleBasemap() {
    if (activeMapTypeId === 'hybrid') {
      activeMapTypeId = 'roadmap';
      if (map && window.google?.maps) {
        map.setMapTypeId(google.maps.MapTypeId.ROADMAP);
      }
      if (elements.basemapToggleBtn) {
        elements.basemapToggleBtn.innerHTML = `
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064"/></svg>
          Switch to Satellite
        `;
      }
    } else {
      activeMapTypeId = 'hybrid';
      if (map && window.google?.maps) {
        map.setMapTypeId(google.maps.MapTypeId.HYBRID);
      }
      if (elements.basemapToggleBtn) {
        elements.basemapToggleBtn.innerHTML = `
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
          Switch to Street
        `;
      }
    }
  }

  /**
   * Device Geolocation & Continuous Tracking Engine
   */
  function handleExplicitGeolocation() {
    if (!navigator.geolocation) {
      showValidationMessage('Device geolocation is not supported by your browser or operating system.', 'warning');
      return;
    }

    if (elements.locateGpsBtn) {
      elements.locateGpsBtn.disabled = true;
      elements.locateGpsBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2" stroke-dasharray="32" stroke-dashoffset="16"/></svg>
        Acquiring GPS Fix...
      `;
    }

    showValidationMessage('Acquiring high-accuracy device location from hardware sensors...', 'info');

    autoCenterOnGps = true;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (elements.locateGpsBtn) {
          elements.locateGpsBtn.disabled = false;
          elements.locateGpsBtn.innerHTML = `
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" stroke-width="2"/><circle cx="12" cy="12" r="8" stroke-width="2"/></svg>
            Locate My Field (GPS)
          `;
        }

        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = Math.round(pos.coords.accuracy);

        await applyGpsReading(lat, lng, accuracy, pos.timestamp, pos.coords, true);

        if (accuracy > 50) {
          showValidationMessage(`Location detected (&plusmn;${accuracy}m accuracy). Laptops or cellular devices without satellite lock report approximate network positioning. Step outdoors or click "Improve Location Accuracy" to refine.`, 'warning');
        } else {
          showValidationMessage(`High-precision GPS fix acquired (&plusmn;${accuracy}m). Center placed over field. Ready to outline boundary or record GPS corners.`, 'success');
        }

        // Enable GPS corner capture button if drawing
        if (drawState === 'DRAWING' && elements.captureGpsCornerBtn) {
          elements.captureGpsCornerBtn.disabled = false;
        }
      },
      (err) => {
        if (elements.locateGpsBtn) {
          elements.locateGpsBtn.disabled = false;
          elements.locateGpsBtn.innerHTML = `
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" stroke-width="2"/><circle cx="12" cy="12" r="8" stroke-width="2"/></svg>
            Locate My Field (GPS)
          `;
        }

        let errMsg = 'Location access failed.';
        if (err.code === 1) {
          errMsg = 'Location permission was denied in your browser settings. To enable: click the permissions/lock icon next to your address bar, allow Location access, and click "Locate My Field" again. You can also search for your village in the search bar below.';
        } else if (err.code === 2) {
          errMsg = 'GPS position is unavailable from your device sensors. Please ensure Location Services are turned on in your device settings, or search for your village name in the search bar below.';
        } else if (err.code === 3) {
          errMsg = 'GPS acquisition timed out. Please step outdoors for clear satellite line-of-sight or search for your location in the search bar below.';
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
   * Continuous Tracking Toggle
   */
  function toggleTracking() {
    if (isTracking) {
      stopTracking();
      showValidationMessage('Continuous GPS tracking stopped.', 'info');
    } else {
      startTracking();
    }
  }

  function startTracking() {
    if (!navigator.geolocation) {
      showValidationMessage('Geolocation is not supported by your browser.', 'warning');
      return;
    }

    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
    }

    isTracking = true;
    autoCenterOnGps = true;

    if (elements.toggleTrackingBtn) {
      elements.toggleTrackingBtn.classList.add('active');
    }
    if (elements.trackingBtnLabel) {
      elements.trackingBtnLabel.textContent = 'Stop Tracking';
    }
    if (elements.locTrackingStatus) {
      elements.locTrackingStatus.style.display = 'inline-flex';
      elements.locTrackingStatus.innerHTML = '<span class="live-dot"></span> LIVE TRACKING';
    }

    showValidationMessage('Continuous GPS tracking active. The map will follow your position as you move around your farm.', 'info');

    watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = Math.round(pos.coords.accuracy);

        await applyGpsReading(lat, lng, accuracy, pos.timestamp, pos.coords, autoCenterOnGps);

        // Enable capture GPS button if drawing
        if (drawState === 'DRAWING' && elements.captureGpsCornerBtn) {
          elements.captureGpsCornerBtn.disabled = false;
        }
      },
      (err) => {
        console.warn('[AgriTrustFieldManager] Tracking error:', err);
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0
      }
    );
  }

  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    isTracking = false;
    autoCenterOnGps = false;

    if (elements.toggleTrackingBtn) {
      elements.toggleTrackingBtn.classList.remove('active');
    }
    if (elements.trackingBtnLabel) {
      elements.trackingBtnLabel.textContent = 'Start Tracking';
    }
    if (elements.locTrackingStatus) {
      elements.locTrackingStatus.style.display = 'none';
    }
  }

  /**
   * Apply GPS reading to map, marker, accuracy circle and telemetry card
   */
  async function applyGpsReading(lat, lng, accuracy, timestamp, coords = null, shouldPan = false) {
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

    if (map && window.google?.maps) {
      const latLng = new google.maps.LatLng(lat, lng);

      // Update or create Google Maps blue location dot marker
      if (currentGpsMarker) {
        currentGpsMarker.setPosition(latLng);
      } else {
        currentGpsMarker = new google.maps.Marker({
          map,
          position: latLng,
          title: 'Your Current Device Position',
          zIndex: 999,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 9,
            fillColor: '#1a73e8',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 3
          }
        });

        currentGpsMarker.addListener('click', () => {
          const pTitle = currentGpsPosition.address?.primaryPlace || 'Device Position';
          const pSub = [currentGpsPosition.address?.subPlace, currentGpsPosition.address?.district].filter(Boolean).join(' • ');
          const info = new google.maps.InfoWindow({
            content: `
              <div style="font-family: inherit; font-size: 0.8125rem; min-width: 200px; line-height: 1.4;">
                <strong style="color: #1a73e8; font-size: 0.9rem;">📍 ${escapeHTML(pTitle)}</strong><br>
                ${pSub ? `<span style="font-size: 0.75rem; color: #475569;">${escapeHTML(pSub)}</span><br>` : ''}
                <div style="margin-top: 0.35rem; font-size: 0.75rem; border-top: 1px solid #e2e8f0; padding-top: 0.25rem;">
                  <strong>Coordinates:</strong> ${lat.toFixed(6)}, ${lng.toFixed(6)}<br>
                  <strong>Accuracy:</strong> &plusmn;${accuracy}m (${tier.label})<br>
                  <strong>Source:</strong> ${escapeHTML(source)}
                </div>
              </div>
            `
          });
          info.open(map, currentGpsMarker);
        });
      }

      // Update or create Google Maps accuracy circle
      if (currentAccuracyCircle) {
        currentAccuracyCircle.setCenter(latLng);
        currentAccuracyCircle.setRadius(accuracy);
      } else {
        currentAccuracyCircle = new google.maps.Circle({
          map,
          center: latLng,
          radius: accuracy,
          fillColor: '#1a73e8',
          fillOpacity: 0.14,
          strokeColor: '#1a73e8',
          strokeOpacity: 0.5,
          strokeWeight: 1.5,
          clickable: false
        });
      }

      if (shouldPan) {
        map.panTo(latLng);
        if (map.getZoom() < 16) {
          map.setZoom(accuracy > 50 ? 16 : 17);
        }
      }
    }

    // Reverse geocode if moved > 50m
    const needsGeocode = !currentGpsPosition.address || (
      currentGpsPosition.lastGeocodedLat &&
      getDistanceFromLatLonInM(lat, lng, currentGpsPosition.lastGeocodedLat, currentGpsPosition.lastGeocodedLng) > 50
    );

    if (needsGeocode) {
      const details = await resolveGoogleReverseGeocode(lat, lng);
      currentGpsPosition.address = details;
      currentGpsPosition.lastGeocodedLat = lat;
      currentGpsPosition.lastGeocodedLng = lng;
    }

    updateLocationDisplay(lat, lng, accuracy, currentGpsPosition.address, coords);
    return currentGpsPosition;
  }

  /**
   * "Capture GPS Corner" Feature for In-Field Boundary Surveying
   */
  function captureGpsCorner() {
    if (drawState !== 'DRAWING') {
      showValidationMessage('Click "Start Drawing Parcel" first, then stand at each field boundary corner and click "Capture GPS Corner".', 'warning');
      return;
    }

    if (!currentGpsPosition || typeof currentGpsPosition.lat !== 'number') {
      showValidationMessage('No current GPS fix available. Click "Locate My Field (GPS)" to acquire your position first.', 'warning');
      return;
    }

    if (currentGpsPosition.accuracy > 35) {
      if (typeof confirm === 'function') {
        const confirmLowAcc = confirm(`Reported GPS accuracy is ±${currentGpsPosition.accuracy}m (approximate). Recording points with low accuracy may create inaccurate parcel boundaries. Would you like to record this corner anyway?`);
        if (!confirmLowAcc) return;
      }
    }

    const pt = { lat: currentGpsPosition.lat, lng: currentGpsPosition.lng };
    addVertex(pt);
    showValidationMessage(`Corner point ${vertices.length} captured from live GPS (±${currentGpsPosition.accuracy}m accuracy). Walk to the next corner and tap "Capture GPS Corner".`, 'success');
  }

  /**
   * Improve Location Accuracy Multi-Sample Convergence Engine
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

    showValidationMessage('Sampling multiple hardware location fixes to achieve the lowest uncertainty radius...', 'info');

    let samples = [];
    let initialAcc = currentGpsPosition ? currentGpsPosition.accuracy : 99999;
    let bestAcc = initialAcc;
    let bestSample = currentGpsPosition;

    let sampleWatch = null;
    let timer = null;

    const finishSampling = () => {
      if (sampleWatch !== null) {
        navigator.geolocation.clearWatch(sampleWatch);
        sampleWatch = null;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      isSamplingAccuracy = false;
      if (elements.btnImproveAccuracy) {
        elements.btnImproveAccuracy.disabled = false;
        elements.btnImproveAccuracy.classList.remove('sampling');
      }
      if (elements.improveBtnText) {
        elements.improveBtnText.textContent = 'Improve Location Accuracy';
      }

      if (bestSample && bestSample !== currentGpsPosition) {
        applyGpsReading(bestSample.lat, bestSample.lng, bestSample.accuracy, bestSample.timestamp, bestSample.coords, true);
      }

      if (bestAcc < initialAcc) {
        showValidationMessage(`Location accuracy improved from &plusmn;${initialAcc}m to &plusmn;${bestAcc}m. Center refined over field.`, 'success');
      } else if (bestAcc <= 20) {
        showValidationMessage(`High-precision satellite GNSS fix confirmed (&plusmn;${bestAcc}m). Ready to map boundaries.`, 'success');
      } else {
        showValidationMessage(`Sampling complete. Best fix available: &plusmn;${bestAcc}m. For sub-10m precision, access AgriTrust outdoors from a smartphone with clear sky view.`, 'info');
      }
    };

    sampleWatch = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = Math.round(pos.coords.accuracy);

        samples.push({ lat, lng, accuracy: acc, timestamp: pos.timestamp, coords: pos.coords });

        if (elements.improveBtnText) {
          elements.improveBtnText.textContent = `Sampling (${samples.length} fixes, best: ±${Math.min(bestAcc, acc)}m)...`;
        }

        if (acc < bestAcc) {
          bestAcc = acc;
          bestSample = { lat, lng, accuracy: acc, timestamp: pos.timestamp, coords: pos.coords };
          applyGpsReading(lat, lng, acc, pos.timestamp, pos.coords, false);
        }

        if (bestAcc <= 8 && samples.length >= 2) {
          finishSampling();
        }
      },
      (err) => {
        console.warn('[AgriTrustFieldManager] Sampling error:', err);
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0
      }
    );

    timer = setTimeout(() => {
      finishSampling();
    }, 7500);
  }

  /**
   * Classify location source and accuracy tiers
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
      if (accuracy <= 50) {
        return 'Wi-Fi Access Point Triangulation (802.11 BSSID)';
      }
      return 'Cellular / ISP Network Positioning (Coarse Lookup)';
    }
  }

  /**
   * Great-circle distance between two points on WGS84 sphere in meters
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
   * Render resolved details in location card
   */
  function updateLocationDisplay(lat, lng, accuracy, details, coords = null) {
    if (!elements.locationCard) return;
    elements.locationCard.style.display = 'block';

    const primary = details?.primaryPlace || 'Agricultural Area';
    const sub = details?.subPlace || '';
    const district = details?.district || '';
    const region = details?.region || '';

    if (elements.locPrimaryPlace) elements.locPrimaryPlace.textContent = primary;
    if (elements.locSubPlace) {
      elements.locSubPlace.textContent = sub;
      elements.locSubPlace.style.display = sub ? 'block' : 'none';
    }
    if (elements.locDistrict) {
      elements.locDistrict.textContent = district;
      elements.locDistrict.style.display = district ? 'block' : 'none';
    }
    if (elements.locRegion) elements.locRegion.textContent = region;
    if (elements.locCoords) elements.locCoords.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    const tierInfo = classifyAccuracyTier(accuracy);
    if (elements.locAccuracy) {
      elements.locAccuracy.textContent = accuracy > 0 ? `±${accuracy} m` : 'Target Point';
    }
    if (elements.locAccuracyTier) {
      elements.locAccuracyTier.textContent = tierInfo.label;
      elements.locAccuracyTier.className = `accuracy-tier-pill ${tierInfo.colorClass}`;
    }
    if (elements.locSource) {
      elements.locSource.textContent = classifyLocationSource(accuracy, coords);
    }

    // Extended GNSS Telemetry
    if (coords && (coords.altitude !== null || coords.speed !== null || coords.heading !== null)) {
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

    // Low accuracy warning
    if (elements.locAccuracyWarning) {
      if (accuracy > 50) {
        elements.locAccuracyWarning.style.display = 'block';
        if (elements.locAccuracyWarningText) {
          elements.locAccuracyWarningText.innerHTML = `
            Location accuracy is currently low (&plusmn;${accuracy}m). Laptops without satellite GPS chips rely on network positioning.
            For precision field boundaries (&le;15m), open AgriTrust outdoors on a smartphone or use the search bar to locate your parcel.
          `;
        }
      } else {
        elements.locAccuracyWarning.style.display = 'none';
      }
    }
  }

  /**
   * Field Boundary Drawing State Machine (Google Maps Polygons)
   */
  function toggleDrawingState() {
    if (drawState === 'IDLE') {
      startDrawing();
    } else if (drawState === 'DRAWING') {
      if (vertices.length >= 3) {
        closePolygon();
      } else {
        showValidationMessage('A field parcel boundary requires at least 3 points.', 'warning');
      }
    } else if (drawState === 'CLOSED') {
      // Reopen for editing
      drawState = 'DRAWING';
      updateUIForState();
      showValidationMessage('Parcel reopened for editing. Click the map or capture GPS corners to add points, then click "Complete Parcel".', 'info');
    }
  }

  function startDrawing() {
    resetDrawing();
    drawState = 'DRAWING';
    updateUIForState();
    if (elements.captureGpsCornerBtn) {
      elements.captureGpsCornerBtn.disabled = !(currentGpsPosition && currentGpsPosition.lat);
    }
    showValidationMessage('Click anywhere on the satellite image or click "Capture GPS Corner" to place the first boundary corner.', 'info');
  }

  function handleMapClick(latLng) {
    if (drawState !== 'DRAWING') return;
    addVertex(latLng);
  }

  function addVertex(latLng) {
    const pt = {
      lat: typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat,
      lng: typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng
    };

    vertices.push(pt);
    const idx = vertices.length - 1;
    const isFirst = idx === 0;

    const marker = createVertexMarker(pt, idx, isFirst);
    if (marker) {
      vertexMarkers.push(marker);
    }

    updatePolylinePreview();
    updateTelemetry();

    if (vertices.length === 1) {
      showValidationMessage('First corner placed. Click the next boundary corner or walk to it and capture GPS.', 'info');
    } else if (vertices.length === 2) {
      showValidationMessage('Second corner placed. Continue outlining your parcel (minimum 3 points required).', 'info');
    } else {
      showValidationMessage(`${vertices.length} corners placed. Click point 1 (golden pin) or click "Complete Parcel" to close the boundary.`, 'info');
    }
  }

  function createVertexMarker(point, index, isFirst = false) {
    if (!map || !window.google?.maps) return null;

    const latLng = new google.maps.LatLng(point.lat, point.lng);

    const marker = new google.maps.Marker({
      map,
      position: latLng,
      draggable: drawState === 'CLOSED',
      label: {
        text: String(index + 1),
        color: '#ffffff',
        fontWeight: 'bold',
        fontSize: '11px'
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 13,
        fillColor: isFirst ? '#d97706' : '#16a34a', // Golden for first anchor, emerald for others
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2
      },
      title: isFirst ? 'Corner 1 (Click to close parcel)' : `Corner ${index + 1}`
    });

    marker.addListener('click', () => {
      if (drawState === 'DRAWING' && index === 0 && vertices.length >= 3) {
        closePolygon();
      }
    });

    marker.addListener('drag', (e) => {
      vertices[index] = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      if (activePolygon) {
        activePolygon.setPath(vertices);
      }
      updateTelemetry();
    });

    marker.addListener('dragend', () => {
      validateAndRenderGeometry();
    });

    return marker;
  }

  function updatePolylinePreview() {
    if (previewPolyline) {
      previewPolyline.setMap(null);
      previewPolyline = null;
    }

    if (!map || !window.google?.maps) return;

    if (vertices.length > 1) {
      previewPolyline = new google.maps.Polyline({
        map,
        path: vertices,
        strokeColor: '#168a4d',
        strokeOpacity: 0.9,
        strokeWeight: 3,
        icons: [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
          offset: '0',
          repeat: '15px'
        }]
      });
    }
  }

  function closePolygon() {
    if (vertices.length < 3) {
      showValidationMessage('A valid parcel polygon requires at least 3 points.', 'warning');
      return;
    }

    drawState = 'CLOSED';

    if (previewPolyline) {
      previewPolyline.setMap(null);
      previewPolyline = null;
    }

    vertexMarkers.forEach(m => m.setDraggable(true));

    validateAndRenderGeometry();
    updateUIForState();
  }

  function validateAndRenderGeometry() {
    if (activePolygon) {
      activePolygon.setMap(null);
      activePolygon = null;
    }

    const validation = validatePolygon(vertices);

    if (validation.valid) {
      if (map && window.google?.maps) {
        activePolygon = new google.maps.Polygon({
          map,
          paths: vertices,
          strokeColor: '#168a4d',
          strokeOpacity: 0.95,
          strokeWeight: 3,
          fillColor: '#22c55e',
          fillOpacity: 0.28,
          clickable: false
        });
      }

      updateTelemetry(true);
      showValidationMessage(`Parcel boundary validated! Area: ${elements.telemetryAreaAcres?.textContent} acres (${elements.telemetryAreaHa?.textContent} ha). Drag corner markers to adjust. Fill in details and click "Save Parcel Boundary".`, 'success');
    } else {
      if (map && window.google?.maps) {
        activePolygon = new google.maps.Polygon({
          map,
          paths: vertices,
          strokeColor: '#be123c',
          strokeOpacity: 0.95,
          strokeWeight: 3,
          fillColor: '#f43f5e',
          fillOpacity: 0.28,
          clickable: false
        });
      }

      updateTelemetry(false);
      showValidationMessage(`Invalid Boundary: ${validation.error}`, 'error');
    }
  }

  /**
   * Geodesic Surface Area Calculation on WGS84 Ellipsoid (Google Geometry Library)
   */
  function calculateGeodesicArea(coords) {
    if (!coords || coords.length < 3) return 0;

    // Use Google Maps spherical geometry computeArea if available
    if (window.google?.maps?.geometry?.spherical) {
      const gPath = coords.map(c => new google.maps.LatLng(c.lat, c.lng));
      return google.maps.geometry.spherical.computeArea(gPath);
    }

    // Mathematical spherical excess fallback
    const R = 6378137;
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
    return Math.abs((total * R * R) / 2.0);
  }

  function validatePolygon(coords) {
    if (!coords || coords.length < 3) {
      return { valid: false, error: 'At least 3 boundary vertices are required.' };
    }

    const areaM2 = calculateGeodesicArea(coords);
    if (areaM2 <= 1.0) {
      return { valid: false, error: 'Calculated parcel area is too small or degenerate.' };
    }

    if (hasSelfIntersection(coords)) {
      return {
        valid: false,
        error: 'Parcel edges cross over each other. PostGIS requires simple, non-self-intersecting polygons. Drag corners to uncross edges.'
      };
    }

    return { valid: true, areaM2 };
  }

  function hasSelfIntersection(points) {
    const n = points.length;
    if (n < 4) return false;

    for (let i = 0; i < n; i++) {
      const a1 = points[i];
      const a2 = points[(i + 1) % n];

      for (let j = i + 1; j < n; j++) {
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

  function undoLastPoint() {
    if (vertices.length === 0) return;

    vertices.pop();
    const lastMarker = vertexMarkers.pop();
    if (lastMarker) {
      lastMarker.setMap(null);
    }

    if (drawState === 'CLOSED') {
      drawState = 'DRAWING';
      if (activePolygon) {
        activePolygon.setMap(null);
        activePolygon = null;
      }
      vertexMarkers.forEach(m => m.setDraggable(false));
    }

    updatePolylinePreview();
    updateTelemetry();
    updateUIForState();

    showValidationMessage(vertices.length > 0 ? `Removed last point. ${vertices.length} corners remaining.` : 'All points removed. Click map to place first corner.', 'info');
  }

  function resetDrawing() {
    drawState = 'IDLE';
    vertices = [];

    vertexMarkers.forEach(m => m.setMap(null));
    vertexMarkers = [];

    if (previewPolyline) {
      previewPolyline.setMap(null);
      previewPolyline = null;
    }

    if (activePolygon) {
      activePolygon.setMap(null);
      activePolygon = null;
    }

    updateTelemetry();
    updateUIForState();
  }

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

  function updateUIForState() {
    if (!elements.startDrawBtn) return;

    if (drawState === 'IDLE') {
      elements.startDrawBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        Start Drawing Parcel
      `;
      elements.startDrawBtn.className = 'btn btn-primary';
      if (elements.saveFieldBtn) elements.saveFieldBtn.disabled = true;
      if (elements.captureGpsCornerBtn) elements.captureGpsCornerBtn.disabled = true;
    } else if (drawState === 'DRAWING') {
      elements.startDrawBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        Complete Parcel (${vertices.length} pts)
      `;
      elements.startDrawBtn.className = 'btn btn-success';
      if (elements.saveFieldBtn) elements.saveFieldBtn.disabled = true;
      if (elements.captureGpsCornerBtn) {
        elements.captureGpsCornerBtn.disabled = !(currentGpsPosition && currentGpsPosition.lat);
      }
    } else if (drawState === 'CLOSED') {
      elements.startDrawBtn.innerHTML = `
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
        Edit Boundary Points
      `;
      elements.startDrawBtn.className = 'btn btn-secondary';
      if (elements.saveFieldBtn) elements.saveFieldBtn.disabled = false;
      if (elements.captureGpsCornerBtn) elements.captureGpsCornerBtn.disabled = true;
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
   * PostGIS Serialization: SRID=4326;POLYGON((lon lat, ...))
   */
  function toPostGISEWKT(coords) {
    if (!coords || coords.length < 3) return null;
    const pts = coords.map(c => `${c.lng.toFixed(7)} ${c.lat.toFixed(7)}`);
    pts.push(`${coords[0].lng.toFixed(7)} ${coords[0].lat.toFixed(7)}`);
    return `SRID=4326;POLYGON((${pts.join(', ')}))`;
  }

  /**
   * Save / Update Field Parcel into Supabase PostGIS
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
      showValidationMessage('Please provide a name for this field parcel.', 'warning');
      return;
    }
    if (!cropVariety) {
      showValidationMessage('Please enter the crop variety.', 'warning');
      return;
    }
    if (isNaN(acreageVal) || acreageVal <= 0) {
      showValidationMessage('Calculated parcel area must be greater than zero.', 'warning');
      return;
    }

    const ewkt = toPostGISEWKT(vertices);
    if (!ewkt) {
      showValidationMessage('Error generating PostGIS geometry from boundary.', 'error');
      return;
    }

    if (!window.AgriTrustSupabase) {
      showValidationMessage('Supabase client is not available.', 'error');
      return;
    }

    const user = await window.AgriTrustSupabase.getUser();
    if (!user) {
      showValidationMessage('You must be signed in to save this field. Please sign in via the portal modal.', 'warning');
      const loginModal = document.getElementById('authModal');
      if (loginModal) loginModal.classList.add('active');
      return;
    }

    if (elements.saveFieldBtn) {
      elements.saveFieldBtn.disabled = true;
      elements.saveFieldBtn.textContent = 'Saving to Database...';
    }

    let result;
    if (editingFieldId) {
      result = await window.AgriTrustSupabase.updateField(editingFieldId, {
        name,
        crop_variety: cropVariety,
        planting_date: plantingDate,
        acreage: acreageVal,
        boundary: ewkt,
        soil_texture_type: soilTexture
      });
    } else {
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
        : `Field "${safeName}" successfully registered in Supabase PostGIS! <a href="#dashboard" style="color: #166534; font-weight: 600; text-decoration: underline; margin-left: 0.5rem;">View in Farm Dashboard &rarr;</a>`;
      showValidationMessage(msg, 'success');
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
   * Load and render registered farmer fields from Supabase PostGIS
   */
  async function loadRegisteredFields() {
    if (!window.AgriTrustSupabase) return;

    // Clear existing Google field polygons & active NDVI overlays
    Object.values(savedFieldPolygons).forEach(p => p.setMap(null));
    savedFieldPolygons = {};
    savedFieldsMap = {};
    Object.values(activeNdviOverlays).forEach(ov => ov && ov.setMap && ov.setMap(null));
    activeNdviOverlays = {};

    const result = await window.AgriTrustSupabase.fetchUserFields();

    if (!result.success || !result.fields || result.fields.length === 0) {
      if (elements.registeredFieldsList) {
        elements.registeredFieldsList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0;">No registered parcels found for this account. Use the map to draw your first field!</p>';
      }
      return;
    }

    if (elements.registeredFieldsList) {
      elements.registeredFieldsList.innerHTML = '';
    }

    const overallBounds = new google.maps.LatLngBounds();
    let validBoundsCount = 0;

    result.fields.forEach((field) => {
      savedFieldsMap[field.id] = { field, poly: null };

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
          <div style="display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.4rem;">
            <button type="button" class="btn btn-subtle btn-sm js-focus-field" data-id="${field.id}">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              Focus on Map
            </button>
            <button type="button" class="btn btn-subtle btn-sm js-route-field" data-id="${field.id}" title="Calculate Google road directions to this parcel">
              🧭 Directions
            </button>
            <button type="button" class="btn btn-primary btn-sm js-scan-ndvi" data-id="${field.id}" title="Scan Sentinel-2 L2A NDVI for this parcel">
              🛰️ Scan Satellite NDVI
            </button>
          </div>
          <div id="ndvi-panel-${field.id}" class="field-ndvi-panel" style="display: none;"></div>
        `;

        item.querySelector('.js-focus-field').addEventListener('click', () => {
          focusField(field.id);
        });

        item.querySelector('.js-route-field').addEventListener('click', () => {
          routeToField(field.id);
        });

        item.querySelector('.js-scan-ndvi').addEventListener('click', () => {
          scanFieldNdvi(field.id);
        });

        elements.registeredFieldsList.appendChild(item);
      }

      // Render Google Maps Polygon
      const poly = renderSavedFieldPolygon(field);
      if (poly) {
        savedFieldPolygons[field.id] = poly;
        savedFieldsMap[field.id].poly = poly;

        const path = poly.getPath();
        path.forEach(pt => {
          overallBounds.extend(pt);
          validBoundsCount++;
        });
      }
    });

    // If user has saved fields, smoothly center and fit them on initial load
    if (validBoundsCount > 0 && map && !currentGpsPosition) {
      map.fitBounds(overallBounds);
    }
  }

  /**
   * Render existing PostGIS parcel boundary as Google Maps Polygon
   */
  function renderSavedFieldPolygon(field) {
    if (!field.boundary || !map) return null;

    const latLngs = parseBoundaryGeometry(field.boundary);
    if (!latLngs || latLngs.length < 3) return null;

    const googleCoords = latLngs.map(pt => ({ lat: pt[0], lng: pt[1] }));

    const poly = new google.maps.Polygon({
      map,
      paths: googleCoords,
      strokeColor: '#0284c7', // Cyan / Sky blue for verified parcels
      strokeOpacity: 0.95,
      strokeWeight: 2.5,
      fillColor: '#38bdf8',
      fillOpacity: 0.22,
      clickable: true
    });

    const infoWindow = new google.maps.InfoWindow({
      content: `
        <div style="font-family: inherit; font-size: 0.85rem; min-width: 210px; line-height: 1.45;">
          <strong style="color: #0369a1; font-size: 0.95rem;">${escapeHTML(field.name)}</strong><br>
          <strong>Acreage:</strong> ${field.acreage} ac<br>
          <strong>Crop:</strong> ${escapeHTML(field.crop_variety)}<br>
          ${field.planting_date ? `<strong>Planted:</strong> ${field.planting_date}<br>` : ''}
          ${field.soil_texture_type ? `<strong>Soil:</strong> ${escapeHTML(field.soil_texture_type)}<br>` : ''}
          <div style="margin-top: 0.5rem; display: flex; gap: 0.4rem;">
            <button type="button" class="btn btn-subtle btn-xs" id="infoRouteBtn_${field.id}" style="padding: 0.25rem 0.55rem; font-size: 0.75rem; font-weight: 600; cursor: pointer;">
              🧭 Directions
            </button>
            <button type="button" class="btn btn-subtle btn-xs" id="infoEditBtn_${field.id}" style="padding: 0.25rem 0.55rem; font-size: 0.75rem; cursor: pointer;">
              ✏️ Edit
            </button>
          </div>
        </div>
      `
    });

    poly.addListener('click', (e) => {
      infoWindow.setPosition(e.latLng);
      infoWindow.open(map);

      setTimeout(() => {
        const rBtn = document.getElementById(`infoRouteBtn_${field.id}`);
        if (rBtn) {
          rBtn.onclick = () => {
            infoWindow.close();
            routeToField(field.id);
          };
        }
        const eBtn = document.getElementById(`infoEditBtn_${field.id}`);
        if (eBtn) {
          eBtn.onclick = () => {
            infoWindow.close();
            loadFieldForEditing(field);
          };
        }
      }, 50);
    });

    return poly;
  }

  /**
   * Focus on saved field parcel
   */
  function focusField(fieldId) {
    const entry = savedFieldsMap[fieldId];
    if (!entry || !entry.poly || !map) return false;

    const el = document.getElementById('fields');
    if (el) el.scrollIntoView({ behavior: 'smooth' });

    const bounds = new google.maps.LatLngBounds();
    entry.poly.getPath().forEach(pt => bounds.extend(pt));
    map.fitBounds(bounds);

    return true;
  }

  function loadFieldForEditing(field) {
    const el = document.getElementById('fields');
    if (el) el.scrollIntoView({ behavior: 'smooth' });

    editingFieldId = field.id;

    const latLngs = parseBoundaryGeometry(field.boundary);
    if (!latLngs || latLngs.length < 3) return;

    resetDrawing();
    editingFieldId = field.id;
    vertices = latLngs.map(pt => ({ lat: pt[0], lng: pt[1] }));

    // Create vertex markers
    vertices.forEach((pt, i) => {
      const m = createVertexMarker(pt, i, i === 0);
      m.setDraggable(true);
      vertexMarkers.push(m);
    });

    closePolygon();

    if (elements.fieldNameInput) elements.fieldNameInput.value = field.name || '';
    if (elements.cropVarietyInput) elements.cropVarietyInput.value = field.crop_variety || '';
    if (elements.plantingDateInput) elements.plantingDateInput.value = field.planting_date || '';
    if (elements.soilTextureSelect) elements.soilTextureSelect.value = field.soil_texture_type || '';
    if (elements.fieldAcreageInput) elements.fieldAcreageInput.value = field.acreage || '';

    focusField(field.id);
    showValidationMessage(`Editing parcel "${field.name}". Drag boundary corner handles on the Google map to adjust, then click "Save Parcel Boundary".`, 'info');
  }

  /**
   * Scan & compute real Copernicus Sentinel-2 L2A NDVI for a registered field parcel boundary.
   * Dispatches authenticated request to /api/satellite/process-field and displays canopy metrics.
   */
  async function scanFieldNdvi(fieldId, explicitFieldName = null) {
    if (!fieldId) return;

    const entry = savedFieldsMap[fieldId];
    const fieldName = explicitFieldName || (entry && entry.field ? entry.field.name : 'Selected Field');

    // Target inline panel in field card
    const panel = document.getElementById(`ndvi-panel-${fieldId}`);
    const btn = document.querySelector(`.js-scan-ndvi[data-id="${fieldId}"]`);

    // Target dedicated modal if present
    const modal = document.getElementById('fieldNdviModal');
    const modalBody = document.getElementById('fieldNdviModalBody');
    const modalSubtitle = document.getElementById('ndviModalSubtitle');

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `
        <svg class="spin-animation" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <circle cx="12" cy="12" r="10" stroke-width="3" stroke-dasharray="32" stroke-linecap="round"></circle>
        </svg>
        Scanning Sentinel-2...
      `;
    }

    const loadingHtml = `
      <div class="ndvi-loading-box">
        <div class="ndvi-loading-spinner"></div>
        <div>
          <strong>Acquiring Sentinel-2 L2A Multispectral Imagery</strong>
          <p style="margin: 0.25rem 0 0; font-size: 0.75rem; color: var(--text-muted);">
            Connecting to Copernicus Data Space, evaluating B04 (Red) & B08 (NIR) for "${escapeHTML(fieldName)}"...
          </p>
        </div>
      </div>
    `;

    if (panel) {
      panel.style.display = 'block';
      panel.innerHTML = loadingHtml;
    }

    if (modal && modalBody) {
      if (modalSubtitle) modalSubtitle.textContent = `Processing real Sentinel-2 multispectral reflectance for "${fieldName}"`;
      modalBody.innerHTML = loadingHtml;
      modal.classList.add('active');
    }

    try {
      if (!window.AgriTrustSupabase || !window.AgriTrustSupabase.processFieldSatelliteNdvi) {
        throw new Error('Supabase client satellite service not initialized.');
      }

      const result = await window.AgriTrustSupabase.processFieldSatelliteNdvi(fieldId);

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '🛰️ Re-scan Satellite NDVI';
      }

      if (!result.success) {
        const errorHtml = `
          <div class="ndvi-error-box">
            <div class="ndvi-error-title">⚠️ Satellite Scan Failed</div>
            <div class="ndvi-error-msg">${escapeHTML(result.message || 'Processing failed')}</div>
            <button type="button" class="btn btn-subtle btn-xs" onclick="AgriTrustFieldManager.scanFieldNdvi('${fieldId}')" style="margin-top: 0.4rem;">
              Retry Scan
            </button>
          </div>
        `;
        if (panel) panel.innerHTML = errorHtml;
        if (modalBody) modalBody.innerHTML = errorHtml;
        return;
      }

      // Success: determine canopy vigor classification from real mean_ndvi
      const meanNdvi = typeof result.mean_ndvi === 'number' ? result.mean_ndvi : parseFloat(result.mean_ndvi || 0);
      const minNdvi = typeof result.min_ndvi === 'number' ? result.min_ndvi : parseFloat(result.min_ndvi || 0);
      const maxNdvi = typeof result.max_ndvi === 'number' ? result.max_ndvi : parseFloat(result.max_ndvi || 0);
      const cloudPct = typeof result.cloud_coverage_pct === 'number' ? result.cloud_coverage_pct : parseFloat(result.cloud_coverage_pct || 0);

      let vigorBadgeClass = 'vigor-moderate';
      let vigorText = 'Moderate Vigor';
      if (meanNdvi >= 0.6) {
        vigorBadgeClass = 'vigor-high';
        vigorText = 'Lush / High Vigor';
      } else if (meanNdvi >= 0.3) {
        vigorBadgeClass = 'vigor-moderate';
        vigorText = 'Moderate Vigor';
      } else if (meanNdvi >= 0.1) {
        vigorBadgeClass = 'vigor-low';
        vigorText = 'Sparse / Low Vigor';
      } else {
        vigorBadgeClass = 'vigor-bare';
        vigorText = 'Bare Soil / Water';
      }

      // Check if generated NDVI raster is available for map overlay
      const rasterUrl = result.raster_url || result.signed_raster_url || result.tile_url || null;
      let overlayRendered = false;
      if (rasterUrl) {
        overlayRendered = displayNdviRasterOnMap(fieldId, rasterUrl);
      }

      const storageStatus = result.stored_in_storage
        ? '<span class="status-pill status-success">✓ Saved in Supabase (satellite-rasters)</span>'
        : '<span class="status-pill status-neutral">Computed Server-side</span>';

      const dbStatus = result.stored_in_database
        ? '<span class="status-pill status-success">✓ Synced to satellite_indices</span>'
        : '';

      const overlayStatus = overlayRendered
        ? '<span class="status-pill status-success">✓ NDVI Overlay Active on Google Map</span>'
        : (rasterUrl ? '<span class="status-pill status-success">✓ Raster Image Available</span>' : '');

      let rasterPreviewHtml = '';
      if (rasterUrl) {
        rasterPreviewHtml = `
          <div class="ndvi-raster-preview-box">
            <img src="${escapeHTML(rasterUrl)}" alt="Sentinel-2 NDVI Raster" class="ndvi-raster-thumb" />
            <div class="ndvi-raster-meta">
              <strong>🛰️ Sentinel-2 L2A Surface Reflectance Raster</strong>
              <div style="display: flex; gap: 0.4rem; margin-top: 0.25rem; flex-wrap: wrap;">
                <button type="button" class="btn btn-secondary btn-xs" onclick="AgriTrustFieldManager.focusFieldAndShowRaster('${fieldId}')">
                  🗺️ Pan to Map Overlay
                </button>
                <button type="button" class="btn btn-subtle btn-xs" onclick="AgriTrustFieldManager.clearNdviRasterOverlay('${fieldId}')">
                  ✕ Hide Overlay
                </button>
              </div>
            </div>
          </div>
        `;
      }

      const resultsHtml = `
        <div class="ndvi-results-card">
          <div class="ndvi-results-header">
            <div>
              <span class="ndvi-platform-tag">🛰️ ${escapeHTML(result.satellite_platform || 'Sentinel-2 L2A')}</span>
              <span class="ndvi-date-tag">📅 Acquired: <strong>${escapeHTML(result.acquisition_date || 'Latest Pass')}</strong></span>
            </div>
            <span class="ndvi-vigor-badge ${vigorBadgeClass}">${vigorText}</span>
          </div>

          <div class="ndvi-metrics-grid">
            <div class="ndvi-metric-item highlight">
              <span class="ndvi-metric-label">Mean Field NDVI</span>
              <span class="ndvi-metric-val">${meanNdvi.toFixed(4)}</span>
            </div>
            <div class="ndvi-metric-item">
              <span class="ndvi-metric-label">NDVI Range (Min / Max)</span>
              <span class="ndvi-metric-val">${minNdvi.toFixed(2)} — ${maxNdvi.toFixed(2)}</span>
            </div>
            <div class="ndvi-metric-item">
              <span class="ndvi-metric-label">Cloud Coverage</span>
              <span class="ndvi-metric-val">${cloudPct.toFixed(1)}%</span>
            </div>
            <div class="ndvi-metric-item">
              <span class="ndvi-metric-label">Parcel Pixels Analyzed</span>
              <span class="ndvi-metric-val">${result.valid_pixels || '--'} / ${result.total_pixels || '--'}</span>
            </div>
          </div>

          ${rasterPreviewHtml}

          <div class="ndvi-storage-meta">
            ${storageStatus}
            ${dbStatus}
            ${overlayStatus}
          </div>
        </div>
      `;

      if (panel) panel.innerHTML = resultsHtml;
      if (modalBody) modalBody.innerHTML = resultsHtml;

    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '🛰️ Scan Satellite NDVI';
      }
      const connErrorHtml = `
        <div class="ndvi-error-box">
          <div class="ndvi-error-title">Connection Error</div>
          <div class="ndvi-error-msg">${escapeHTML(err.message || 'Could not connect to satellite processing service.')}</div>
        </div>
      `;
      if (panel) panel.innerHTML = connErrorHtml;
      if (modalBody) modalBody.innerHTML = connErrorHtml;
    }
  }

  /**
   * Display generated Sentinel-2 NDVI raster over the farmer's Google Maps field boundary
   */
  function displayNdviRasterOnMap(fieldId, rasterUrl) {
    if (!rasterUrl || !map || !window.google?.maps?.GroundOverlay) {
      return false;
    }

    // Clear existing overlay for this field if present
    if (activeNdviOverlays[fieldId]) {
      activeNdviOverlays[fieldId].setMap(null);
      delete activeNdviOverlays[fieldId];
    }

    const entry = savedFieldsMap[fieldId];
    let field = entry ? entry.field : null;
    if (!field && window.AgriTrustFarmerDashboard && window.AgriTrustFarmerDashboard.getFieldById) {
      field = window.AgriTrustFarmerDashboard.getFieldById(fieldId);
    }

    const bounds = new google.maps.LatLngBounds();
    if (entry && entry.poly && entry.poly.getPath) {
      entry.poly.getPath().forEach(pt => bounds.extend(pt));
    } else if (field && field.boundary) {
      const latLngs = parseBoundaryGeometry(field.boundary);
      if (latLngs && latLngs.length >= 3) {
        latLngs.forEach(pt => bounds.extend(new google.maps.LatLng(pt[0], pt[1])));
      }
    }

    if (bounds.isEmpty()) {
      console.warn('[AgriTrustFieldManager] Cannot display NDVI raster overlay: parcel boundary bounds are empty.');
      return false;
    }

    const overlay = new google.maps.GroundOverlay(rasterUrl, bounds, {
      opacity: 0.85,
      clickable: true
    });

    overlay.addListener('click', () => {
      focusField(fieldId);
    });

    overlay.setMap(map);
    activeNdviOverlays[fieldId] = overlay;

    return true;
  }

  /**
   * Clear active NDVI raster overlay for a field
   */
  function clearNdviRasterOverlay(fieldId) {
    if (activeNdviOverlays[fieldId]) {
      activeNdviOverlays[fieldId].setMap(null);
      delete activeNdviOverlays[fieldId];
      return true;
    }
    return false;
  }

  /**
   * Smoothly scroll to map, close modal, and focus field parcel with its NDVI overlay
   */
  function focusFieldAndShowRaster(fieldId) {
    const ndviModal = document.getElementById('fieldNdviModal');
    if (ndviModal) {
      ndviModal.classList.remove('active');
      document.body.style.overflow = '';
    }

    const el = document.getElementById('fields');
    if (el) el.scrollIntoView({ behavior: 'smooth' });

    focusField(fieldId);
  }

  /**
   * Turn-by-Turn Road Navigation using Google Directions Service
   */
  async function routeToField(fieldId) {
    const entry = savedFieldsMap[fieldId];
    if (!entry || !entry.field) {
      showValidationMessage('Field parcel not found for routing.', 'warning');
      return;
    }

    const field = entry.field;
    let destLatLng = null;

    if (entry.poly) {
      const bounds = new google.maps.LatLngBounds();
      entry.poly.getPath().forEach(pt => bounds.extend(pt));
      destLatLng = bounds.getCenter();
    } else if (field.boundary) {
      const coords = parseBoundaryGeometry(field.boundary);
      if (coords && coords.length > 0) {
        destLatLng = new google.maps.LatLng(coords[0][0], coords[0][1]);
      }
    }

    if (!destLatLng) {
      showValidationMessage('Could not determine field coordinates for route calculation.', 'warning');
      return;
    }

    let originLatLng;
    let originName;
    if (currentGpsPosition && typeof currentGpsPosition.lat === 'number') {
      originLatLng = new google.maps.LatLng(currentGpsPosition.lat, currentGpsPosition.lng);
      originName = currentGpsPosition.address?.primaryPlace || 'Your Device GPS Position';
    } else {
      originLatLng = map.getCenter();
      originName = 'Current Map Center';
    }

    if (elements.routePanel) elements.routePanel.style.display = 'block';
    if (elements.routeOriginName) elements.routeOriginName.textContent = originName;
    if (elements.routeDestName) elements.routeDestName.textContent = field.name;

    showValidationMessage(`Calculating real road route to ${field.name} via Google Directions...`, 'info');

    const travelMode = selectedRouteMode === 'walking'
      ? google.maps.TravelMode.WALKING
      : google.maps.TravelMode.DRIVING;

    directionsService.route({
      origin: originLatLng,
      destination: destLatLng,
      travelMode: travelMode
    }, (result, status) => {
      if (status === google.maps.DirectionsStatus.OK && result.routes && result.routes[0]) {
        directionsRenderer.setDirections(result);

        const leg = result.routes[0].legs[0];
        const distText = leg.distance.text;
        const durText = leg.duration.text;

        if (elements.routeMetrics) elements.routeMetrics.style.display = 'grid';
        if (elements.routeDirectDistance) elements.routeDirectDistance.textContent = `${(leg.distance.value / 1000).toFixed(1)} km`;
        if (elements.routeRoadDistance) elements.routeRoadDistance.textContent = distText;
        if (elements.routeTravelTime) elements.routeTravelTime.textContent = durText;
        if (elements.routingNoticeText) {
          elements.routingNoticeText.textContent = `Turn-by-turn road route computed via Google Maps (${leg.distance.text}, ${leg.duration.text}).`;
        }
        if (elements.clearRouteBtn) elements.clearRouteBtn.style.display = 'block';

        showValidationMessage(`Google road navigation calculated: ${distText} (~${durText}).`, 'success');
      } else {
        console.warn('[AgriTrustFieldManager] Directions failed:', status);
        showValidationMessage(`Could not calculate road route: ${status}. If across water or unpaved tracks, verify endpoints.`, 'warning');
      }
    });
  }

  function clearActiveRoute() {
    if (directionsRenderer) {
      directionsRenderer.set('directions', null);
    }
    if (elements.routeMetrics) elements.routeMetrics.style.display = 'none';
    if (elements.clearRouteBtn) elements.clearRouteBtn.style.display = 'none';
    if (elements.routeDestName) elements.routeDestName.textContent = 'Select a Field Parcel';
    if (elements.routingNoticeText) {
      elements.routingNoticeText.textContent = 'Click "🧭 Directions" on any registered field parcel to calculate Google road directions.';
    }
  }

  function setRouteMode(mode) {
    selectedRouteMode = mode;
    if (elements.routeModeBtns) {
      elements.routeModeBtns.forEach(btn => {
        if (btn.dataset.mode === mode) btn.classList.add('active');
        else btn.classList.remove('active');
      });
    }
  }

  /**
   * Geometry Decoding Helpers (Hex EWKB, WKT, GeoJSON)
   */
  function parseBoundaryGeometry(boundary) {
    if (!boundary) return null;

    try {
      if (typeof boundary === 'object' && boundary.coordinates) {
        const ring = boundary.coordinates[0];
        return ring.map(pt => [pt[1], pt[0]]);
      }

      if (typeof boundary === 'string') {
        const s = boundary.trim();

        if (s.startsWith('{') && s.endsWith('}')) {
          try {
            const parsed = JSON.parse(s);
            if (parsed && parsed.coordinates) {
              const ring = parsed.coordinates[0];
              return ring.map(pt => [pt[1], pt[0]]);
            }
          } catch (e) {}
        }

        const wktMatch = s.match(/POLYGON\s*\(\(\s*(.+?)\s*\)\)/i);
        if (wktMatch) {
          const pairs = wktMatch[1].split(',');
          const latLngs = [];
          pairs.forEach(pair => {
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
      console.warn('[AgriTrustFieldManager] Hex EWKB parse error:', e);
    }
    return null;
  }

  /**
   * Toggle Fullscreen Map Mode
   */
  function toggleFullscreen() {
    if (!elements.mapWrapper) return;

    if (!isFullscreen) {
      if (elements.mapWrapper.requestFullscreen) {
        elements.mapWrapper.requestFullscreen().catch(() => {});
      }
      elements.mapWrapper.classList.add('map-fullscreen-active');
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
      if (map && window.google?.maps?.event) {
        google.maps.event.trigger(map, 'resize');
      }
    }, 200);
  }

  /**
   * Multilingual Language Switching
   */
  function setLanguage(lang) {
    if (!lang) return;
    currentLanguage = lang;
    if (elements.langButtons) {
      elements.langButtons.forEach(b => {
        if (b.dataset.lang === lang) b.classList.add('active');
        else b.classList.remove('active');
      });
    }

    if (currentGpsPosition && typeof currentGpsPosition.lat === 'number') {
      resolveGoogleReverseGeocode(currentGpsPosition.lat, currentGpsPosition.lng).then(details => {
        currentGpsPosition.address = details;
        updateLocationDisplay(currentGpsPosition.lat, currentGpsPosition.lng, currentGpsPosition.accuracy, details, currentGpsPosition.coords);
      });
    }
  }

  /**
   * Auth state check and load fields
   */
  async function checkAuthState() {
    if (window.AgriTrustSupabase && window.AgriTrustSupabase.ready) {
      await window.AgriTrustSupabase.ready();
    }

    if (!window.AgriTrustSupabase || !window.AgriTrustSupabase.isReady()) {
      showAuthGateNotice('Supabase is not configured yet. Configure local .env to enable remote parcel persistence.', 'warning');
      if (elements.registeredFieldsList) {
        elements.registeredFieldsList.innerHTML = `
          <div class="unauth-map-notice">
            <div style="font-weight: 600; color: #0f172a; margin-bottom: 0.25rem;">🔒 Private Farm Data Protection</div>
            Sign in to your farm account to view and manage your private registered field parcels. Your parcel boundaries, GPS coordinates, and soil data remain strictly private and protected by Supabase Row Level Security.
          </div>
        `;
      }
      return;
    }

    const user = await window.AgriTrustSupabase.getUser();
    if (user) {
      showAuthGateNotice(`Authenticated as ${user.email}. Saved field parcels will be associated with your farm ID.`, 'success');
      loadRegisteredFields();
    } else {
      showAuthGateNotice('Drawing in preview mode. Sign In or Register to save your field boundaries into the cloud database.', 'info');
      if (elements.registeredFieldsList) {
        elements.registeredFieldsList.innerHTML = `
          <div class="unauth-map-notice">
            <div style="font-weight: 600; color: #0f172a; margin-bottom: 0.25rem;">🔒 Private Farm Data Protection</div>
            Sign in to your farm account to view and manage your private registered field parcels. Your parcel boundaries, GPS coordinates, and soil data remain strictly private and protected by Supabase Row Level Security.
          </div>
        `;
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
    elements.authGateNotice.textContent = message;
  }

  /**
   * Bind event listeners
   */
  function bindUIEvents() {
    if (elements.startDrawBtn) elements.startDrawBtn.addEventListener('click', toggleDrawingState);
    if (elements.captureGpsCornerBtn) elements.captureGpsCornerBtn.addEventListener('click', captureGpsCorner);
    if (elements.undoPointBtn) elements.undoPointBtn.addEventListener('click', undoLastPoint);
    if (elements.clearPolyBtn) elements.clearPolyBtn.addEventListener('click', resetDrawing);
    if (elements.locateGpsBtn) elements.locateGpsBtn.addEventListener('click', handleExplicitGeolocation);
    if (elements.toggleTrackingBtn) elements.toggleTrackingBtn.addEventListener('click', toggleTracking);
    if (elements.basemapToggleBtn) elements.basemapToggleBtn.addEventListener('click', toggleBasemap);

    if (elements.toggleRoutingBtn) {
      elements.toggleRoutingBtn.addEventListener('click', () => {
        if (!elements.routePanel) return;
        const isHidden = elements.routePanel.style.display === 'none' || !elements.routePanel.style.display;
        elements.routePanel.style.display = isHidden ? 'block' : 'none';
      });
    }

    if (elements.closeRoutePanelBtn) {
      elements.closeRoutePanelBtn.addEventListener('click', () => {
        if (elements.routePanel) elements.routePanel.style.display = 'none';
      });
    }

    if (elements.routeModeBtns) {
      elements.routeModeBtns.forEach(btn => {
        btn.addEventListener('click', () => setRouteMode(btn.dataset.mode));
      });
    }

    if (elements.clearRouteBtn) elements.clearRouteBtn.addEventListener('click', clearActiveRoute);
    if (elements.fullscreenBtn) elements.fullscreenBtn.addEventListener('click', toggleFullscreen);

    if (elements.closeLocationCardBtn) {
      elements.closeLocationCardBtn.addEventListener('click', () => {
        if (elements.locationCard) elements.locationCard.style.display = 'none';
      });
    }

    if (elements.btnImproveAccuracy) elements.btnImproveAccuracy.addEventListener('click', improveLocationAccuracy);
    if (elements.saveFieldForm) elements.saveFieldForm.addEventListener('submit', handleFieldFormSubmit);

    // Satellite NDVI Modal close handlers
    const ndviModal = document.getElementById('fieldNdviModal');
    const closeNdviBtn = document.getElementById('closeFieldNdviModal');
    const closeNdviBtnBottom = document.getElementById('btnCloseNdviModalBottom');
    const closeNdvi = () => {
      if (ndviModal) {
        ndviModal.classList.remove('active');
        document.body.style.overflow = '';
      }
    };
    if (closeNdviBtn) closeNdviBtn.addEventListener('click', closeNdvi);
    if (closeNdviBtnBottom) closeNdviBtnBottom.addEventListener('click', closeNdvi);
    if (ndviModal) {
      ndviModal.addEventListener('click', (e) => {
        if (e.target === ndviModal) closeNdvi();
      });
    }

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
        if (map && window.google?.maps?.event) {
          google.maps.event.trigger(map, 'resize');
        }
      }
    });
  }

  /**
   * Main Initialization
   */
  async function init() {
    cacheDOMElements();
    if (!elements.mapContainer) {
      console.warn('[AgriTrustFieldManager] Map container #fieldMap not found in DOM.');
      return;
    }

    bindUIEvents();
    checkAuthState();
    await initMap();

    if (window.AgriTrustSupabase && window.AgriTrustSupabase.onAuthStateChange) {
      window.AgriTrustSupabase.onAuthStateChange(() => {
        checkAuthState();
      });
    }

    window.addEventListener('agritrust:supabaseReady', () => {
      checkAuthState();
    });
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
    resolveGeographicLocation: resolveGoogleReverseGeocode,
    getCurrentGpsPosition: () => currentGpsPosition,
    toggleFullscreen,
    searchLocation: handleDirectCoordinateSearch,
    locateGps: handleExplicitGeolocation,
    improveLocationAccuracy,
    toggleTracking,
    startTracking,
    stopTracking,
    captureGpsCorner,
    registerExternalGnss: (p) => { externalGnssProvider = p; },
    setExternalGnssPosition: (d) => { if (d) applyGpsReading(d.latitude, d.longitude, d.accuracy || 1, Date.now(), d, true); },
    classifyAccuracyTier,
    classifyLocationSource,
    isMobileDevice,
    applyGpsReading,
    routeToField,
    clearActiveRoute,
    setRouteMode,
    getRouteMode: () => selectedRouteMode,
    setLanguage,
    getCurrentLanguage: () => currentLanguage,
    setBasemap: (type) => { if (map && type) map.setMapTypeId(type); },
    getMap: () => map,
    isGoogleMapsLoaded: () => googleMapsLoaded,
    scanFieldNdvi,
    displayNdviRasterOnMap,
    clearNdviRasterOverlay,
    focusFieldAndShowRaster,
    checkAuthState
  };
})();

// Bind to window and globalThis
if (typeof window !== 'undefined') {
  window.AgriTrustFieldManager = AgriTrustFieldManager;
}
if (typeof globalThis !== 'undefined') {
  globalThis.AgriTrustFieldManager = AgriTrustFieldManager;
}

// Auto-initialize on DOM ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      AgriTrustFieldManager.init();
    });
  } else {
    AgriTrustFieldManager.init();
  }
}
