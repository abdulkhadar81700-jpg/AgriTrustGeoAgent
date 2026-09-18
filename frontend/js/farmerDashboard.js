/**
 * AgriTrustGeoAgent - Farmer Operations Dashboard Controller
 * Protected workspace, real-time KPI metrics, full field CRUD (Create, View, Edit, Delete),
 * profile synchronization, and deep satellite map integration.
 */

const AgriTrustFarmerDashboard = (() => {
  let currentUser = null;
  let userProfile = null;
  let userFields = [];
  let pendingDeleteFieldId = null;

  // DOM Elements
  let dom = {};

  function init() {
    cacheDOM();
    bindEvents();
    syncAuthState();

    // Subscribe to auth state changes from Supabase
    if (window.AgriTrustSupabase && window.AgriTrustSupabase.onAuthStateChange) {
      window.AgriTrustSupabase.onAuthStateChange((event, session) => {
        syncAuthState();
      });
    }

    // Listen for Supabase client readiness
    window.addEventListener('agritrust:supabaseReady', () => {
      syncAuthState();
    });

    // Listen for field saved events from map tool
    window.addEventListener('agritrust:fieldSaved', () => {
      loadDashboardData();
    });
  }

  function cacheDOM() {
    dom = {
      // Header elements
      headerGuestActions: document.getElementById('headerGuestActions'),
      headerUserActions: document.getElementById('headerUserActions'),
      userChipName: document.getElementById('userChipName'),
      userChipOrg: document.getElementById('userChipOrg'),
      btnSignOut: document.getElementById('btnHeaderSignOut'),
      mobileUserActions: document.getElementById('mobileUserActions'),
      mobileGuestActions: document.getElementById('mobileGuestActions'),
      mobileUserEmail: document.getElementById('mobileUserEmail'),
      btnMobileSignOut: document.getElementById('btnMobileSignOut'),

      // Dashboard section
      dashboardSection: document.getElementById('dashboard'),
      dashboardAccessGate: document.getElementById('dashboardAccessGate'),
      dashboardContent: document.getElementById('dashboardContent'),
      farmerWelcomeName: document.getElementById('farmerWelcomeName'),
      farmerOrgBadge: document.getElementById('farmerOrgBadge'),
      btnOpenProfile: document.getElementById('btnOpenProfile'),
      btnRefreshDashboard: document.getElementById('btnRefreshDashboard'),
      btnGoToCamera: document.getElementById('btnGoToCamera'),
      btnGoToMapAdd: document.getElementById('btnGoToMapAdd'),

      // Metrics
      kpiTotalFields: document.getElementById('kpiTotalFields'),
      kpiTotalAcres: document.getElementById('kpiTotalAcres'),
      kpiTotalHa: document.getElementById('kpiTotalHa'),
      kpiCropCount: document.getElementById('kpiCropCount'),
      kpiRecentField: document.getElementById('kpiRecentField'),

      // Fields list
      fieldsTableBody: document.getElementById('fieldsTableBody'),
      fieldsCardsMobile: document.getElementById('fieldsCardsMobile'),
      emptyFieldsNotice: document.getElementById('emptyFieldsNotice'),
      dashboardFeedback: document.getElementById('dashboardFeedback'),

      // Edit Field Modal
      editFieldModal: document.getElementById('editFieldModal'),
      closeEditModalBtn: document.getElementById('closeEditFieldModal'),
      editFieldForm: document.getElementById('editFieldForm'),
      editFieldId: document.getElementById('editFieldId'),
      editFieldName: document.getElementById('editFieldName'),
      editCropVariety: document.getElementById('editCropVariety'),
      editPlantingDate: document.getElementById('editPlantingDate'),
      editSoilTexture: document.getElementById('editSoilTexture'),
      editFieldAcreage: document.getElementById('editFieldAcreage'),
      btnRedrawBoundary: document.getElementById('btnRedrawBoundary'),
      editFieldFeedback: document.getElementById('editFieldFeedback'),

      // Delete Confirmation Modal
      deleteModal: document.getElementById('deleteFieldModal'),
      deleteFieldName: document.getElementById('deleteFieldName'),
      btnConfirmDelete: document.getElementById('btnConfirmDelete'),
      btnCancelDelete: document.getElementById('btnCancelDelete'),

      // Profile Modal
      profileModal: document.getElementById('farmerProfileModal'),
      closeProfileModalBtn: document.getElementById('closeProfileModal'),
      profileForm: document.getElementById('farmerProfileForm'),
      profileEmail: document.getElementById('profileEmail'),
      profileFullName: document.getElementById('profileFullName'),
      profileOrgName: document.getElementById('profileOrgName'),
      profilePhone: document.getElementById('profilePhone'),
      profileFeedback: document.getElementById('profileFeedback'),
      linkedIdentitiesList: document.getElementById('linkedIdentitiesList'),
      btnLinkGoogle: document.getElementById('btnLinkGoogle')
    };
  }

  function bindEvents() {
    if (dom.btnSignOut) {
      dom.btnSignOut.addEventListener('click', handleSignOut);
    }
    if (dom.btnMobileSignOut) {
      dom.btnMobileSignOut.addEventListener('click', handleSignOut);
    }
    if (dom.btnRefreshDashboard) {
      dom.btnRefreshDashboard.addEventListener('click', () => {
        loadDashboardData(true);
      });
    }
    if (dom.btnGoToCamera) {
      dom.btnGoToCamera.addEventListener('click', () => {
        const cameraSection = document.getElementById('crop-camera');
        if (cameraSection) cameraSection.scrollIntoView({ behavior: 'smooth' });
      });
    }
    if (dom.btnGoToMapAdd) {
      dom.btnGoToMapAdd.addEventListener('click', () => {
        const fieldsSection = document.getElementById('fields');
        if (fieldsSection) fieldsSection.scrollIntoView({ behavior: 'smooth' });
        if (window.AgriTrustFieldManager && typeof window.AgriTrustFieldManager.startDrawing === 'function') {
          setTimeout(() => {
            window.AgriTrustFieldManager.startDrawing();
          }, 450);
        }
      });
    }

    const drawFirstBtn = dom.emptyFieldsNotice?.querySelector('a[href="#fields"]');
    if (drawFirstBtn) {
      drawFirstBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const fieldsSection = document.getElementById('fields');
        if (fieldsSection) fieldsSection.scrollIntoView({ behavior: 'smooth' });
        if (window.AgriTrustFieldManager && typeof window.AgriTrustFieldManager.startDrawing === 'function') {
          setTimeout(() => {
            window.AgriTrustFieldManager.startDrawing();
          }, 450);
        }
      });
    }

    if (dom.farmerOrgBadge) {
      dom.farmerOrgBadge.style.cursor = 'pointer';
      dom.farmerOrgBadge.setAttribute('title', 'Click to edit or establish farm enterprise name');
      dom.farmerOrgBadge.addEventListener('click', openProfileModal);
    }

    // Profile modal
    if (dom.btnOpenProfile) {
      dom.btnOpenProfile.addEventListener('click', openProfileModal);
    }
    if (dom.closeProfileModalBtn) {
      dom.closeProfileModalBtn.addEventListener('click', closeProfileModal);
    }
    if (dom.profileForm) {
      dom.profileForm.addEventListener('submit', handleProfileSubmit);
    }
    if (dom.btnLinkGoogle) {
      dom.btnLinkGoogle.addEventListener('click', async () => {
        showProfileFeedback('Initiating secure Google account linking...', 'info');
        if (window.AgriTrustSupabase && window.AgriTrustSupabase.linkGoogleIdentity) {
          const res = await window.AgriTrustSupabase.linkGoogleIdentity();
          if (!res.success) {
            showProfileFeedback(res.message || 'Google account linking is currently unavailable.', 'error');
          }
        }
      });
    }

    // Edit field modal
    if (dom.closeEditModalBtn) {
      dom.closeEditModalBtn.addEventListener('click', closeEditModal);
    }
    if (dom.editFieldForm) {
      dom.editFieldForm.addEventListener('submit', handleEditFieldSubmit);
    }
    if (dom.btnRedrawBoundary) {
      dom.btnRedrawBoundary.addEventListener('click', handleRedrawBoundaryClick);
    }

    // Delete field modal
    if (dom.btnCancelDelete) {
      dom.btnCancelDelete.addEventListener('click', closeDeleteModal);
    }
    if (dom.btnConfirmDelete) {
      dom.btnConfirmDelete.addEventListener('click', executeDeleteField);
    }

    // Modal background click to close
    [dom.editFieldModal, dom.deleteModal, dom.profileModal].forEach((modal) => {
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            modal.classList.remove('active');
            document.body.style.overflow = '';
          }
        });
      }
    });
  }

  /**
   * Synchronize auth state with header & dashboard
   */
  async function syncAuthState() {
    if (window.AgriTrustSupabase && window.AgriTrustSupabase.ready) {
      await window.AgriTrustSupabase.ready();
    }

    if (!window.AgriTrustSupabase || !window.AgriTrustSupabase.isReady()) {
      renderUnauthenticatedView();
      return;
    }

    currentUser = await window.AgriTrustSupabase.getUser();

    if (currentUser) {
      renderAuthenticatedHeader(currentUser);
      await loadDashboardData();
    } else {
      renderUnauthenticatedView();
    }
  }

  function renderAuthenticatedHeader(user) {
    if (dom.headerGuestActions) dom.headerGuestActions.style.display = 'none';
    if (dom.headerUserActions) dom.headerUserActions.style.display = 'flex';
    if (dom.mobileGuestActions) dom.mobileGuestActions.style.display = 'none';
    if (dom.mobileUserActions) dom.mobileUserActions.style.display = 'flex';

    const displayName = user.user_metadata?.full_name || user.email.split('@')[0];
    const displayOrg = user.user_metadata?.organization_name || 'Independent Grower';

    if (dom.userChipName) dom.userChipName.textContent = displayName;
    if (dom.userChipOrg) dom.userChipOrg.textContent = displayOrg;
    if (dom.mobileUserEmail) dom.mobileUserEmail.textContent = user.email;

    if (dom.farmerWelcomeName) dom.farmerWelcomeName.textContent = displayName;
    if (dom.farmerOrgBadge) dom.farmerOrgBadge.textContent = displayOrg;

    // Show dashboard content
    if (dom.dashboardAccessGate) dom.dashboardAccessGate.style.display = 'none';
    if (dom.dashboardContent) dom.dashboardContent.style.display = 'block';
  }

  function renderUnauthenticatedView() {
    currentUser = null;
    userProfile = null;
    userFields = [];

    if (dom.headerGuestActions) dom.headerGuestActions.style.display = 'flex';
    if (dom.headerUserActions) dom.headerUserActions.style.display = 'none';
    if (dom.mobileGuestActions) dom.mobileGuestActions.style.display = 'flex';
    if (dom.mobileUserActions) dom.mobileUserActions.style.display = 'none';

    // Show gate notice in dashboard
    if (dom.dashboardAccessGate) dom.dashboardAccessGate.style.display = 'block';
    if (dom.dashboardContent) dom.dashboardContent.style.display = 'none';
  }

  /**
   * Load Farmer Profile & Registered Fields from Supabase
   */
  async function loadDashboardData(showFeedback = false) {
    if (!currentUser || !window.AgriTrustSupabase) return;

    if (showFeedback) {
      showDashboardFeedback('Refreshing farm operational data from Supabase...', 'info');
    }

    // 1. Fetch Profile
    const profileRes = await window.AgriTrustSupabase.fetchUserProfile();
    if (profileRes.success && profileRes.profile) {
      userProfile = profileRes.profile;
      if (dom.farmerWelcomeName && userProfile.full_name) {
        dom.farmerWelcomeName.textContent = userProfile.full_name;
      }
      if (dom.farmerOrgBadge && userProfile.organization_name) {
        dom.farmerOrgBadge.textContent = userProfile.organization_name;
      }
      if (dom.userChipName && userProfile.full_name) {
        dom.userChipName.textContent = userProfile.full_name;
      }
      if (dom.userChipOrg && userProfile.organization_name) {
        dom.userChipOrg.textContent = userProfile.organization_name;
      }
    }

    // 2. Fetch Fields
    const fieldsRes = await window.AgriTrustSupabase.fetchUserFields();
    if (fieldsRes.success) {
      userFields = fieldsRes.fields || [];
      updateKPIs(userFields);
      renderFieldsList(userFields);

      if (showFeedback) {
        showDashboardFeedback(`Synchronized: ${userFields.length} field parcels active.`, 'success');
      }
    } else {
      showDashboardFeedback(`Error loading fields: ${fieldsRes.message}`, 'error');
    }
  }

  /**
   * Compute and update KPI summary cards
   */
  function updateKPIs(fields) {
    const totalParcels = fields.length;
    let totalAcres = 0;
    const cropsSet = new Set();
    let mostRecent = null;

    fields.forEach((f) => {
      const ac = parseFloat(f.acreage) || 0;
      totalAcres += ac;
      if (f.crop_variety) {
        cropsSet.add(f.crop_variety.trim().toLowerCase());
      }
    });

    const totalHa = (totalAcres * 0.404686).toFixed(2);

    if (fields.length > 0) {
      mostRecent = fields[0]; // Ordered by created_at DESC in query
    }

    if (dom.kpiTotalFields) dom.kpiTotalFields.textContent = totalParcels;
    if (dom.kpiTotalAcres) dom.kpiTotalAcres.textContent = totalAcres.toFixed(2);
    if (dom.kpiTotalHa) dom.kpiTotalHa.textContent = totalHa;
    if (dom.kpiCropCount) dom.kpiCropCount.textContent = cropsSet.size;

    if (dom.kpiRecentField) {
      if (mostRecent) {
        const dateStr = mostRecent.created_at ? new Date(mostRecent.created_at).toLocaleDateString() : '';
        dom.kpiRecentField.textContent = `${mostRecent.name} (${dateStr})`;
      } else {
        dom.kpiRecentField.textContent = 'None registered';
      }
    }
  }

  /**
   * Render fields in responsive table (desktop) and card list (mobile)
   */
  function renderFieldsList(fields) {
    if (!dom.fieldsTableBody && !dom.fieldsCardsMobile) return;

    if (!fields || fields.length === 0) {
      if (dom.emptyFieldsNotice) dom.emptyFieldsNotice.style.display = 'block';
      if (dom.fieldsTableBody) dom.fieldsTableBody.innerHTML = '';
      if (dom.fieldsCardsMobile) dom.fieldsCardsMobile.innerHTML = '';
      return;
    }

    if (dom.emptyFieldsNotice) dom.emptyFieldsNotice.style.display = 'none';

    // Desktop Table Body
    if (dom.fieldsTableBody) {
      dom.fieldsTableBody.innerHTML = '';
      fields.forEach((field) => {
        const tr = document.createElement('tr');
        tr.className = 'field-table-row';
        tr.innerHTML = `
          <td>
            <div class="table-field-identity">
              <span class="table-field-icon">🌾</span>
              <div>
                <strong class="table-field-name">${escapeHTML(field.name)}</strong>
                <div class="table-field-id">ID: ${field.id.substring(0, 8)}...</div>
              </div>
            </div>
          </td>
          <td>
            <span class="crop-variety-pill">${escapeHTML(field.crop_variety)}</span>
          </td>
          <td>
            <strong>${field.acreage} ac</strong>
            <span style="color: var(--text-muted); font-size: 0.75rem;">(${(field.acreage * 0.404686).toFixed(2)} ha)</span>
          </td>
          <td>
            ${field.soil_texture_type ? `<span class="soil-texture-tag">${escapeHTML(field.soil_texture_type)}</span>` : '<span style="color: #94a3b8;">Not specified</span>'}
          </td>
          <td>
            ${field.planting_date ? escapeHTML(field.planting_date) : '<span style="color: #94a3b8;">—</span>'}
          </td>
          <td>
            <span class="postgis-status-badge">
              <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
              Polygon (4326)
            </span>
          </td>
          <td>
            <div class="table-action-btns">
              <button type="button" class="btn btn-subtle btn-sm js-add-evidence" data-id="${field.id}" title="Take or upload crop photo for this field">
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="4" stroke-width="2"/></svg>
                Photo
              </button>
              <button type="button" class="btn btn-subtle btn-sm js-view-map" data-id="${field.id}" title="Focus parcel on satellite map">
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                Map
              </button>
              <button type="button" class="btn btn-secondary btn-sm js-edit-field" data-id="${field.id}" title="Edit parcel details">
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                Edit
              </button>
              <button type="button" class="btn btn-danger-subtle btn-sm js-delete-field" data-id="${field.id}" title="Delete parcel">
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          </td>
        `;

        // Bind events
        tr.querySelector('.js-add-evidence').addEventListener('click', () => handleAddEvidenceForField(field));
        tr.querySelector('.js-view-map').addEventListener('click', () => handleFocusFieldOnMap(field));
        tr.querySelector('.js-edit-field').addEventListener('click', () => openEditModal(field));
        tr.querySelector('.js-delete-field').addEventListener('click', () => promptDeleteField(field));

        dom.fieldsTableBody.appendChild(tr);
      });
    }

    // Mobile Cards Container
    if (dom.fieldsCardsMobile) {
      dom.fieldsCardsMobile.innerHTML = '';
      fields.forEach((field) => {
        const card = document.createElement('div');
        card.className = 'farmer-field-mobile-card';
        card.innerHTML = `
          <div class="mobile-card-top">
            <div>
              <h5 class="mobile-card-title">${escapeHTML(field.name)}</h5>
              <span class="crop-variety-pill">${escapeHTML(field.crop_variety)}</span>
            </div>
            <div class="mobile-card-acreage">${field.acreage} ac</div>
          </div>
          <div class="mobile-card-details">
            <div><strong>Soil Texture:</strong> ${field.soil_texture_type ? escapeHTML(field.soil_texture_type) : '—'}</div>
            <div><strong>Planted:</strong> ${field.planting_date ? escapeHTML(field.planting_date) : '—'}</div>
            <div><strong>Boundary:</strong> <span style="color: #166534; font-weight: 600;">PostGIS Verified</span></div>
          </div>
          <div class="mobile-card-actions">
            <button type="button" class="btn btn-subtle btn-sm js-add-evidence-mob">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="4" stroke-width="2"/></svg>
              Evidence
            </button>
            <button type="button" class="btn btn-subtle btn-sm js-view-map-mob">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              View on Map
            </button>
            <button type="button" class="btn btn-secondary btn-sm js-edit-field-mob">Edit</button>
            <button type="button" class="btn btn-danger-subtle btn-sm js-delete-field-mob">Delete</button>
          </div>
        `;

        card.querySelector('.js-add-evidence-mob').addEventListener('click', () => handleAddEvidenceForField(field));
        card.querySelector('.js-view-map-mob').addEventListener('click', () => handleFocusFieldOnMap(field));
        card.querySelector('.js-edit-field-mob').addEventListener('click', () => openEditModal(field));
        card.querySelector('.js-delete-field-mob').addEventListener('click', () => promptDeleteField(field));

        dom.fieldsCardsMobile.appendChild(card);
      });
    }
  }

  /**
   * Action: Open Smart Crop Camera for Field
   */
  function handleAddEvidenceForField(field) {
    if (window.AgriTrustCropCamera && window.AgriTrustCropCamera.openForField) {
      window.AgriTrustCropCamera.openForField(field.id);
    } else {
      const el = document.getElementById('crop-camera');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }

  /**
   * Action: Focus Field on Map
   */
  function handleFocusFieldOnMap(field) {
    if (window.AgriTrustFieldManager && window.AgriTrustFieldManager.focusField) {
      window.AgriTrustFieldManager.focusField(field.id);
    } else {
      const el = document.getElementById('fields');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }

  /**
   * Action: Open Edit Field Modal
   */
  function openEditModal(field) {
    if (!dom.editFieldModal) return;

    if (dom.editFieldId) dom.editFieldId.value = field.id;
    if (dom.editFieldName) dom.editFieldName.value = field.name || '';
    if (dom.editCropVariety) dom.editCropVariety.value = field.crop_variety || '';
    if (dom.editPlantingDate) dom.editPlantingDate.value = field.planting_date || '';
    if (dom.editSoilTexture) dom.editSoilTexture.value = field.soil_texture_type || '';
    if (dom.editFieldAcreage) dom.editFieldAcreage.value = field.acreage || '';

    // Store reference to current editing field
    dom.editFieldForm._currentField = field;

    if (dom.editFieldFeedback) dom.editFieldFeedback.style.display = 'none';

    dom.editFieldModal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeEditModal() {
    if (!dom.editFieldModal) return;
    dom.editFieldModal.classList.remove('active');
    document.body.style.overflow = '';
  }

  /**
   * Action: Submit Field Edit
   */
  async function handleEditFieldSubmit(e) {
    e.preventDefault();

    const fieldId = dom.editFieldId?.value;
    const name = dom.editFieldName?.value.trim();
    const cropVariety = dom.editCropVariety?.value.trim();
    const plantingDate = dom.editPlantingDate?.value || null;
    const soilTexture = dom.editSoilTexture?.value || null;

    if (!fieldId || !name || !cropVariety) {
      showEditFeedback('Please provide both field name and crop variety.', 'warning');
      return;
    }

    showEditFeedback('Saving parcel changes to Supabase...', 'info');

    const result = await window.AgriTrustSupabase.updateField(fieldId, {
      name,
      crop_variety: cropVariety,
      planting_date: plantingDate,
      soil_texture_type: soilTexture
    });

    if (result.success) {
      showEditFeedback('Parcel updated successfully!', 'success');
      setTimeout(() => {
        closeEditModal();
        loadDashboardData(true);
        if (window.AgriTrustFieldManager && window.AgriTrustFieldManager.refreshFields) {
          window.AgriTrustFieldManager.refreshFields();
        }
      }, 900);
    } else {
      showEditFeedback(`Update failed: ${result.message}`, 'error');
    }
  }

  /**
   * Action: Redraw Boundary in Map tool
   */
  function handleRedrawBoundaryClick() {
    const field = dom.editFieldForm?._currentField;
    if (!field) return;

    closeEditModal();

    if (window.AgriTrustFieldManager && window.AgriTrustFieldManager.loadFieldForEditing) {
      window.AgriTrustFieldManager.loadFieldForEditing(field);
    } else {
      const el = document.getElementById('fields');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function showEditFeedback(msg, type = 'info') {
    if (!dom.editFieldFeedback) return;
    dom.editFieldFeedback.style.display = 'block';

    if (type === 'success') {
      dom.editFieldFeedback.style.backgroundColor = '#dcfce7';
      dom.editFieldFeedback.style.borderColor = '#86efac';
      dom.editFieldFeedback.style.color = '#166534';
    } else if (type === 'error') {
      dom.editFieldFeedback.style.backgroundColor = '#fee2e2';
      dom.editFieldFeedback.style.borderColor = '#fca5a5';
      dom.editFieldFeedback.style.color = '#991b1b';
    } else if (type === 'warning') {
      dom.editFieldFeedback.style.backgroundColor = '#fef3c7';
      dom.editFieldFeedback.style.borderColor = '#fcd34d';
      dom.editFieldFeedback.style.color = '#92400e';
    } else {
      dom.editFieldFeedback.style.backgroundColor = '#f1f5f9';
      dom.editFieldFeedback.style.borderColor = '#cbd5e1';
      dom.editFieldFeedback.style.color = '#334155';
    }

    dom.editFieldFeedback.textContent = msg;
  }

  /**
   * Action: Prompt Delete Field
   */
  function promptDeleteField(field) {
    pendingDeleteFieldId = field.id;
    if (dom.deleteFieldName) dom.deleteFieldName.textContent = `"${field.name}" (${field.acreage} ac)`;
    if (dom.deleteModal) {
      dom.deleteModal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeDeleteModal() {
    pendingDeleteFieldId = null;
    if (dom.deleteModal) {
      dom.deleteModal.classList.remove('active');
      document.body.style.overflow = '';
    }
  }

  /**
   * Action: Execute Delete Field
   */
  async function executeDeleteField() {
    if (!pendingDeleteFieldId) return;

    if (dom.btnConfirmDelete) {
      dom.btnConfirmDelete.disabled = true;
      dom.btnConfirmDelete.textContent = 'Deleting...';
    }

    const result = await window.AgriTrustSupabase.deleteField(pendingDeleteFieldId);

    if (dom.btnConfirmDelete) {
      dom.btnConfirmDelete.disabled = false;
      dom.btnConfirmDelete.textContent = 'Delete Parcel Permanently';
    }

    if (result.success) {
      closeDeleteModal();
      showDashboardFeedback('Parcel deleted successfully from your farm registry.', 'success');
      loadDashboardData();
      if (window.AgriTrustFieldManager && window.AgriTrustFieldManager.refreshFields) {
        window.AgriTrustFieldManager.refreshFields();
      }
    } else {
      alert(`Delete failed: ${result.message}`);
    }
  }

  /**
   * Action: Open Profile Modal
   */
  function openProfileModal() {
    if (!dom.profileModal) return;

    if (currentUser && dom.profileEmail) {
      dom.profileEmail.value = currentUser.email;
    }

    if (userProfile) {
      if (dom.profileFullName) dom.profileFullName.value = userProfile.full_name || '';
      if (dom.profileOrgName) dom.profileOrgName.value = userProfile.organization_name || '';
      if (dom.profilePhone) dom.profilePhone.value = userProfile.phone_number || '';
    }

    if (dom.profileFeedback) dom.profileFeedback.style.display = 'none';
    if (dom.btnLinkGoogle) dom.btnLinkGoogle.style.display = 'none';

    // Render connected sign-in identities
    if (dom.linkedIdentitiesList && currentUser) {
      dom.linkedIdentitiesList.innerHTML = '';
      const providers = currentUser.app_metadata?.providers || [];
      const identities = currentUser.identities || [];
      const hasEmail = Boolean(currentUser.email) || providers.includes('email');
      const hasGoogle = providers.includes('google') || identities.some(id => id.provider === 'google');
      const hasPhone = Boolean(currentUser.phone) || providers.includes('phone') || identities.some(id => id.provider === 'phone');

      let html = '';
      if (hasEmail) {
        html += `<span class="badge" style="background-color: #f1f5f9; color: #334155; padding: 4px 8px; border-radius: 4px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">✉️ Email (${currentUser.email})</span>`;
      }
      if (hasGoogle) {
        html += `<span class="badge" style="background-color: #eff6ff; color: #1e40af; padding: 4px 8px; border-radius: 4px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">🔵 Google Connected</span>`;
      }
      if (hasPhone) {
        const phoneNum = currentUser.phone || userProfile?.phone_number || '';
        html += `<span class="badge" style="background-color: #ecfdf5; color: #065f46; padding: 4px 8px; border-radius: 4px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">📱 Phone (${phoneNum})</span>`;
      }
      if (!html) {
        html = '<span style="color: var(--text-muted);">Standard session</span>';
      }
      dom.linkedIdentitiesList.innerHTML = html;

      if (dom.btnLinkGoogle) {
        dom.btnLinkGoogle.style.display = hasGoogle ? 'none' : 'block';
      }
    }

    dom.profileModal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeProfileModal() {
    if (!dom.profileModal) return;
    dom.profileModal.classList.remove('active');
    document.body.style.overflow = '';
  }

  /**
   * Action: Submit Profile Changes
   */
  async function handleProfileSubmit(e) {
    e.preventDefault();

    const fullName = dom.profileFullName?.value.trim();
    const orgName = dom.profileOrgName?.value.trim();
    const phone = dom.profilePhone?.value.trim();

    if (!fullName) {
      showProfileFeedback('Please provide your full legal or operator name.', 'warning');
      return;
    }

    showProfileFeedback('Saving profile updates to Supabase...', 'info');

    const result = await window.AgriTrustSupabase.updateUserProfile({
      full_name: fullName,
      organization_name: orgName,
      phone_number: phone
    });

    if (result.success) {
      userProfile = result.profile;
      showProfileFeedback('Farm profile successfully updated!', 'success');
      if (dom.farmerOrgBadge && userProfile.organization_name) {
        dom.farmerOrgBadge.textContent = userProfile.organization_name;
      }
      if (dom.farmerWelcomeName && userProfile.full_name) {
        dom.farmerWelcomeName.textContent = userProfile.full_name;
      }
      setTimeout(() => {
        closeProfileModal();
        renderAuthenticatedHeader(currentUser);
      }, 900);
    } else {
      showProfileFeedback(`Profile update failed: ${result.message}`, 'error');
    }
  }

  function showProfileFeedback(msg, type = 'info') {
    if (!dom.profileFeedback) return;
    dom.profileFeedback.style.display = 'block';

    if (type === 'success') {
      dom.profileFeedback.style.backgroundColor = '#dcfce7';
      dom.profileFeedback.style.borderColor = '#86efac';
      dom.profileFeedback.style.color = '#166534';
    } else if (type === 'error') {
      dom.profileFeedback.style.backgroundColor = '#fee2e2';
      dom.profileFeedback.style.borderColor = '#fca5a5';
      dom.profileFeedback.style.color = '#991b1b';
    } else if (type === 'warning') {
      dom.profileFeedback.style.backgroundColor = '#fef3c7';
      dom.profileFeedback.style.borderColor = '#fcd34d';
      dom.profileFeedback.style.color = '#92400e';
    } else {
      dom.profileFeedback.style.backgroundColor = '#f1f5f9';
      dom.profileFeedback.style.borderColor = '#cbd5e1';
      dom.profileFeedback.style.color = '#334155';
    }

    dom.profileFeedback.textContent = msg;
  }

  /**
   * Action: Sign Out
   */
  async function handleSignOut() {
    if (!window.AgriTrustSupabase) return;
    await window.AgriTrustSupabase.signOut();
    syncAuthState();
    if (window.AgriTrustFieldManager && window.AgriTrustFieldManager.refreshFields) {
      window.AgriTrustFieldManager.refreshFields();
    }
  }

  function showDashboardFeedback(msg, type = 'info') {
    if (!dom.dashboardFeedback) return;
    dom.dashboardFeedback.style.display = 'block';

    if (type === 'success') {
      dom.dashboardFeedback.style.backgroundColor = '#dcfce7';
      dom.dashboardFeedback.style.borderColor = '#86efac';
      dom.dashboardFeedback.style.color = '#166534';
    } else if (type === 'error') {
      dom.dashboardFeedback.style.backgroundColor = '#fee2e2';
      dom.dashboardFeedback.style.borderColor = '#fca5a5';
      dom.dashboardFeedback.style.color = '#991b1b';
    } else {
      dom.dashboardFeedback.style.backgroundColor = '#f1f5f9';
      dom.dashboardFeedback.style.borderColor = '#cbd5e1';
      dom.dashboardFeedback.style.color = '#334155';
    }

    dom.dashboardFeedback.textContent = msg;

    setTimeout(() => {
      if (dom.dashboardFeedback) dom.dashboardFeedback.style.display = 'none';
    }, 5000);
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  return {
    init,
    refresh: () => loadDashboardData(true),
    openProfile: openProfileModal
  };
})();

// Explicitly bind AgriTrustFarmerDashboard to global window and globalThis scopes
if (typeof window !== 'undefined') {
  window.AgriTrustFarmerDashboard = AgriTrustFarmerDashboard;
}
if (typeof globalThis !== 'undefined') {
  globalThis.AgriTrustFarmerDashboard = AgriTrustFarmerDashboard;
}

// Auto-initialize on DOM ready or immediately if DOM is already loaded
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      AgriTrustFarmerDashboard.init();
    });
  } else {
    AgriTrustFarmerDashboard.init();
  }
}

