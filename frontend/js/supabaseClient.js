/**
 * AgriTrustGeoAgent - Supabase Client Interface
 * Handles zero-secret client initialization via /api/config and manages
 * authentication sessions for Producers and Certified Agronomists.
 */

const AgriTrustSupabase = (() => {
  let supabaseInstance = null;
  let isConfigured = false;
  let clientConfig = null;
  let initPromise = null;
  let resolveReady = null;

  initPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  /**
   * Initializes the Supabase client by querying the secure local /api/config endpoint.
   * This ensures no secrets or URLs are hardcoded in the frontend repository.
   */
  async function init() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) {
        console.warn('[AgriTrustSupabase] Could not fetch /api/config');
        isConfigured = false;
        if (resolveReady) resolveReady(false);
        return { configured: false };
      }

      clientConfig = await res.json();
      const publishableKey = clientConfig.supabasePublishableKey || clientConfig.supabaseAnonKey;

      // Environment is properly configured if URL and publishable key are present and non-placeholder
      isConfigured = Boolean(clientConfig.configured && (publishableKey || clientConfig.supabaseUrl));

      // Initialize Supabase JS client instance if global is available
      if (isConfigured && window.supabase && typeof window.supabase.createClient === 'function' && publishableKey) {
        try {
          supabaseInstance = window.supabase.createClient(
            clientConfig.supabaseUrl,
            publishableKey,
            {
              auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
              }
            }
          );
          console.info('[AgriTrustSupabase] Connected securely to Supabase project via JS Client.');
        } catch (createErr) {
          console.warn('[AgriTrustSupabase] createClient notice:', createErr);
        }
      } else if (isConfigured) {
        console.info('[AgriTrustSupabase] Supabase environment verified; REST interface active.');
      } else {
        console.info('[AgriTrustSupabase] Supabase credentials pending in .env');
      }

      // Notify all dependent modules (fieldManager, farmerDashboard, cropCamera, app)
      if (resolveReady) resolveReady(isConfigured);
      window.dispatchEvent(new CustomEvent('agritrust:supabaseReady', {
        detail: { configured: isConfigured, config: clientConfig }
      }));

      return { configured: isConfigured, config: clientConfig };
    } catch (err) {
      console.error('[AgriTrustSupabase] Initialization error:', err);
      isConfigured = false;
      if (resolveReady) resolveReady(false);
      return { configured: false, error: err };
    }
  }

  /**
   * Resolves the authentication redirect URL dynamically based on the current origin.
   * Dynamically uses the current production origin (e.g., https://agritrustgeoagent.onrender.com)
   * while keeping localhost / 127.0.0.1 working seamlessly for local development.
   */
  function getAuthRedirectUrl() {
    try {
      if (typeof window !== 'undefined' && window.location && window.location.origin) {
        const origin = window.location.origin;
        if (origin && origin !== 'null' && origin !== 'file://') {
          return origin.replace(/\/+$/, '');
        }
      }
    } catch (_) {}
    return 'https://agritrustgeoagent.onrender.com';
  }

  /**
   * Direct REST Signup Fallback
   */
  async function restSignUp(email, password, role, metadata) {
    const redirectUrl = getAuthRedirectUrl();
    const url = `${clientConfig.supabaseUrl.replace(/\/$/, '')}/auth/v1/signup?redirect_to=${encodeURIComponent(redirectUrl)}`;
    const key = clientConfig.supabasePublishableKey || clientConfig.supabaseAnonKey;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          password,
          data: {
            role,
            ...metadata
          }
        })
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, message: data.msg || data.message || data.error_description || 'Registration failed' };
      }
      return { success: true, user: data.user || data, session: data.session || (data.access_token ? data : null) };
    } catch (err) {
      return { success: false, message: err.message || 'Network error during registration' };
    }
  }

  /**
   * Direct REST Sign In Fallback
   */
  async function restSignIn(email, password) {
    const url = `${clientConfig.supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`;
    const key = clientConfig.supabasePublishableKey || clientConfig.supabaseAnonKey;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          password
        })
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, message: data.error_description || data.msg || data.message || 'Sign in failed' };
      }
      return { success: true, user: data.user, session: data };
    } catch (err) {
      return { success: false, message: err.message || 'Network error during sign in' };
    }
  }

  /**
   * Get the current active Supabase client instance.
   */
  function getClient() {
    return supabaseInstance;
  }

  /**
   * Sign in with Email & Password.
   * Enforces role-based metadata check.
   */
  async function signIn(email, password, role = 'farmer') {
    if (!isConfigured || !supabaseInstance) {
      await init();
    }

    if (!isConfigured) {
      return {
        success: false,
        message: 'Supabase is not configured yet. Please populate your SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the local .env file.'
      };
    }

    if (supabaseInstance && supabaseInstance.auth && typeof supabaseInstance.auth.signInWithPassword === 'function') {
      try {
        const { data, error } = await supabaseInstance.auth.signInWithPassword({
          email,
          password
        });

        if (error) {
          return { success: false, message: error.message };
        }

        return { success: true, user: data.user, session: data.session };
      } catch (err) {
        return { success: false, message: err.message || 'Authentication failed' };
      }
    }

    return await restSignIn(email, password);
  }

  /**
   * Sign up a new user with role metadata ('farmer' or 'agronomist').
   */
  async function signUp(email, password, role = 'farmer', metadata = {}) {
    if (!isConfigured || !supabaseInstance) {
      await init();
    }

    if (!isConfigured) {
      return {
        success: false,
        message: 'Supabase is not configured yet. Please populate your SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the local .env file.'
      };
    }

    if (supabaseInstance && supabaseInstance.auth && typeof supabaseInstance.auth.signUp === 'function') {
      try {
        const redirectUrl = getAuthRedirectUrl();
        const { data, error } = await supabaseInstance.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectUrl,
            data: {
              role: role,
              ...metadata
            }
          }
        });

        if (error) {
          return { success: false, message: error.message };
        }

        return { success: true, user: data.user, session: data.session };
      } catch (err) {
        return { success: false, message: err.message || 'Registration failed' };
      }
    }

    return await restSignUp(email, password, role, metadata);
  }

  /**
   * Translates technical Supabase auth errors into simple, farmer-friendly notices.
   * Preserves full technical error traces in console logs for debugging.
   */
  function mapAuthErrorToFarmerMessage(error, method = 'general') {
    if (!error) return 'An unexpected error occurred. Please try again.';
    console.error(`[AgriTrustAuth] Raw error for method ${method}:`, error);

    const msg = (typeof error === 'string' ? error : (error.message || error.msg || error.error_description || '')).toLowerCase();

    if (method === 'google' || msg.includes('unsupported provider') || msg.includes('provider is not enabled')) {
      return 'Google sign-in is temporarily unavailable. Please try another sign-in method.';
    }

    if (method === 'phone' || msg.includes('phone provider') || msg.includes('sms')) {
      return 'Phone verification is not available yet.';
    }

    if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed')) {
      return 'Please check your email to complete verification.';
    }

    if (msg.includes('invalid login credentials') || msg.includes('invalid_credentials')) {
      return 'Incorrect email or security passcode. Please check and try again.';
    }

    if (msg.includes('user already registered') || msg.includes('already exists')) {
      return 'An account with this email already exists. Please sign in instead.';
    }

    if (msg.includes('rate limit') || msg.includes('over_email_send_rate_limit')) {
      return 'Verification request rate limit reached. Please wait a few minutes before trying again.';
    }

    if (msg.includes('network') || msg.includes('failed to fetch')) {
      return 'Network connection issue. Please check your internet connection.';
    }

    return error.message || 'Authentication could not be completed. Please try again.';
  }

  /**
   * Primary Authentication: Google OAuth via official Supabase Auth flow.
   */
  async function signInWithGoogle() {
    if (!isConfigured || !supabaseInstance) {
      await init();
    }

    if (!isConfigured || !supabaseInstance) {
      return {
        success: false,
        message: 'Google sign-in is temporarily unavailable. Please try another sign-in method.'
      };
    }

    try {
      if (supabaseInstance.auth && typeof supabaseInstance.auth.signInWithOAuth === 'function') {
        const redirectUrl = getAuthRedirectUrl();
        const { data, error } = await supabaseInstance.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: redirectUrl,
            skipBrowserRedirect: true,
            queryParams: {
              access_type: 'offline',
              prompt: 'consent'
            }
          }
        });

        if (error) {
          const farmerMsg = mapAuthErrorToFarmerMessage(error, 'google');
          return { success: false, message: farmerMsg, rawError: error };
        }

        if (data?.url) {
          // Pre-flight check if provider is enabled before redirecting the farmer away
          try {
            const checkRes = await fetch(data.url, {
              method: 'GET',
              redirect: 'manual'
            });

            // If Supabase returns HTTP 400 with "Unsupported provider", provider is disabled
            if (checkRes.status >= 400) {
              const errData = await checkRes.json().catch(() => ({}));
              console.error('[AgriTrustAuth] Google provider endpoint check returned error:', checkRes.status, errData);
              const farmerMsg = mapAuthErrorToFarmerMessage(errData, 'google');
              return { success: false, message: farmerMsg, rawError: errData };
            }
          } catch (checkErr) {
            console.error('[AgriTrustAuth] Provider check notice:', checkErr);
          }

          return { success: true, url: data.url };
        }

        return {
          success: false,
          message: 'Google sign-in is temporarily unavailable. Please try another sign-in method.'
        };
      } else {
        return {
          success: false,
          message: 'Google sign-in is temporarily unavailable. Please try another sign-in method.'
        };
      }
    } catch (err) {
      const farmerMsg = mapAuthErrorToFarmerMessage(err, 'google');
      return { success: false, message: farmerMsg, rawError: err };
    }
  }

  /**
   * Secondary Authentication: Request SMS OTP for Phone Number.
   */
  async function sendPhoneOtp(phone) {
    if (!isConfigured || !supabaseInstance) {
      await init();
    }

    if (!isConfigured || !supabaseInstance) {
      return {
        success: false,
        message: 'Phone verification is not available yet.'
      };
    }

    let cleanPhone = phone.trim().replace(/[\s-]/g, '');
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = `+91${cleanPhone}`;
    }

    try {
      if (supabaseInstance.auth && typeof supabaseInstance.auth.signInWithOtp === 'function') {
        const { data, error } = await supabaseInstance.auth.signInWithOtp({
          phone: cleanPhone,
          options: {
            channel: 'sms'
          }
        });

        if (error) {
          const farmerMsg = mapAuthErrorToFarmerMessage(error, 'phone');
          return { success: false, message: farmerMsg, rawError: error };
        }

        return { success: true, phone: cleanPhone, data };
      } else {
        return {
          success: false,
          message: 'Phone verification is not available yet.'
        };
      }
    } catch (err) {
      const farmerMsg = mapAuthErrorToFarmerMessage(err, 'phone');
      return { success: false, message: farmerMsg, rawError: err };
    }
  }

  /**
   * Verify SMS OTP token for authenticated session.
   */
  async function verifyPhoneOtp(phone, token) {
    if (!isConfigured || !supabaseInstance) {
      await init();
    }

    if (!isConfigured || !supabaseInstance) {
      return {
        success: false,
        message: 'Phone verification is not available yet.'
      };
    }

    let cleanPhone = phone.trim().replace(/[\s-]/g, '');
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = `+91${cleanPhone}`;
    }

    try {
      if (supabaseInstance.auth && typeof supabaseInstance.auth.verifyOtp === 'function') {
        const { data, error } = await supabaseInstance.auth.verifyOtp({
          phone: cleanPhone,
          token: token.trim(),
          type: 'sms'
        });

        if (error) {
          const farmerMsg = mapAuthErrorToFarmerMessage(error, 'phone');
          return { success: false, message: farmerMsg, rawError: error };
        }

        return { success: true, user: data?.user, session: data?.session };
      } else {
        return {
          success: false,
          message: 'Phone verification is not available yet.'
        };
      }
    } catch (err) {
      const farmerMsg = mapAuthErrorToFarmerMessage(err, 'phone');
      return { success: false, message: farmerMsg, rawError: err };
    }
  }

  /**
   * Checks whether the current authenticated user has completed initial farm setup.
   * Differentiates first-time farmers from returning farmers.
   */
  async function checkProfileStatus() {
    const user = await getUser();
    if (!user) return { isAuthenticated: false, isComplete: false, profile: null };

    const { profile } = await fetchUserProfile();
    
    // Complete profile requires a genuine full_name and farm/organization_name
    const isNameValid = Boolean(profile?.full_name && profile.full_name.trim().length > 1);
    const isOrgValid = Boolean(profile?.organization_name && profile.organization_name.trim().length > 1);
    
    const isComplete = Boolean(profile && isNameValid && isOrgValid);

    return {
      isAuthenticated: true,
      isComplete: isComplete,
      profile: profile,
      user: user
    };
  }

  /**
   * First-Time Setup: Saves grower profile and initial farm context.
   */
  async function completeFarmerSetup({ fullName, farmName, location, initialField = null }) {
    const user = await getUser();
    if (!user) return { success: false, message: 'User must be authenticated to complete setup.' };

    try {
      // 1. Update Profile in public.profiles
      const profileRes = await updateUserProfile({
        full_name: fullName.trim(),
        organization_name: farmName.trim(),
        phone_number: user.phone || null
      });

      if (!profileRes.success) {
        return { success: false, message: profileRes.message || 'Failed to save farmer profile.' };
      }

      // 2. If initial field is specified, create initial field record if coordinates/boundary are available
      let fieldRecord = null;
      if (initialField && initialField.name && initialField.boundary) {
        fieldRecord = await saveField({
          name: initialField.name,
          crop_variety: initialField.crop_variety || 'Mixed Crop',
          planting_date: initialField.planting_date || new Date().toISOString().split('T')[0],
          acreage: initialField.acreage || 1.0,
          boundary: initialField.boundary,
          soil_texture_type: initialField.soil_texture_type || 'Loam'
        });
      }

      return {
        success: true,
        profile: profileRes.profile,
        field: fieldRecord?.field || null
      };
    } catch (err) {
      console.error('[AgriTrustSupabase] completeFarmerSetup error:', err);
      return { success: false, message: err.message || 'Failed to complete farm setup.' };
    }
  }

  /**
   * Account Linking: Securely links Google account to the active authenticated session.
   */
  async function linkGoogleIdentity() {
    if (!supabaseInstance || !supabaseInstance.auth) {
      return { success: false, message: 'Identity linking is not available.' };
    }
    try {
      if (typeof supabaseInstance.auth.linkIdentity === 'function') {
        const redirectUrl = getAuthRedirectUrl();
        const { data, error } = await supabaseInstance.auth.linkIdentity({
          provider: 'google',
          options: {
            redirectTo: redirectUrl,
            skipBrowserRedirect: true
          }
        });
        if (error) {
          return { success: false, message: mapAuthErrorToFarmerMessage(error, 'google') };
        }
        if (data?.url) {
          try {
            const checkRes = await fetch(data.url, { method: 'GET', redirect: 'manual' });
            if (checkRes.status >= 400) {
              const errData = await checkRes.json().catch(() => ({}));
              return { success: false, message: mapAuthErrorToFarmerMessage(errData, 'google') };
            }
          } catch (_) {}
          return { success: true, url: data.url };
        }
        return { success: false, message: 'Google account linking is currently unavailable.' };
      }
      return { success: false, message: 'Identity linking is not supported by the client.' };
    } catch (err) {
      return { success: false, message: mapAuthErrorToFarmerMessage(err, 'google') };
    }
  }

  /**
   * Sign out current user.
   */
  async function signOut() {
    if (!supabaseInstance) return;
    if (supabaseInstance.auth && typeof supabaseInstance.auth.signOut === 'function') {
      try {
        await supabaseInstance.auth.signOut();
      } catch (_) {}
    }
  }

  /**
   * Get current session.
   */
  async function getSession() {
    if (!supabaseInstance && !isConfigured) {
      await init();
    }
    if (supabaseInstance && supabaseInstance.auth && typeof supabaseInstance.auth.getSession === 'function') {
      try {
        const { data, error } = await supabaseInstance.auth.getSession();
        if (error) return null;
        return data?.session || null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * Get currently authenticated user.
   */
  async function getUser() {
    if (!supabaseInstance && !isConfigured) {
      await init();
    }
    if (supabaseInstance && supabaseInstance.auth && typeof supabaseInstance.auth.getUser === 'function') {
      try {
        const { data } = await supabaseInstance.auth.getUser();
        return data?.user || null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * Fetch registered fields for the authenticated farmer.
   */
  async function fetchUserFields() {
    if (!supabaseInstance) return { success: false, fields: [], message: 'Supabase not initialized' };
    const user = await getUser();
    if (!user) return { success: false, fields: [], message: 'Not authenticated' };

    try {
      const { data, error } = await supabaseInstance
        .from('fields')
        .select('id, name, crop_variety, planting_date, acreage, soil_texture_type, created_at, boundary')
        .order('created_at', { ascending: false });

      if (error) {
        return { success: false, fields: [], message: error.message };
      }
      return { success: true, fields: data || [] };
    } catch (err) {
      return { success: false, fields: [], message: err.message || 'Failed to fetch fields' };
    }
  }

  /**
   * Save a new field parcel into public.fields.
   * fieldData: { name, crop_variety, planting_date, acreage, boundary (EWKT string), soil_texture_type }
   */
  async function saveField(fieldData) {
    if (!supabaseInstance) return { success: false, message: 'Supabase client not initialized' };
    const user = await getUser();
    if (!user) return { success: false, message: 'You must be logged in to save a field parcel.' };

    try {
      const payload = {
        farmer_id: user.id,
        name: fieldData.name,
        crop_variety: fieldData.crop_variety,
        planting_date: fieldData.planting_date || null,
        acreage: parseFloat(fieldData.acreage),
        boundary: fieldData.boundary, // PostGIS EWKT: SRID=4326;POLYGON(...)
        soil_texture_type: fieldData.soil_texture_type || null
      };

      const { data, error } = await supabaseInstance
        .from('fields')
        .insert([payload])
        .select();

      if (error) {
        return { success: false, message: error.message };
      }
      return { success: true, field: data ? data[0] : null };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to save field parcel' };
    }
  }

  /**
   * Fetch profile for currently authenticated user.
   */
  async function fetchUserProfile() {
    if (!supabaseInstance) return { success: false, profile: null, message: 'Supabase not initialized' };
    const user = await getUser();
    if (!user) return { success: false, profile: null, message: 'Not authenticated' };

    try {
      const { data, error } = await supabaseInstance
        .from('profiles')
        .select('id, role, full_name, organization_name, phone_number, data_sovereignty_agreed, created_at, updated_at')
        .eq('id', user.id)
        .single();

      if (error) {
        return { success: false, profile: null, message: error.message };
      }
      return { success: true, profile: data };
    } catch (err) {
      return { success: false, profile: null, message: err.message || 'Failed to fetch profile' };
    }
  }

  /**
   * Update profile for currently authenticated user.
   */
  async function updateUserProfile(profileData) {
    if (!supabaseInstance) return { success: false, message: 'Supabase client not initialized' };
    const user = await getUser();
    if (!user) return { success: false, message: 'Not authenticated' };

    try {
      const { data, error } = await supabaseInstance
        .from('profiles')
        .update({
          full_name: profileData.full_name,
          organization_name: profileData.organization_name,
          phone_number: profileData.phone_number,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id)
        .select()
        .single();

      if (error) {
        return { success: false, message: error.message };
      }
      return { success: true, profile: data };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to update profile' };
    }
  }

  /**
   * Update an existing field parcel.
   */
  async function updateField(fieldId, fieldData) {
    if (!supabaseInstance) return { success: false, message: 'Supabase client not initialized' };
    const user = await getUser();
    if (!user) return { success: false, message: 'Not authenticated' };

    try {
      const payload = {
        name: fieldData.name,
        crop_variety: fieldData.crop_variety,
        planting_date: fieldData.planting_date || null,
        soil_texture_type: fieldData.soil_texture_type || null,
        updated_at: new Date().toISOString()
      };

      if (fieldData.boundary) {
        payload.boundary = fieldData.boundary;
      }
      if (fieldData.acreage !== undefined && fieldData.acreage !== null) {
        payload.acreage = parseFloat(fieldData.acreage);
      }

      const { data, error } = await supabaseInstance
        .from('fields')
        .update(payload)
        .eq('id', fieldId)
        .eq('farmer_id', user.id)
        .select();

      if (error) {
        return { success: false, message: error.message };
      }
      return { success: true, field: data ? data[0] : null };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to update field parcel' };
    }
  }

  /**
   * Delete an existing field parcel.
   */
  async function deleteField(fieldId) {
    if (!supabaseInstance) return { success: false, message: 'Supabase client not initialized' };
    const user = await getUser();
    if (!user) return { success: false, message: 'Not authenticated' };

    try {
      const { error } = await supabaseInstance
        .from('fields')
        .delete()
        .eq('id', fieldId)
        .eq('farmer_id', user.id);

      if (error) {
        return { success: false, message: error.message };
      }
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to delete field parcel' };
    }
  }

  /**
   * Upload an image binary to the private 'crop-evidence' Supabase storage bucket.
   * Enforces RLS folder path: {userId}/{fieldId}/{timestamp}_{filename}
   */
  async function uploadCropEvidenceFile(file, fieldId) {
    if (!supabaseInstance) return { success: false, message: 'Supabase client not initialized' };
    const user = await getUser();
    if (!user) return { success: false, message: 'You must be authenticated to upload crop evidence.' };
    if (!fieldId) return { success: false, message: 'Field parcel must be selected before uploading evidence.' };

    try {
      const sanitizedName = file.name ? file.name.replace(/[^a-zA-Z0-9._-]/g, '_') : 'capture.jpg';
      const storagePath = `${user.id}/${fieldId}/${Date.now()}_${sanitizedName}`;

      const { data, error } = await supabaseInstance
        .storage
        .from('crop-evidence')
        .upload(storagePath, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || 'image/jpeg'
        });

      if (error) {
        return { success: false, message: error.message };
      }

      // Generate a signed URL valid for 1 hour for secure client viewing
      let signedUrl = null;
      try {
        const { data: signedData, error: signedErr } = await supabaseInstance
          .storage
          .from('crop-evidence')
          .createSignedUrl(storagePath, 3600);
        if (!signedErr && signedData) {
          signedUrl = signedData.signedUrl;
        }
      } catch (e) {
        console.warn('[AgriTrustSupabase] Could not create signed URL:', e);
      }

      return {
        success: true,
        storagePath: storagePath,
        signedUrl: signedUrl
      };
    } catch (err) {
      return { success: false, message: err.message || 'Storage upload failed' };
    }
  }

  /**
   * Create a verified crop_evidence record in public.crop_evidence.
   */
  async function createCropEvidenceRecord(evidenceData) {
    if (!supabaseInstance) return { success: false, message: 'Supabase client not initialized' };
    const user = await getUser();
    if (!user) return { success: false, message: 'You must be authenticated to submit evidence.' };

    try {
      const payload = {
        field_id: evidenceData.field_id,
        uploader_id: user.id,
        storage_path: evidenceData.storage_path,
        capture_location: evidenceData.capture_location, // 'SRID=4326;POINT(lng lat)'
        capture_timestamp: evidenceData.capture_timestamp || new Date().toISOString(),
        blur_laplacian_var: evidenceData.blur_laplacian_var !== undefined ? evidenceData.blur_laplacian_var : null,
        validation_status: evidenceData.validation_status || 'pending',
        rejection_reasons: evidenceData.rejection_reasons || [],
        optical_metadata: evidenceData.optical_metadata || {}
      };

      const { data, error } = await supabaseInstance
        .from('crop_evidence')
        .insert([payload])
        .select();

      if (error) {
        return { success: false, message: error.message };
      }

      return { success: true, evidence: data ? data[0] : null };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to create crop evidence record' };
    }
  }

  /**
   * Fetch recent crop evidence records for the authenticated user, optionally filtered by fieldId.
   */
  async function fetchFieldEvidence(fieldId = null, limit = 20) {
    if (!supabaseInstance) return { success: false, evidence: [], message: 'Supabase client not initialized' };
    const user = await getUser();
    if (!user) return { success: false, evidence: [], message: 'Not authenticated' };

    try {
      let query = supabaseInstance
        .from('crop_evidence')
        .select(`
          id, field_id, uploader_id, storage_path, capture_location,
          capture_timestamp, blur_laplacian_var, is_geofence_verified,
          validation_status, rejection_reasons, optical_metadata, created_at,
          fields ( name, crop_variety ),
          diagnostic_inferences (
            id, model_version, diagnosis_label, confidence_score,
            uncertainty_margin, recommendation_text, requires_escalation,
            telemetry_context, created_at
          )
        `)
        .eq('uploader_id', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (fieldId) {
        query = query.eq('field_id', fieldId);
      }

      const { data, error } = await query;
      if (error) {
        return { success: false, evidence: [], message: error.message };
      }

      const records = data || [];

      // Generate signed URLs in parallel for evidence previews
      const enriched = await Promise.all(records.map(async (rec) => {
        if (rec.storage_path) {
          try {
            const { data: sData } = await supabaseInstance
              .storage
              .from('crop-evidence')
              .createSignedUrl(rec.storage_path, 1800);
            rec.signedUrl = sData?.signedUrl || null;
          } catch (e) {
            rec.signedUrl = null;
          }
        }
        return rec;
      }));

      return { success: true, evidence: enriched };
    } catch (err) {
      return { success: false, evidence: [], message: err.message || 'Failed to fetch evidence records' };
    }
  }

  /**
   * Request multi-modal diagnostic analysis for a verified crop evidence record.
   * Invokes the secure backend endpoint /api/analyze-evidence with caller's Bearer token.
   */
  async function analyzeCropEvidence(evidenceId, fieldId = null) {
    if (!evidenceId) {
      return { success: false, message: 'Missing evidenceId' };
    }

    try {
      const session = await getSession();
      if (!session || !session.access_token) {
        return { success: false, message: 'You must be authenticated to request diagnostic analysis.' };
      }

      const res = await fetch('/api/analyze-evidence', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          evidence_id: evidenceId,
          field_id: fieldId
        })
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          success: false,
          status: 'ERROR',
          message: data.error || `Server responded with status ${res.status}`
        };
      }

      return {
        success: true,
        ...data
      };
    } catch (err) {
      return {
        success: false,
        status: 'NETWORK_ERROR',
        message: err.message || 'Could not connect to diagnostic inference gateway.'
      };
    }
  }

  /**
   * Request Sentinel-2 L2A NDVI satellite processing for a farmer's registered PostGIS field boundary.
   * Invokes the secure backend endpoint /api/satellite/process-field with caller's Bearer token.
   * Never exposes CDSE credentials or server secrets.
   */
  async function processFieldSatelliteNdvi(fieldId, timeFrom = null, timeTo = null) {
    if (!fieldId) {
      return { success: false, message: 'Missing fieldId' };
    }

    try {
      const session = await getSession();
      if (!session || !session.access_token) {
        return { success: false, message: 'You must be authenticated to request satellite NDVI processing.' };
      }

      const payload = { field_id: fieldId };
      if (timeFrom) payload.time_from = timeFrom;
      if (timeTo) payload.time_to = timeTo;

      const res = await fetch('/api/satellite/process-field', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          success: false,
          status: 'ERROR',
          message: data.error || data.details || `Server responded with status ${res.status}`
        };
      }

      // If tile_storage_path is returned and raster_url is not yet set, generate a signed URL
      if (data && data.tile_storage_path && !data.raster_url && supabaseInstance && supabaseInstance.storage) {
        try {
          const { data: signedData, error: signedErr } = await supabaseInstance
            .storage
            .from('satellite-rasters')
            .createSignedUrl(data.tile_storage_path, 3600);
          if (!signedErr && signedData && signedData.signedUrl) {
            data.raster_url = signedData.signedUrl;
          }
        } catch (e) {
          console.warn('[AgriTrustSupabase] Could not create signed URL for satellite raster:', e);
        }
      }

      return {
        success: true,
        ...data
      };
    } catch (err) {
      return {
        success: false,
        status: 'NETWORK_ERROR',
        message: err.message || 'Could not connect to satellite processing service.'
      };
    }
  }

  /**
   * Register auth state change callback.
   */
  function onAuthStateChange(callback) {
    if (!supabaseInstance) return null;
    return supabaseInstance.auth.onAuthStateChange(callback);
  }

  return {
    init,
    getClient,
    signIn,
    signUp,
    signInWithGoogle,
    sendPhoneOtp,
    verifyPhoneOtp,
    checkProfileStatus,
    completeFarmerSetup,
    linkGoogleIdentity,
    getAuthRedirectUrl,
    mapAuthErrorToFarmerMessage,
    signOut,
    getSession,
    getUser,
    fetchUserProfile,
    updateUserProfile,
    fetchUserFields,
    saveField,
    updateField,
    deleteField,
    uploadCropEvidenceFile,
    createCropEvidenceRecord,
    fetchFieldEvidence,
    analyzeCropEvidence,
    processFieldSatelliteNdvi,
    onAuthStateChange,
    ready: () => {
      if (isConfigured) return Promise.resolve(true);
      return initPromise || init().then(() => isConfigured);
    },
    isReady: () => Boolean(isConfigured || (clientConfig && clientConfig.configured))
  };
})();

// Explicitly bind AgriTrustSupabase to global window and globalThis scopes
if (typeof window !== 'undefined') {
  window.AgriTrustSupabase = AgriTrustSupabase;
}
if (typeof globalThis !== 'undefined') {
  globalThis.AgriTrustSupabase = AgriTrustSupabase;
}

// Auto-initialize on DOM ready or immediately if DOM is already loaded
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      AgriTrustSupabase.init();
    });
  } else {
    AgriTrustSupabase.init();
  }
}

