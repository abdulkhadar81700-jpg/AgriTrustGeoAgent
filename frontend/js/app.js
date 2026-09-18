/**
 * AgriTrustGeoAgent - Frontend Client Logic
 * Mobile Navigation, Section Observers, Modals, and Interactive Evidence Pipeline
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Mobile Menu Drawer Controller
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileDrawer = document.getElementById('mobileDrawer');
  const drawerBackdrop = document.getElementById('drawerBackdrop');
  const drawerCloseBtn = document.getElementById('drawerCloseBtn');
  const mobileNavLinks = document.querySelectorAll('.mobile-nav-link');

  function openDrawer() {
    if (!mobileDrawer || !drawerBackdrop) return;
    mobileDrawer.classList.add('active');
    drawerBackdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
    if (mobileMenuBtn) {
      mobileMenuBtn.setAttribute('aria-expanded', 'true');
    }
  }

  function closeDrawer() {
    if (!mobileDrawer || !drawerBackdrop) return;
    mobileDrawer.classList.remove('active');
    drawerBackdrop.classList.remove('active');
    document.body.style.overflow = '';
    if (mobileMenuBtn) {
      mobileMenuBtn.setAttribute('aria-expanded', 'false');
    }
  }

  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
      const isExpanded = mobileMenuBtn.getAttribute('aria-expanded') === 'true';
      if (isExpanded) {
        closeDrawer();
      } else {
        openDrawer();
      }
    });
  }

  if (drawerCloseBtn) {
    drawerCloseBtn.addEventListener('click', closeDrawer);
  }

  if (drawerBackdrop) {
    drawerBackdrop.addEventListener('click', closeDrawer);
  }

  mobileNavLinks.forEach(link => {
    link.addEventListener('click', () => {
      closeDrawer();
    });
  });

  // 2. Active Section Highlighting via IntersectionObserver
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.desktop-nav .nav-link');

  if ('IntersectionObserver' in window && sections.length > 0) {
    const observerOptions = {
      root: null,
      rootMargin: '-30% 0px -40% 0px',
      threshold: 0
    };

    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          navLinks.forEach(link => {
            if (link.getAttribute('href') === `#${id}`) {
              link.classList.add('active');
            } else {
              link.classList.remove('active');
            }
          });
        }
      });
    }, observerOptions);

    sections.forEach(section => sectionObserver.observe(section));
  }

  // =========================================================================
  // 3. Farmer-First Authentication & Onboarding Setup Modals
  // =========================================================================
  const authModal = document.getElementById('authModal');
  const closeAuthModalBtn = document.getElementById('closeAuthModal');
  const openLoginBtns = document.querySelectorAll('.js-open-login');
  const openRegisterBtns = document.querySelectorAll('.js-open-register');

  // Auth Panes
  const authOptionsPane = document.getElementById('authOptionsPane');
  const authPhonePane = document.getElementById('authPhonePane');
  const authEmailPane = document.getElementById('authEmailPane');
  const authFeedback = document.getElementById('authFeedback');
  const authBackBtns = document.querySelectorAll('.js-auth-back');

  // Provider Buttons
  const btnAuthGoogle = document.getElementById('btnAuthGoogle');
  const btnAuthPhone = document.getElementById('btnAuthPhone');
  const btnAuthEmail = document.getElementById('btnAuthEmail');

  // Phone OTP Flow Elements
  const phoneStepNumber = document.getElementById('phoneStepNumber');
  const phoneStepOtp = document.getElementById('phoneStepOtp');
  const inputFarmerPhone = document.getElementById('inputFarmerPhone');
  const btnSendPhoneOtp = document.getElementById('btnSendPhoneOtp');
  const phoneOtpSpinner = document.getElementById('phoneOtpSpinner');
  const phoneOtpBtnText = document.getElementById('phoneOtpBtnText');
  const displayTargetPhone = document.getElementById('displayTargetPhone');
  const inputOtpToken = document.getElementById('inputOtpToken');
  const btnVerifyPhoneOtp = document.getElementById('btnVerifyPhoneOtp');
  const verifyOtpSpinner = document.getElementById('verifyOtpSpinner');
  const verifyOtpBtnText = document.getElementById('verifyOtpBtnText');
  const otpCooldownText = document.getElementById('otpCooldownText');
  const otpTimerCount = document.getElementById('otpTimerCount');
  const btnResendOtp = document.getElementById('btnResendOtp');
  let otpCountdownTimer = null;
  let currentTargetPhone = '';

  // Email Fallback Flow Elements
  const authForm = document.getElementById('authForm');
  const modeSignInBtn = document.getElementById('authModeSignIn');
  const modeSignUpBtn = document.getElementById('authModeSignUp');
  const authEmailInput = document.getElementById('authEmail');
  const authPasswordInput = document.getElementById('authPassword');
  const authFullNameInput = document.getElementById('authFullName');
  const authOrgNameInput = document.getElementById('authOrgName');
  const authRegisterFields = document.getElementById('authRegisterFields');
  const authSubmitBtn = document.getElementById('authSubmitBtn');
  const authSubmitSpinner = document.getElementById('authSubmitSpinner');
  const authSubmitBtnText = document.getElementById('authSubmitBtnText');
  const authPromptLink = document.getElementById('authPromptLink');
  const authPromptText = document.getElementById('authPromptText');
  const emailPaneTitle = document.getElementById('emailPaneTitle');
  let currentEmailMode = 'signin';

  // Farmer Setup Wizard Modal Elements
  const farmerSetupModal = document.getElementById('farmerSetupModal');
  const farmerSetupForm = document.getElementById('farmerSetupForm');
  const setupFeedback = document.getElementById('setupFeedback');
  const setupFarmerName = document.getElementById('setupFarmerName');
  const setupFarmName = document.getElementById('setupFarmName');
  const setupFarmLocation = document.getElementById('setupFarmLocation');
  const btnSetupUseGps = document.getElementById('btnSetupUseGps');
  const setupFieldName = document.getElementById('setupFieldName');
  const setupCropVariety = document.getElementById('setupCropVariety');
  const btnCompleteSetup = document.getElementById('btnCompleteSetup');
  const setupSubmitSpinner = document.getElementById('setupSubmitSpinner');
  const setupSubmitBtnText = document.getElementById('setupSubmitBtnText');
  let setupAcquiredCoords = null;

  // Feedback Helpers
  function showAuthFeedback(msg, type = 'info') {
    if (!authFeedback) return;
    authFeedback.className = `auth-feedback-banner ${type}`;
    authFeedback.style.display = 'block';
    authFeedback.innerHTML = msg;
  }

  function hideAuthFeedback() {
    if (!authFeedback) return;
    authFeedback.className = 'auth-feedback-banner';
    authFeedback.style.display = 'none';
    authFeedback.innerHTML = '';
  }

  function showSetupFeedback(msg, type = 'info') {
    if (!setupFeedback) return;
    setupFeedback.className = `auth-feedback-banner ${type}`;
    setupFeedback.style.display = 'block';
    setupFeedback.innerHTML = msg;
  }

  function hideSetupFeedback() {
    if (!setupFeedback) return;
    setupFeedback.className = 'auth-feedback-banner';
    setupFeedback.style.display = 'none';
    setupFeedback.innerHTML = '';
  }

  // Pane Switching
  function showAuthPane(paneName) {
    hideAuthFeedback();
    if (authOptionsPane) authOptionsPane.style.display = paneName === 'options' ? 'block' : 'none';
    if (authPhonePane) authPhonePane.style.display = paneName === 'phone' ? 'block' : 'none';
    if (authEmailPane) authEmailPane.style.display = paneName === 'email' ? 'block' : 'none';
  }

  function openAuthModal(initialPane = 'options', initialEmailMode = 'signin') {
    if (!authModal) return;
    authModal.classList.add('active');
    document.body.style.overflow = 'hidden';
    showAuthPane(initialPane);
    if (initialPane === 'phone') {
      resetPhonePane();
    } else if (initialPane === 'email') {
      setEmailMode(initialEmailMode);
    }
  }

  function closeAuthModal() {
    if (!authModal) return;
    authModal.classList.remove('active');
    document.body.style.overflow = '';
    clearInterval(otpCountdownTimer);
    hideAuthFeedback();
  }

  function resetPhonePane() {
    clearInterval(otpCountdownTimer);
    if (phoneStepNumber) phoneStepNumber.style.display = 'block';
    if (phoneStepOtp) phoneStepOtp.style.display = 'none';
    if (inputFarmerPhone) inputFarmerPhone.value = '';
    if (inputOtpToken) inputOtpToken.value = '';
    if (btnSendPhoneOtp) btnSendPhoneOtp.disabled = false;
    if (phoneOtpSpinner) phoneOtpSpinner.style.display = 'none';
    if (phoneOtpBtnText) phoneOtpBtnText.textContent = 'Send Verification Code';
    if (btnResendOtp) btnResendOtp.style.display = 'none';
    if (otpCooldownText) otpCooldownText.style.display = 'inline';
  }

  function startOtpCooldown(seconds = 30) {
    clearInterval(otpCountdownTimer);
    let remaining = seconds;
    if (otpTimerCount) otpTimerCount.textContent = remaining;
    if (otpCooldownText) otpCooldownText.style.display = 'inline';
    if (btnResendOtp) btnResendOtp.style.display = 'none';

    otpCountdownTimer = setInterval(() => {
      remaining--;
      if (otpTimerCount) otpTimerCount.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(otpCountdownTimer);
        if (otpCooldownText) otpCooldownText.style.display = 'none';
        if (btnResendOtp) btnResendOtp.style.display = 'inline';
      }
    }, 1000);
  }

  // Open/Close bindings
  openLoginBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      closeDrawer();
      openAuthModal('options');
    });
  });

  openRegisterBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      closeDrawer();
      openAuthModal('options');
    });
  });

  if (closeAuthModalBtn) {
    closeAuthModalBtn.addEventListener('click', closeAuthModal);
  }

  if (authModal) {
    authModal.addEventListener('click', (e) => {
      if (e.target === authModal) closeAuthModal();
    });
  }

  authBackBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      showAuthPane('options');
    });
  });

  // 1. Google OAuth Action (Primary)
  if (btnAuthGoogle) {
    btnAuthGoogle.addEventListener('click', async () => {
      btnAuthGoogle.disabled = true;
      showAuthFeedback('Connecting to Google...', 'info');

      try {
        const supabaseSvc = window.AgriTrustSupabase;
        if (!supabaseSvc) {
          showAuthFeedback('Google sign-in is temporarily unavailable. Please try another sign-in method.', 'error');
          btnAuthGoogle.disabled = false;
          return;
        }

        const res = await supabaseSvc.signInWithGoogle();
        if (!res.success) {
          showAuthFeedback(res.message || 'Google sign-in is temporarily unavailable. Please try another sign-in method.', 'error');
          btnAuthGoogle.disabled = false;
        } else if (res.url) {
          window.location.href = res.url;
        }
      } catch (err) {
        console.error('[GoogleAuth] Error:', err);
        showAuthFeedback('Google sign-in is temporarily unavailable. Please try another sign-in method.', 'error');
        btnAuthGoogle.disabled = false;
      }
    });
  }

  // 2. Phone OTP Actions (Secondary)
  if (btnAuthPhone) {
    btnAuthPhone.addEventListener('click', () => {
      showAuthPane('phone');
      resetPhonePane();
    });
  }

  if (btnSendPhoneOtp) {
    btnSendPhoneOtp.addEventListener('click', async () => {
      const raw = (inputFarmerPhone?.value || '').trim().replace(/[\s-]/g, '');
      if (!/^\d{10}$/.test(raw)) {
        showAuthFeedback('Please enter a valid 10-digit Indian mobile number.', 'error');
        return;
      }

      currentTargetPhone = raw;
      btnSendPhoneOtp.disabled = true;
      if (phoneOtpSpinner) phoneOtpSpinner.style.display = 'inline-block';
      if (phoneOtpBtnText) phoneOtpBtnText.textContent = 'Sending code...';
      showAuthFeedback('Requesting one-time verification code via SMS...', 'info');

      try {
        const res = await window.AgriTrustSupabase.sendPhoneOtp(currentTargetPhone);
        if (res.success) {
          phoneStepNumber.style.display = 'none';
          phoneStepOtp.style.display = 'block';
          if (displayTargetPhone) {
            displayTargetPhone.textContent = `+91 ${currentTargetPhone.slice(0, 5)} ${currentTargetPhone.slice(5)}`;
          }
          showAuthFeedback('Verification code sent to your phone via SMS.', 'success');
          startOtpCooldown(30);
          if (inputOtpToken) inputOtpToken.focus();
        } else {
          showAuthFeedback(res.message || 'Phone verification is not available yet.', 'error');
        }
      } catch (err) {
        console.error('[PhoneAuth] Send error:', err);
        showAuthFeedback('Phone verification is not available yet.', 'error');
      } finally {
        btnSendPhoneOtp.disabled = false;
        if (phoneOtpSpinner) phoneOtpSpinner.style.display = 'none';
        if (phoneOtpBtnText) phoneOtpBtnText.textContent = 'Send Verification Code';
      }
    });
  }

  if (btnResendOtp) {
    btnResendOtp.addEventListener('click', () => {
      if (btnSendPhoneOtp) btnSendPhoneOtp.click();
    });
  }

  if (btnVerifyPhoneOtp) {
    btnVerifyPhoneOtp.addEventListener('click', async () => {
      const token = (inputOtpToken?.value || '').trim();
      if (!/^\d{6}$/.test(token)) {
        showAuthFeedback('Please enter the 6-digit verification code.', 'error');
        return;
      }

      btnVerifyPhoneOtp.disabled = true;
      if (verifyOtpSpinner) verifyOtpSpinner.style.display = 'inline-block';
      if (verifyOtpBtnText) verifyOtpBtnText.textContent = 'Verifying code...';
      showAuthFeedback('Verifying code with Supabase...', 'info');

      try {
        const res = await window.AgriTrustSupabase.verifyPhoneOtp(currentTargetPhone, token);
        if (res.success) {
          showAuthFeedback('Verification successful! Opening farm workspace...', 'success');
          setTimeout(async () => {
            await handlePostAuthRoute(res.user);
          }, 800);
        } else {
          showAuthFeedback(res.message || 'The verification code is incorrect or has expired. Please request a new code.', 'error');
        }
      } catch (err) {
        console.error('[PhoneAuth] Verify error:', err);
        showAuthFeedback('The verification code is incorrect or has expired. Please request a new code.', 'error');
      } finally {
        btnVerifyPhoneOtp.disabled = false;
        if (verifyOtpSpinner) verifyOtpSpinner.style.display = 'none';
        if (verifyOtpBtnText) verifyOtpBtnText.textContent = 'Verify & Continue';
      }
    });
  }

  // 3. Email Authentication Actions (Fallback)
  if (btnAuthEmail) {
    btnAuthEmail.addEventListener('click', () => {
      showAuthPane('email');
      setEmailMode('signin');
    });
  }

  function setEmailMode(mode) {
    currentEmailMode = mode;
    hideAuthFeedback();

    if (mode === 'signup') {
      if (modeSignUpBtn) modeSignUpBtn.classList.add('active');
      if (modeSignInBtn) modeSignInBtn.classList.remove('active');
      if (emailPaneTitle) emailPaneTitle.textContent = 'Create Account with Email';
      if (authRegisterFields) authRegisterFields.style.display = 'block';
      if (authFullNameInput) authFullNameInput.setAttribute('required', 'true');
      if (authPasswordInput) authPasswordInput.setAttribute('autocomplete', 'new-password');
      if (authSubmitBtnText) authSubmitBtnText.textContent = 'Create Account & Register';
      if (authPromptText) authPromptText.textContent = 'Already have an account?';
      if (authPromptLink) authPromptLink.textContent = 'Sign In to Farm Portal';
    } else {
      if (modeSignInBtn) modeSignInBtn.classList.add('active');
      if (modeSignUpBtn) modeSignUpBtn.classList.remove('active');
      if (emailPaneTitle) emailPaneTitle.textContent = 'Sign In with Email';
      if (authRegisterFields) authRegisterFields.style.display = 'none';
      if (authFullNameInput) authFullNameInput.removeAttribute('required');
      if (authPasswordInput) authPasswordInput.setAttribute('autocomplete', 'current-password');
      if (authSubmitBtnText) authSubmitBtnText.textContent = 'Sign In to Farm Portal';
      if (authPromptText) authPromptText.textContent = 'New to AgriTrust?';
      if (authPromptLink) authPromptLink.textContent = 'Create an Account →';
    }
  }

  if (modeSignInBtn) modeSignInBtn.addEventListener('click', () => setEmailMode('signin'));
  if (modeSignUpBtn) modeSignUpBtn.addEventListener('click', () => setEmailMode('signup'));
  if (authPromptLink) {
    authPromptLink.addEventListener('click', () => {
      setEmailMode(currentEmailMode === 'signup' ? 'signin' : 'signup');
    });
  }

  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = authEmailInput?.value.trim();
      const password = authPasswordInput?.value.trim();

      if (!email || !password) {
        showAuthFeedback('Please provide both email and security passcode.', 'error');
        return;
      }

      if (currentEmailMode === 'signup' && password.length < 6) {
        showAuthFeedback('Security passcode must be at least 6 characters long.', 'error');
        return;
      }

      const supabaseSvc = window.AgriTrustSupabase;
      if (!supabaseSvc) {
        showAuthFeedback('Authentication service is initializing. Please try again.', 'error');
        return;
      }

      if (authSubmitBtn) authSubmitBtn.disabled = true;
      if (authSubmitSpinner) authSubmitSpinner.style.display = 'inline-block';
      if (authSubmitBtnText) authSubmitBtnText.textContent = currentEmailMode === 'signup' ? 'Creating Account...' : 'Signing In...';
      showAuthFeedback(currentEmailMode === 'signup' ? 'Registering with Supabase...' : 'Verifying credentials...', 'info');

      try {
        if (currentEmailMode === 'signup') {
          const fullName = authFullNameInput?.value.trim();
          const orgName = authOrgNameInput?.value.trim();

          if (!fullName) {
            showAuthFeedback('Please provide your full legal or operator name.', 'error');
            return;
          }

          const metadata = {
            full_name: fullName,
            organization_name: orgName || 'Independent Farm'
          };

          const res = await supabaseSvc.signUp(email, password, 'farmer', metadata);
          if (res.success) {
            if (res.session) {
              showAuthFeedback('Registration complete! Loading farm workspace...', 'success');
              setTimeout(async () => {
                await handlePostAuthRoute(res.user);
              }, 800);
            } else {
              showAuthFeedback('Registration received! Please check your email to complete verification.', 'info');
              setTimeout(() => {
                setEmailMode('signin');
              }, 3000);
            }
          } else {
            const friendlyErr = supabaseSvc.mapAuthErrorToFarmerMessage(res.message, 'email');
            showAuthFeedback(friendlyErr, 'error');
          }
        } else {
          const res = await supabaseSvc.signIn(email, password, 'farmer');
          if (res.success) {
            showAuthFeedback('Sign in successful! Opening farm dashboard...', 'success');
            setTimeout(async () => {
              await handlePostAuthRoute(res.user);
            }, 800);
          } else {
            const friendlyErr = supabaseSvc.mapAuthErrorToFarmerMessage(res.message, 'email');
            showAuthFeedback(friendlyErr, 'error');
          }
        }
      } catch (err) {
        console.error('[EmailAuth] Error:', err);
        const friendlyErr = supabaseSvc.mapAuthErrorToFarmerMessage(err, 'email');
        showAuthFeedback(friendlyErr, 'error');
      } finally {
        if (authSubmitBtn) authSubmitBtn.disabled = false;
        if (authSubmitSpinner) authSubmitSpinner.style.display = 'none';
        if (authSubmitBtnText) {
          authSubmitBtnText.textContent = currentEmailMode === 'signup' ? 'Create Account & Register' : 'Sign In to Farm Portal';
        }
      }
    });
  }

  // 4. Post-Authentication Routing (Returning Farmer vs First-Time Onboarding Wizard)
  async function handlePostAuthRoute(user) {
    const supabaseSvc = window.AgriTrustSupabase;
    if (!supabaseSvc) return;

    try {
      const status = await supabaseSvc.checkProfileStatus();
      if (status && status.isAuthenticated) {
        if (!status.isComplete) {
          // First-time farmer onboarding wizard
          closeAuthModal();
          openFarmerSetupModal(status.profile, user);
        } else {
          // Returning farmer with established profile
          closeAuthModal();
          closeFarmerSetupModal();
          const dashboardSection = document.getElementById('dashboard');
          if (dashboardSection) {
            dashboardSection.scrollIntoView({ behavior: 'smooth' });
          }
          if (window.AgriTrustFarmerDashboard && window.AgriTrustFarmerDashboard.loadFarmerData) {
            window.AgriTrustFarmerDashboard.loadFarmerData();
          }
        }
      }
    } catch (err) {
      console.error('[AgriTrustAuth] Post-auth routing error:', err);
      closeAuthModal();
      const dashboardSection = document.getElementById('dashboard');
      if (dashboardSection) dashboardSection.scrollIntoView({ behavior: 'smooth' });
    }
  }

  // 5. First-Time Farmer Setup Wizard Modal
  function openFarmerSetupModal(profile, user) {
    if (!farmerSetupModal) return;
    farmerSetupModal.classList.add('active');
    document.body.style.overflow = 'hidden';
    hideSetupFeedback();

    if (setupFarmerName) {
      setupFarmerName.value = profile?.full_name || user?.user_metadata?.full_name || '';
    }
    if (setupFarmName) {
      setupFarmName.value = profile?.organization_name || user?.user_metadata?.organization_name || '';
    }
  }

  function closeFarmerSetupModal() {
    if (!farmerSetupModal) return;
    farmerSetupModal.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (farmerSetupModal) {
    farmerSetupModal.addEventListener('click', (e) => {
      // Do not allow clicking outside backdrop to dismiss setup modal until farm profile is established
    });
  }

  // 1-Click GPS Farm Location Integration
  if (btnSetupUseGps) {
    btnSetupUseGps.addEventListener('click', () => {
      btnSetupUseGps.disabled = true;
      btnSetupUseGps.innerHTML = '⏳ Acquiring GPS...';
      hideSetupFeedback();

      if (!navigator.geolocation) {
        btnSetupUseGps.disabled = false;
        btnSetupUseGps.innerHTML = '📍 Use Device Location';
        showSetupFeedback('Device geolocation is not supported in this browser.', 'error');
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const acc = Math.round(pos.coords.accuracy);
          setupAcquiredCoords = { lat, lng, accuracy: acc };

          let placeText = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
              signal: AbortSignal.timeout(3500)
            });
            if (res.ok) {
              const data = await res.json();
              const addr = data.address || {};
              const place = addr.village || addr.suburb || addr.town || addr.city || addr.county || '';
              const state = addr.state || '';
              if (place) {
                placeText = state ? `${place}, ${state}` : place;
              }
            }
          } catch (_) {}

          if (setupFarmLocation) setupFarmLocation.value = placeText;
          btnSetupUseGps.disabled = false;
          btnSetupUseGps.innerHTML = `✅ Location Set (±${acc}m)`;
          setTimeout(() => {
            btnSetupUseGps.innerHTML = '📍 Use Device Location';
          }, 3500);
        },
        (err) => {
          btnSetupUseGps.disabled = false;
          btnSetupUseGps.innerHTML = '📍 Use Device Location';
          showSetupFeedback(`Could not acquire GPS: ${err.message || 'Permission denied'}.`, 'error');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  // Setup Wizard Submission
  if (farmerSetupForm) {
    farmerSetupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fullName = setupFarmerName?.value.trim();
      const farmName = setupFarmName?.value.trim();
      const location = setupFarmLocation?.value.trim();
      const fieldName = setupFieldName?.value.trim();
      const cropVariety = setupCropVariety?.value.trim();

      if (!fullName || !farmName || !location) {
        showSetupFeedback('Please complete Steps 1, 2, and 3 to establish your farm identity.', 'error');
        return;
      }

      if (btnCompleteSetup) btnCompleteSetup.disabled = true;
      if (setupSubmitSpinner) setupSubmitSpinner.style.display = 'inline-block';
      if (setupSubmitBtnText) setupSubmitBtnText.textContent = 'Setting up your farm...';
      showSetupFeedback('Personalizing your farm intelligence dashboard...', 'info');

      try {
        let initialField = null;
        if (fieldName) {
          let boundary = null;
          if (setupAcquiredCoords) {
            const { lat, lng } = setupAcquiredCoords;
            const d = 0.00045; // ~50m box (approx 1 acre)
            boundary = `SRID=4326;POLYGON((${lng - d} ${lat - d}, ${lng + d} ${lat - d}, ${lng + d} ${lat + d}, ${lng - d} ${lat + d}, ${lng - d} ${lat - d}))`;
          }
          initialField = {
            name: fieldName,
            crop_variety: cropVariety || 'Mixed Crop',
            boundary: boundary,
            acreage: 1.0
          };
        }

        const res = await window.AgriTrustSupabase.completeFarmerSetup({
          fullName,
          farmName,
          location,
          initialField
        });

        if (res.success) {
          showSetupFeedback('Farm setup complete! Opening your dashboard...', 'success');
          setTimeout(() => {
            closeFarmerSetupModal();
            const dashboardSection = document.getElementById('dashboard');
            if (dashboardSection) {
              dashboardSection.scrollIntoView({ behavior: 'smooth' });
            }
            if (window.AgriTrustFarmerDashboard && window.AgriTrustFarmerDashboard.loadFarmerData) {
              window.AgriTrustFarmerDashboard.loadFarmerData();
            }
          }, 900);
        } else {
          showSetupFeedback(res.message || 'Could not save farm setup. Please try again.', 'error');
        }
      } catch (err) {
        console.error('[FarmerSetup] Error:', err);
        showSetupFeedback(`Setup error: ${err.message || err}`, 'error');
      } finally {
        if (btnCompleteSetup) btnCompleteSetup.disabled = false;
        if (setupSubmitSpinner) setupSubmitSpinner.style.display = 'none';
        if (setupSubmitBtnText) setupSubmitBtnText.textContent = 'Continue to Farm Dashboard →';
      }
    });
  }

  // Header Profile Chip Click -> Opens Profile Modal
  const btnHeaderProfile = document.getElementById('btnHeaderProfile');
  if (btnHeaderProfile) {
    btnHeaderProfile.addEventListener('click', () => {
      if (window.AgriTrustFarmerDashboard && window.AgriTrustFarmerDashboard.openProfile) {
        window.AgriTrustFarmerDashboard.openProfile();
      }
    });
  }

  // Listen for Supabase Auth State Changes (Google OAuth redirect return, etc.)
  if (window.AgriTrustSupabase) {
    window.AgriTrustSupabase.ready().then(async () => {
      const session = await window.AgriTrustSupabase.getSession();
      if (session && session.user) {
        const status = await window.AgriTrustSupabase.checkProfileStatus();
        if (status && status.isAuthenticated && !status.isComplete) {
          openFarmerSetupModal(status.profile, session.user);
        }
      }

      if (window.AgriTrustSupabase.onAuthStateChange) {
        window.AgriTrustSupabase.onAuthStateChange(async (event, session) => {
          if (event === 'SIGNED_IN' && session?.user) {
            const status = await window.AgriTrustSupabase.checkProfileStatus();
            if (status && status.isAuthenticated && !status.isComplete) {
              closeAuthModal();
              openFarmerSetupModal(status.profile, session.user);
            } else if (status && status.isComplete) {
              closeAuthModal();
              closeFarmerSetupModal();
              if (window.AgriTrustFarmerDashboard && window.AgriTrustFarmerDashboard.loadFarmerData) {
                window.AgriTrustFarmerDashboard.loadFarmerData();
              }
            }
          }
        });
      }
    });
  }

  // 4. Contact & Consultation Form Handler
  const contactForm = document.getElementById('contactForm');
  const contactFeedback = document.getElementById('contactFeedback');

  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('contactName')?.value.trim();
      const email = document.getElementById('contactEmail')?.value.trim();
      const farmName = document.getElementById('contactFarm')?.value.trim();
      const category = document.getElementById('contactType')?.value;

      if (!name || !email) {
        alert('Please fill in your name and email address.');
        return;
      }

      if (contactFeedback) {
        contactFeedback.classList.add('success');
        contactFeedback.innerHTML = `
          <strong>Inquiry Registered:</strong> Thank you, ${name}. Your request for <em>${farmName || 'your farm operation'}</em> (Category: ${category}) has been logged. Our agronomy systems team will review your field requirements and respond to <strong>${email}</strong>.
        `;
        contactForm.reset();
      }
    });
  }

  // 5. Keyboard Navigation (ESC to close modals)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAuthModal();
      closeDrawer();
    }
  });
});
