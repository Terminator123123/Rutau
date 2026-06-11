const UNIGUAJIRA_COORDS = [11.5392, -72.9066];
const MAX_PASSENGERS    = 4;
const CLUSTER_RADIUS_M  = 30;
const REQUEST_TIMEOUT_S = 40;

const STATUS_CYCLE  = ["disponible", "lleno", "en camino"];
const STATUS_LABELS = { disponible: "Disponible", lleno: "Lleno", "en camino": "En camino" };

let map, ws, myStatus, watchId;
let myId = null, myDbId = null;
let manualPassengers = 0;
let lastLat = null, lastLng = null;
let currentUser = null;
let currentZone  = "";
let availableZones = [];

// Trip state
let activeRequestId        = null;
let activeTripId           = null;
let activeConductorId      = null; // session_id del conductor asignado al estudiante
let pendingRatingTrip      = null;
let requestTimerInterval   = null;
let _pendingBoardingTrip   = null; // conductor: { trip_id, studentName }

// Offer state (estudiante elige conductor)
let _offerQueue   = [];   // ofertas en espera de mostrarse
let _currentOffer = null; // { request_id, conductor_session_id, conductor, timeout_s }
let _offerTimer   = null; // timeout que auto-descarta la oferta visible

// Map state
let showingNearby = false;
let studentLocationEnabled = false;
let _myMarker = null;
const markers        = {};
const clusterMarkers = {};
const _pendingConductors = {};
let _bgMarkers = {};
let _bgPollTimer = null;

// ── Cookie ─────────────────────────────────────────────────────────────────

function readSessionCookie() {
  const match = document.cookie.split("; ").find(r => r.startsWith("cu_info="));
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match.split("=")[1])); } catch (_) { return null; }
}

// ── PWA Install ───────────────────────────────────────────────────────────
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // El navegador solo dispara este evento si la app NO está instalada,
  // así que mostrar el banner aquí ya corrobora la instalación.
  _showInstallBanner();
});

function _showInstallBanner() {
  if (!_deferredInstallPrompt) return;
  let banner = document.getElementById('pwa-install-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
      'background:#0e7490', 'color:#fff', 'border-radius:1rem', 'padding:0.75rem 1.25rem',
      'font-size:0.875rem', 'font-weight:600', 'box-shadow:0 4px 16px rgba(14,116,144,0.4)',
      'display:flex', 'align-items:center', 'gap:0.75rem', 'z-index:9999',
      'animation:slideUp 0.3s ease',
    ].join(';');
    banner.innerHTML = `
      <span>📲 Instalar ColectivoU</span>
      <button onclick="installPWA()" style="background:#fff;color:#0e7490;border:none;
        border-radius:0.5rem;padding:0.35rem 0.75rem;font-weight:700;cursor:pointer;font-size:0.8rem;">
        Instalar
      </button>
      <button onclick="this.closest('#pwa-install-banner').remove()" style="background:transparent;
        border:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:1.2rem;line-height:1;">×</button>
    `;
    document.body.appendChild(banner);
    setTimeout(() => banner?.remove(), 15000);
  }
}

async function installPWA() {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  _deferredInstallPrompt = null;
  document.getElementById('pwa-install-banner')?.remove();
}

window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  document.getElementById('pwa-install-banner')?.remove();
  document.getElementById('dr-install')?.classList.add('hidden');
});

function _isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// ── Compartir app (QR + link) ───────────────────────────────────────────────
let _qrRendered = false;

function showQRModal() {
  const link = location.origin + "/dev";
  document.getElementById("qr-link").value = link;
  if (!_qrRendered && window.QRCode) {
    new QRCode(document.getElementById("qr-canvas"), {
      text: link, width: 220, height: 220,
      colorDark: "#0e7490", colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
    _qrRendered = true;
  }
  document.getElementById("qr-modal").classList.remove("hidden");
}

function closeQRModal() {
  document.getElementById("qr-modal").classList.add("hidden");
}

function copyInviteLink() {
  const inp = document.getElementById("qr-link");
  const done = () => showToast("Enlace copiado ✓");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(inp.value).then(done).catch(() => {
      inp.select(); document.execCommand("copy"); done();
    });
  } else {
    inp.select(); document.execCommand("copy"); done();
  }
}

function installFromMenu() {
  closeDrawer();
  if (_isStandalone()) {
    showToast("La app ya está instalada.");
    return;
  }
  if (_deferredInstallPrompt) {
    installPWA();
    return;
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  showToast(isIOS
    ? "En iPhone: toca Compartir y luego «Añadir a pantalla de inicio»."
    : "En el menú del navegador (⋮) elige «Instalar aplicación» o «Añadir a pantalla de inicio».");
}

// ── Init ───────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  }
  if (_isStandalone()) document.getElementById('dr-install')?.classList.add('hidden');
  initMap();
  startBgPoll();
  setupFormValidation();
  const params = new URLSearchParams(location.search);
  if (params.get("verified") === "1") showVerifiedBanner();
  if (params.get("google_error") === "1") showGoogleErrorBanner();
  const saved = readSessionCookie();
  if (saved) {
    currentUser = saved;
    fetch("/me", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(full => { if (full) currentUser = full; })
      .catch(() => {})
      .finally(() => startMap());
  }
});

// ── Real-time form validation ──────────────────────────────────────────────

function setupFormValidation() {
  const validators = {
    "login-email":    v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    "login-password": v => v.length >= 6,
    "reg-name":       v => v.trim().length >= 2,
    "reg-email":      v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    "reg-password":   v => v.length >= 6,
    "edit-name":      v => v.trim().length >= 2,
  };

  Object.entries(validators).forEach(([id, test]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("blur", () => {
      if (!el.value) { el.classList.remove("valid", "invalid"); return; }
      el.classList.toggle("valid",   test(el.value));
      el.classList.toggle("invalid", !test(el.value));
    });
    el.addEventListener("input", () => {
      if (el.classList.contains("invalid") && test(el.value)) {
        el.classList.replace("invalid", "valid");
      }
    });
  });
}

function showVerifiedBanner() {
  const msg = document.getElementById("login-error");
  if (msg) {
    msg.className = "form-msg success";
    msg.textContent = "¡Correo verificado! Ya puedes iniciar sesión.";
  }
}

function showGoogleErrorBanner() {
  const msg = document.getElementById("login-error");
  if (msg) {
    msg.className = "form-msg error";
    msg.textContent = "No se pudo iniciar sesión con Google. Intenta de nuevo.";
  }
}

// ── Background poll ────────────────────────────────────────────────────────

function startBgPoll() {
  pollBgUsers();
  _bgPollTimer = setInterval(pollBgUsers, 6000);
}

function stopBgPoll() {
  clearInterval(_bgPollTimer); _bgPollTimer = null;
  Object.values(_bgMarkers).forEach(m => m.remove());
  _bgMarkers = {};
}

function pollBgUsers() {
  fetch("/usuarios/activos").then(r => r.json()).then(data => {
    if (!_bgPollTimer) return;
    const activeIds = new Set((data.usuarios || []).map(u => u.id));
    Object.keys(_bgMarkers).forEach(id => {
      if (!activeIds.has(id)) { _bgMarkers[id].remove(); delete _bgMarkers[id]; }
    });
    (data.usuarios || []).forEach(u => {
      if (!u.lat || !u.lng) return;
      const icon = buildIcon(u, false);
      if (_bgMarkers[u.id]) { _bgMarkers[u.id].setLatLng([u.lat, u.lng]).setIcon(icon); }
      else { _bgMarkers[u.id] = L.marker([u.lat, u.lng], { icon }).addTo(map); }
    });
  }).catch(() => {});
}

// ── Auth tabs ──────────────────────────────────────────────────────────────

function showTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("login-form").classList.toggle("hidden", !isLogin);
  document.getElementById("register-form").classList.toggle("hidden", isLogin);
  document.querySelectorAll(".tab").forEach((t, i) =>
    t.classList.toggle("active", isLogin ? i === 0 : i === 1));
  ["login-error", "register-msg"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = "form-msg hidden"; el.textContent = ""; }
  });
}

function selectRole(role) {
  document.getElementById("reg-role").value = role;
  document.getElementById("toggle-estudiante").classList.toggle("active", role === "estudiante");
  document.getElementById("toggle-conductor").classList.toggle("active", role === "conductor");
}

function showForgot() {
  const errEl = document.getElementById("login-error");
  const email = document.getElementById("login-email").value.trim();
  if (!email) { errEl.className = "form-msg error"; errEl.textContent = "Ingresa tu correo primero."; return; }
  errEl.className = "form-msg hidden";
  fetch("/forgot-password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  }).then(() => {
    errEl.className = "form-msg success";
    errEl.textContent = "Si el correo existe, recibirás un enlace para restablecer tu contraseña.";
  }).catch(() => { errEl.className = "form-msg error"; errEl.textContent = "Error al enviar. Intenta de nuevo."; });
}

// ── T&C Modal ──────────────────────────────────────────────────────────────

function showTermsModal() {
  document.getElementById("terms-modal").classList.remove("hidden");
}

function closeTermsModal() {
  document.getElementById("terms-modal").classList.add("hidden");
}

// ── Login ──────────────────────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();
  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl    = document.getElementById("login-error");
  const btn      = e.target.querySelector("button[type=submit]");
  errEl.className = "form-msg hidden";

  setLoading(btn, true);
  try {
    const res  = await fetch("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Credenciales incorrectas");
    currentUser = data;
    setLoading(btn, false);
    startMap();
  } catch (err) {
    errEl.className = "form-msg error"; errEl.textContent = err.message;
    setLoading(btn, false);
  }
}

// ── Register ───────────────────────────────────────────────────────────────

async function handleRegister(e) {
  e.preventDefault();
  const name     = document.getElementById("reg-name").value.trim();
  const email    = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const role     = document.getElementById("reg-role").value;
  const terms    = document.getElementById("terms-check").checked;
  const msgEl    = document.getElementById("register-msg");
  const btn      = e.target.querySelector("button[type=submit]");
  msgEl.className = "form-msg hidden";

  if (!terms) {
    msgEl.className = "form-msg error";
    msgEl.textContent = "Debes aceptar los términos y condiciones.";
    return;
  }

  setLoading(btn, true);
  try {
    const res  = await fetch("/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name, email, password, role, terms_accepted: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Error al registrarse");
    msgEl.className = "form-msg success";
    msgEl.textContent = "¡Cuenta creada! Revisa tu correo y haz clic en el enlace de verificación.";
    e.target.reset(); selectRole("estudiante");
    setLoading(btn, false);
  } catch (err) {
    msgEl.className = "form-msg error"; msgEl.textContent = err.message;
    setLoading(btn, false);
  }
}

// ── Onboarding wizard (conductor nuevo) ───────────────────────────────────

let _currentOnboardingStep = 1;

function showConductorUpgrade() {
  closeDrawer();
  showOnboardingModal();
}

function showOnboardingModal() {
  _currentOnboardingStep = 1;
  _renderOnboardingStep(1);
  document.getElementById("onboarding-modal").classList.remove("hidden");
}

function goToOnboardingStep(step) {
  // Validate current step before advancing
  if (step > _currentOnboardingStep) {
    if (!_validateOnboardingStep(_currentOnboardingStep)) return;
  }
  _currentOnboardingStep = step;
  _renderOnboardingStep(step);
}

function _validateOnboardingStep(step) {
  if (step === 1) {
    const cedula  = document.getElementById("ob-cedula-numero").value.trim();
    const telefono = document.getElementById("ob-telefono").value.trim();
    const msg = document.getElementById("ob-msg-1");
    if (!cedula || !telefono) {
      msg.className = "form-msg error";
      msg.textContent = "Completa todos los campos antes de continuar.";
      return false;
    }
    msg.className = "form-msg hidden";
    return true;
  }
  if (step === 2) {
    const placa  = document.getElementById("ob-placa").value.trim();
    const color  = document.getElementById("ob-color").value.trim();
    const modelo = document.getElementById("ob-modelo").value.trim();
    const msg = document.getElementById("ob-msg-2");
    if (!placa || !color || !modelo) {
      msg.className = "form-msg error";
      msg.textContent = "Completa todos los campos antes de continuar.";
      return false;
    }
    msg.className = "form-msg hidden";
    return true;
  }
  return true;
}

function _renderOnboardingStep(step) {
  [1, 2, 3].forEach(i => {
    document.getElementById(`ob-page-${i}`).classList.toggle("hidden", i !== step);
    const dot = document.querySelector(`#ob-ind-${i} .ob-dot`);
    if (dot) {
      dot.classList.toggle("active", i === step);
      dot.classList.toggle("done", i < step);
    }
    if (i < 3) {
      const line = document.getElementById(`ob-line-${i}`);
      if (line) line.classList.toggle("done", i < step);
    }
  });
}

async function submitOnboarding() {
  if (!_validateOnboardingStep(2)) { goToOnboardingStep(2); return; }

  const cedula  = document.getElementById("ob-doc-cedula").files[0];
  const selfie  = document.getElementById("ob-doc-selfie").files[0];
  const plate   = document.getElementById("ob-doc-plate").files[0];
  const soat    = document.getElementById("ob-doc-soat").files[0];
  const msg     = document.getElementById("ob-msg-3");
  const btn     = document.getElementById("ob-submit-btn");

  if (!cedula || !selfie || !plate || !soat) {
    msg.className = "form-msg error";
    msg.textContent = "Debes subir los 4 documentos requeridos.";
    return;
  }

  const fd = new FormData();
  fd.append("cedula_numero", document.getElementById("ob-cedula-numero").value.trim());
  fd.append("telefono",      document.getElementById("ob-telefono").value.trim());
  fd.append("placa_numero",  document.getElementById("ob-placa").value.trim().toUpperCase());
  fd.append("color_carro",   document.getElementById("ob-color").value.trim());
  fd.append("modelo_carro",  document.getElementById("ob-modelo").value.trim());
  fd.append("cedula", cedula);
  fd.append("selfie", selfie);
  fd.append("plate",  plate);
  fd.append("soat",   soat);

  setLoading(btn, true);
  msg.className = "form-msg hidden";

  try {
    const res  = await fetch("/conductor/documents", { method: "POST", credentials: "include", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Error al enviar");

    document.getElementById("onboarding-modal").classList.add("hidden");

    // Actualizar estado local del usuario
    const wasStudent = currentUser.role === "estudiante";
    currentUser.role             = "conductor";
    currentUser.conductor_status = "pending";

    if (wasStudent) {
      // Ocultar controles de estudiante, mostrar banner de pendiente
      document.getElementById("student-actions").classList.add("hidden");
      document.getElementById("dr-become-conductor")?.classList.add("hidden");
      document.getElementById("dr-conductor")?.classList.remove("hidden");
    }

    document.getElementById("pending-banner").classList.remove("hidden");

    if (!lastLat) requestLocation();
  } catch (err) {
    msg.className = "form-msg error";
    msg.textContent = err.message;
    setLoading(btn, false);
  }
}

// ── Document upload (conductor pendiente — re-subida desde drawer) ─────────

function showDocsModal() {
  document.getElementById("docs-modal").classList.remove("hidden");
}

function closeDocsModal() {
  document.getElementById("docs-modal").classList.add("hidden");
  document.getElementById("docs-msg").className = "form-msg hidden";
}

function closeSelf(e) {
  if (e.target === e.currentTarget) closeDocsModal();
}

async function uploadDocuments(e) {
  e.preventDefault();
  const msgEl = document.getElementById("docs-msg");
  const btn   = e.target.querySelector("button[type=submit]");
  const form  = e.target;
  msgEl.className = "form-msg hidden";

  const fd = new FormData();
  fd.append("cedula", form.cedula.files[0]);
  fd.append("selfie", form.selfie.files[0]);
  fd.append("plate",  form.plate.files[0]);
  fd.append("soat",   form.soat.files[0]);

  setLoading(btn, true);
  try {
    const res  = await fetch("/conductor/documents", { method: "POST", credentials: "include", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Error al subir");
    msgEl.className = "form-msg success";
    msgEl.textContent = data.message;
    setLoading(btn, false);
  } catch (err) {
    msgEl.className = "form-msg error"; msgEl.textContent = err.message;
    setLoading(btn, false);
  }
}

// ── Map init & transition ──────────────────────────────────────────────────

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false }).setView(UNIGUAJIRA_COORDS, 15);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19,
  }).addTo(map);
}

function refreshSaldo() {
  if (currentUser?.role !== "conductor") return;
  fetch("/conductor/saldo", { credentials: "include" })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      const chip = document.getElementById("tb-saldo");
      const amount = document.getElementById("tb-saldo-amount");
      if (!chip || !amount) return;
      chip.classList.remove("hidden");
      amount.textContent = `$${Math.round(data.saldo).toLocaleString("es-CO")}`;
      chip.classList.toggle("low", data.saldo < 500);
    })
    .catch(() => {});
}

function startMap() {
  stopBgPoll();
  myDbId   = currentUser.id;
  myStatus = currentUser.role === "conductor" ? "disponible" : null;
  manualPassengers = 0;

  // Profile card
  document.getElementById("tb-name").textContent = currentUser.name;
  document.getElementById("tb-stars").innerHTML  = renderStarRow(
    currentUser.rating_avg, currentUser.rating_count, "0.65rem"
  );

  const isApproved = currentUser.role === "conductor" && currentUser.conductor_status === "approved";
  const isPending  = currentUser.role === "conductor" && currentUser.conductor_status !== "approved";

  if (currentUser.role === "conductor") {
    if (isApproved) {
      document.getElementById("conductor-controls").classList.remove("hidden");
      document.getElementById("passenger-counter").classList.remove("hidden");
      document.getElementById("passengers-panel").classList.remove("hidden");
      refreshPassengersEmpty();
      updateStatusButton();
      updateCounterDisplay(0);
      refreshSaldo();
    } else if (!currentUser.conductor_status) {
      // Conductor nuevo — mostrar wizard después de la transición al mapa
      const authScreen = document.getElementById("auth-screen");
      const card       = authScreen.querySelector(".auth-card");
      const overlay    = authScreen.querySelector(".auth-overlay");
      card.style.transform = "scale(1.12) translateY(-12px)";
      card.style.opacity   = "0";
      overlay.style.opacity        = "0";
      overlay.style.backdropFilter = "blur(0px)";
      setTimeout(() => {
        authScreen.classList.add("hidden");
        document.getElementById("topbar").classList.remove("hidden");
        map.invalidateSize();
        showOnboardingModal();
      }, 580);
      return;
    } else {
      const pbTitle = document.getElementById("pb-title");
      if (currentUser.conductor_status === "rejected") {
        pbTitle.textContent = "Verificación rechazada";
        document.getElementById("pending-banner").style.borderColor = "rgba(239,68,68,0.3)";
        document.getElementById("pending-banner").querySelector(".pb-inner").style.background = "rgba(239,68,68,0.08)";
        pbTitle.style.color = "#f87171";
        document.getElementById("pending-banner").querySelector(".pb-btn").style.borderColor = "rgba(239,68,68,0.3)";
        document.getElementById("pending-banner").querySelector(".pb-btn").style.color = "#f87171";
      }
      document.getElementById("pending-banner").classList.remove("hidden");
    }
  } else {
    document.getElementById("student-actions").classList.remove("hidden");
  }

  const authScreen = document.getElementById("auth-screen");
  const card       = authScreen.querySelector(".auth-card");
  const overlay    = authScreen.querySelector(".auth-overlay");
  card.style.transform = "scale(1.12) translateY(-12px)";
  card.style.opacity   = "0";
  overlay.style.opacity          = "0";
  overlay.style.backdropFilter   = "blur(0px)";

  setTimeout(() => {
    authScreen.classList.add("hidden");
    document.getElementById("topbar").classList.remove("hidden");
    map.invalidateSize();
    requestLocation();
  }, 580);
}

async function logout() {
  closeDrawer();
  try { await fetch("/logout", { method: "POST", credentials: "include" }); } catch (_) {}
  currentUser = null;
  cleanup();

  document.getElementById("topbar").classList.add("hidden");
  document.getElementById("conductor-controls").classList.add("hidden");
  document.getElementById("passenger-counter").classList.add("hidden");
  document.getElementById("passengers-panel").classList.add("hidden");
  document.getElementById("student-actions").classList.add("hidden");
  document.getElementById("waiting-overlay").classList.add("hidden");
  document.getElementById("trip-bottom-sheet").classList.add("hidden");
  document.getElementById("conductor-accepted-trip").classList.add("hidden");
  document.getElementById("pending-banner").classList.add("hidden");

  const authScreen = document.getElementById("auth-screen");
  const card       = authScreen.querySelector(".auth-card");
  const overlay    = authScreen.querySelector(".auth-overlay");
  card.style.transition    = "none";
  overlay.style.transition = "none";
  card.style.transform     = "scale(1.12) translateY(-12px)";
  card.style.opacity       = "0";
  overlay.style.opacity    = "0";
  overlay.style.backdropFilter = "blur(0px)";
  authScreen.classList.remove("hidden");

  requestAnimationFrame(() => requestAnimationFrame(() => {
    card.style.transition    = "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s ease";
    overlay.style.transition = "opacity 0.55s ease, backdrop-filter 0.55s ease";
    card.style.transform     = "scale(1) translateY(0)";
    card.style.opacity       = "1";
    overlay.style.opacity    = "1";
    overlay.style.backdropFilter = "blur(2px) brightness(0.92)";
  }));

  startBgPoll();
}

// ── Geolocation ────────────────────────────────────────────────────────────

function requestLocation() {
  if (!navigator.geolocation) { setStatus("error", "GPS no disponible"); return; }
  setStatus("connecting", "Obteniendo ubicacion...");
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      map.setView([lat, lng], 16);
      updateMyMarker(lat, lng);
      connectWS(lat, lng);
      startWatching();
    },
    ()  => setStatus("error", "Permiso de ubicacion denegado"),
    { enableHighAccuracy: true }
  );
}

function startWatching() {
  watchId = navigator.geolocation.watchPosition(
    pos => {
      updateMyMarker(pos.coords.latitude, pos.coords.longitude);
      if (ws && ws.readyState === WebSocket.OPEN) sendLocation(pos.coords.latitude, pos.coords.longitude);
    },
    ()   => {},
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

function updateMyMarker(lat, lng) {
  if (!currentUser || currentUser.role !== "estudiante") return;
  if (_myMarker) {
    _myMarker.setLatLng([lat, lng]);
  } else {
    const icon = buildIcon({ role: "estudiante" }, true);
    _myMarker = L.marker([lat, lng], { icon })
      .addTo(map)
      .bindPopup(`<div class="popup-name">${currentUser.name} (tú)</div>`);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connectWS(lat, lng) {
  // Avoid creating a second connection if one is already open or connecting
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  stopBgPoll();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen    = () => { setStatus("connected", "En vivo"); sendLocation(lat, lng); };
  ws.onmessage = e  => handleMessage(JSON.parse(e.data));
  ws.onclose   = e  => {
    if (e.code === 4001) { showToast("Sesión expirada. Vuelve a iniciar sesión."); logout(); return; }
    if (e.code === 4003) { showToast("Cuenta no verificada."); logout(); return; }
    if (!currentUser) return;  // Don't reconnect after logout
    setStatus("connecting", "Reconectando...");
    if (lastLat !== null) setTimeout(() => connectWS(lastLat, lastLng), 3000);
  };
  ws.onerror = () => setStatus("error", "Error de conexion");
}

function sendLocation(lat, lng) {
  lastLat = lat; lastLng = lng;
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (currentUser && currentUser.role === "estudiante" && !studentLocationEnabled) return;
    ws.send(JSON.stringify({
      type: "location",
      lat, lng,
      status: myStatus,
      manual_passengers: currentUser.role === "conductor" ? manualPassengers : 0,
      zone_destination: currentZone || null,
    }));
  }
}

function sendWS(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ── Message handler ────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case "snapshot":
      msg.users.forEach(addOrUpdateMarker);
      if (msg.zones) populateZoneSelect(msg.zones);
      break;

    case "update":
      if (!myId && msg.user.name === currentUser.name && msg.user.role === currentUser.role)
        myId = msg.user.id;
      addOrUpdateMarker(msg.user);
      if (msg.user.id === myId && currentUser.role === "conductor") {
        if (msg.user.status !== myStatus) { myStatus = msg.user.status; updateStatusButton(); }
        updateCounterDisplay(msg.user.onboard_count);
      }
      break;

    case "remove":
      removeMarker(msg.id);
      break;

    // ── Trip events ──────────────────────────────────────────────────────
    case "trip_request_incoming":
      showRequestModal(msg);
      break;

    case "conductor_offer":
      onConductorOffer(msg);
      break;

    case "offer_waiting":
      document.getElementById("offer-waiting-banner").classList.remove("hidden");
      break;

    case "offer_declined": {
      document.getElementById("offer-waiting-banner").classList.add("hidden");
      const reasons = {
        timeout:             "El estudiante no respondió a tiempo.",
        rejected:            "El estudiante rechazó tu oferta.",
        student_chose_other: "El estudiante eligió otro conductor.",
      };
      showToast(reasons[msg.reason] || "La oferta no fue aceptada.");
      break;
    }

    case "offer_expired":
      hideOfferCard();
      showToast("Esa oferta ya expiró.");
      showNextOffer();
      break;

    case "trip_accepted":
      onTripAccepted(msg);
      break;

    case "trip_accept_confirmed":
      document.getElementById("offer-waiting-banner").classList.add("hidden");
      onTripAcceptConfirmed(msg);
      break;

    case "trip_rejected":
      onTripRejected(msg);
      break;

    case "trip_cancelled":
      closeRequestModal();
      document.getElementById("offer-waiting-banner").classList.add("hidden");
      break;

    case "trip_cancelled_active":
      onTripCancelledActive(msg);
      break;

    case "trip_taken":
    case "trip_already_taken":
      closeRequestModal();
      showToast("El viaje ya fue tomado.");
      break;

    case "trip_restored":
      activeTripId = msg.trip_id;
      if (currentUser && currentUser.role === "estudiante") {
        studentLocationEnabled = true;
        document.getElementById("waiting-overlay").classList.add("hidden");
        document.getElementById("student-actions").classList.add("hidden");
        document.getElementById("trip-bottom-sheet").classList.remove("hidden");
        document.getElementById("btn-cancel-active-trip").classList.remove("hidden");
      }
      showToast("Reconectado — viaje activo restaurado.");
      break;

    case "trip_partner_disconnected":
      showToast("La otra persona perdió conexión. Esperando 45 s...");
      break;

    case "trip_partner_reconnected":
      showToast("La otra persona se reconectó.");
      break;

    case "onboard_verified": {
      const msgCharge = msg.charged > 0 ? ` (cobro: $${msg.charged})` : "";
      showToast(`Pasajero verificado a bordo ✓${msgCharge}`);
      refreshSaldo();
      break;
    }

    case "onboard_failed": {
      const distTxt = msg.distance_m != null ? ` Está a ${msg.distance_m} m.` : "";
      showToast(`No se pudo verificar que el estudiante esté en el carro.${distTxt}`);
      const item = document.getElementById(`passenger-${msg.trip_id}`);
      if (item) item.remove();
      removeManual();
      refreshPassengersEmpty();
      break;
    }

    case "onboard_confirmed":
      activeTripId = msg.trip_id;
      document.getElementById("btn-cancel-active-trip").classList.add("hidden");
      showToast("¡A bordo! Buen viaje.");
      break;

    case "dropoff_confirmed":
      activeTripId = null;
      studentLocationEnabled = false;
      document.getElementById("trip-bottom-sheet").classList.add("hidden");
      break;

    case "rate_prompt":
      activeTripId = null;
      studentLocationEnabled = false;
      showingNearby = false;
      document.getElementById("trip-bottom-sheet").classList.add("hidden");
      document.getElementById("student-actions").classList.remove("hidden");
      showRatingModal(msg);
      break;

    case "quick_message":
      showToast(`${msg.from_name}: ${msg.message_text}`);
      break;
  }
}

// ── Trip — estudiante ──────────────────────────────────────────────────────

function requestRide() {
  if (!lastLat) { showToast("Espera a tener ubicación GPS."); return; }
  if (activeRequestId || activeTripId) return;

  activeRequestId = "pending";
  studentLocationEnabled = true;
  sendLocation(lastLat, lastLng);

  document.getElementById("student-actions").classList.add("hidden");
  document.getElementById("waiting-overlay").classList.remove("hidden");

  const zone = document.getElementById("student-zone-select")?.value || "";
  sendWS({ type: "trip_request", zone_destination: zone });

  // Zoom out animation while waiting
  map.flyTo([lastLat, lastLng], 13, { animate: true, duration: REQUEST_TIMEOUT_S });
}

let _cancelCooldownTimer = null;

function cancelRide() {
  document.getElementById("cancel-reason-modal").classList.remove("hidden");
}

function closeCancelReasonModal() {
  document.getElementById("cancel-reason-modal").classList.add("hidden");
}

function confirmCancelRide(reason) {
  closeCancelReasonModal();
  studentLocationEnabled = false;
  sendWS({ type: "trip_cancel", reason });
  activeRequestId = null;
  resetStudentUI();
  _startCancelCooldown(30);
}

function _startCancelCooldown(seconds) {
  const btn = document.querySelector("#student-actions .action-btn.primary");
  if (!btn) return;
  clearInterval(_cancelCooldownTimer);
  let remaining = seconds;
  btn.disabled = true;
  btn.textContent = `Espera ${remaining}s`;
  _cancelCooldownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(_cancelCooldownTimer);
      btn.disabled = false;
      btn.textContent = "Solicitar colectivo";
    } else {
      btn.textContent = `Espera ${remaining}s`;
    }
  }, 1000);
}

function resetStudentUI() {
  showingNearby = false;
  clearOffers();
  document.getElementById("waiting-overlay").classList.add("hidden");
  document.getElementById("trip-bottom-sheet").classList.add("hidden");
  document.getElementById("student-actions").classList.remove("hidden");
  if (lastLat) map.flyTo([lastLat, lastLng], 15, { animate: true, duration: 1.2 });
}

// ── Ofertas de conductores (el estudiante elige) ───────────────────────────

function onConductorOffer(msg) {
  _offerQueue.push(msg);
  if (!_currentOffer) showNextOffer();
}

function showNextOffer() {
  if (_currentOffer || !_offerQueue.length) return;
  const offer = _offerQueue.shift();
  _currentOffer = offer;
  const c = offer.conductor || {};

  document.getElementById("offer-name").textContent = c.name || "Conductor";
  document.getElementById("offer-stars").innerHTML =
    (c.rating != null && c.rating_count)
      ? renderStarRow(c.rating, c.rating_count, "0.78rem")
      : (c.rating != null ? `<span style="color:#f59e0b">★ ${c.rating}</span>` : "");

  const plateEl = document.getElementById("offer-plate");
  const colorEl = document.getElementById("offer-color");
  const modelEl = document.getElementById("offer-model");
  plateEl.textContent = c.placa  || ""; plateEl.classList.toggle("hidden", !c.placa);
  colorEl.textContent = c.color  || ""; colorEl.classList.toggle("hidden", !c.color);
  modelEl.textContent = c.modelo || ""; modelEl.classList.toggle("hidden", !c.modelo);

  const etaEl = document.getElementById("offer-eta");
  etaEl.textContent = c.eta_seconds != null
    ? `Llega en ~${Math.max(1, Math.round(c.eta_seconds / 60))} min`
    : "";

  const photo = document.getElementById("offer-photo");
  if (c.foto) { photo.src = c.foto; photo.classList.remove("hidden"); }
  else { photo.classList.add("hidden"); photo.removeAttribute("src"); }

  document.getElementById("offer-card").classList.remove("hidden");

  // Barra de tiempo (15 s)
  const timeoutS = offer.timeout_s || 15;
  const bar = document.getElementById("offer-timer-bar");
  bar.style.transition = "none";
  bar.style.width = "100%";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${timeoutS}s linear`;
    bar.style.width = "0%";
  }));

  clearTimeout(_offerTimer);
  _offerTimer = setTimeout(() => {
    hideOfferCard();
    showNextOffer();
  }, timeoutS * 1000);
}

function hideOfferCard() {
  clearTimeout(_offerTimer); _offerTimer = null;
  _currentOffer = null;
  document.getElementById("offer-card").classList.add("hidden");
}

function clearOffers() {
  _offerQueue = [];
  hideOfferCard();
}

function acceptOffer() {
  if (!_currentOffer) return;
  sendWS({
    type: "offer_accept",
    request_id: _currentOffer.request_id,
    conductor_session_id: _currentOffer.conductor_session_id,
  });
  hideOfferCard();
  // Las demás ofertas las descarta el servidor (offer_declined a cada conductor)
  _offerQueue = [];
}

function rejectOffer() {
  if (!_currentOffer) return;
  sendWS({
    type: "offer_reject",
    request_id: _currentOffer.request_id,
    conductor_session_id: _currentOffer.conductor_session_id,
  });
  hideOfferCard();
  showNextOffer();
}

function onTripAccepted(msg) {
  activeRequestId   = null;
  activeTripId      = msg.trip_id;
  activeConductorId = msg.conductor_session_id || null;

  clearOffers();
  document.getElementById("waiting-overlay").classList.add("hidden");

  const c = msg.conductor || {};

  // Mostrar el marker del conductor asignado de inmediato (estaba retenido en pending)
  if (activeConductorId && _pendingConductors[activeConductorId]) {
    addOrUpdateMarker(_pendingConductors[activeConductorId]);
    delete _pendingConductors[activeConductorId];
  } else if (activeConductorId && c.lat && c.lng) {
    addOrUpdateMarker({
      id: activeConductorId, lat: c.lat, lng: c.lng, role: "conductor",
      name: c.name || "Conductor", connected_at: Date.now() / 1000,
      zone_destination: c.zone || null, rating_avg: c.rating || null,
    });
  }

  // Foto de perfil del conductor
  const tripPhoto = document.getElementById("trip-conductor-photo");
  if (c.foto) { tripPhoto.src = c.foto; tripPhoto.classList.remove("hidden"); }
  else { tripPhoto.classList.add("hidden"); tripPhoto.removeAttribute("src"); }

  // Conductor info
  document.getElementById("trip-conductor-name").textContent = c.name || "Conductor";
  document.getElementById("trip-conductor-stars").innerHTML  =
    (c.rating != null && c.rating_count)
      ? renderStarRow(c.rating, c.rating_count, "0.78rem")
      : (c.rating != null ? `<span style="font-size:0.78rem;color:#f59e0b">★ ${c.rating}</span>` : "");

  // Vehicle pills
  const plateEl = document.getElementById("trip-vehicle-plate");
  const colorEl = document.getElementById("trip-vehicle-color");
  const modelEl = document.getElementById("trip-vehicle-model");
  plateEl.textContent = c.placa  || ""; plateEl.classList.toggle("hidden", !c.placa);
  colorEl.textContent = c.color  || ""; colorEl.classList.toggle("hidden", !c.color);
  modelEl.textContent = c.modelo || ""; modelEl.classList.toggle("hidden", !c.modelo);

  // Zone
  document.getElementById("trip-zone-row").textContent = c.zone ? `Destino: ${c.zone}` : "";

  // ETA
  const etaBadge = document.getElementById("trip-eta-badge");
  if (c.eta_seconds != null) {
    const mins = Math.max(1, Math.round(c.eta_seconds / 60));
    etaBadge.textContent = `~${mins} min`;
    etaBadge.classList.remove("hidden");
  } else {
    etaBadge.classList.add("hidden");
  }

  // Cancel button visible (student not yet boarded)
  document.getElementById("btn-cancel-active-trip").classList.remove("hidden");

  document.getElementById("trip-bottom-sheet").classList.remove("hidden");
  if (c.lat && c.lng) map.flyTo([c.lat, c.lng], 16, { animate: true, duration: 1 });
  else if (lastLat) map.flyTo([lastLat, lastLng], 16, { animate: true, duration: 1 });
}

function onTripRejected(msg) {
  activeRequestId = null;
  studentLocationEnabled = false;
  resetStudentUI();
  if (msg.reason === "no_conductors") {
    showToast("No hay conductores disponibles en este momento.");
  }
}

function onTripAcceptConfirmed(msg) {
  _pendingBoardingTrip = { trip_id: msg.trip_id, studentName: msg.student_name };
  document.getElementById("accepted-student-name").textContent = msg.student_name;
  document.getElementById("conductor-accepted-trip").classList.remove("hidden");
}

function markOnboardPending() {
  if (!_pendingBoardingTrip) return;
  const { trip_id, studentName } = _pendingBoardingTrip;
  sendWS({ type: "passenger_onboard", trip_id: trip_id });
  addPassengerToPanel(trip_id, studentName);
  addManual();
  document.getElementById("conductor-accepted-trip").classList.add("hidden");
  _pendingBoardingTrip = null;
  showToast("Verificando abordaje por GPS (20 s)…");
}

function cancelActiveTrip() {
  sendWS({ type: "trip_cancel_active" });
  if (currentUser && currentUser.role === "estudiante") {
    activeTripId = null;
    studentLocationEnabled = false;
    if (activeConductorId) { removeMarker(activeConductorId); activeConductorId = null; }
    document.getElementById("trip-bottom-sheet").classList.add("hidden");
    document.getElementById("student-actions").classList.remove("hidden");
    if (lastLat) map.flyTo([lastLat, lastLng], 15, { animate: true, duration: 1.2 });
  }
  if (currentUser && currentUser.role === "conductor") {
    _pendingBoardingTrip = null;
    document.getElementById("conductor-accepted-trip").classList.add("hidden");
  }
}

function onTripCancelledActive(msg) {
  activeTripId = null;
  if (currentUser && currentUser.role === "estudiante") {
    studentLocationEnabled = false;
    if (activeConductorId) { removeMarker(activeConductorId); activeConductorId = null; }
    document.getElementById("trip-bottom-sheet").classList.add("hidden");
    document.getElementById("student-actions").classList.remove("hidden");
    if (lastLat) map.flyTo([lastLat, lastLng], 15, { animate: true, duration: 1.2 });
    showToast("El conductor canceló el viaje.");
  }
  if (currentUser && currentUser.role === "conductor") {
    _pendingBoardingTrip = null;
    document.getElementById("conductor-accepted-trip").classList.add("hidden");
    showToast("El estudiante canceló el viaje.");
  }
}

function showNearby() {
  showingNearby = true;
  Object.values(_pendingConductors).forEach(u => addOrUpdateMarker(u));
  showToast("Mostrando conductores cercanos.");
}

// ── Trip — conductor ───────────────────────────────────────────────────────

let _pendingRequestId = null;
let _requestTimerBar  = null;

function showRequestModal(msg) {
  _pendingRequestId = msg.request_id;

  document.getElementById("request-student-name").textContent = msg.student?.name || "Estudiante";
  document.getElementById("request-distance").textContent     = msg.distance_m ? `A ${Math.round(msg.distance_m)} m` : "";
  document.getElementById("request-zone").textContent         = msg.zone_destination ? `Destino: ${msg.zone_destination}` : "";

  const addrEl = document.getElementById("request-address");
  addrEl.textContent = "Obteniendo dirección...";
  if (msg.student?.lat && msg.student?.lng) {
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${msg.student.lat}&lon=${msg.student.lng}&zoom=17&accept-language=es`)
      .then(r => r.json())
      .then(data => {
        const a = data.address || {};
        const parts = [a.road, a.neighbourhood || a.suburb || a.village || a.town].filter(Boolean);
        addrEl.textContent = parts.length ? parts.join(", ") : (data.display_name?.split(",")[0] || "");
      })
      .catch(() => { addrEl.textContent = ""; });
  } else {
    addrEl.textContent = "";
  }

  document.getElementById("request-modal").classList.remove("hidden");

  // Animate timer bar
  const bar = document.getElementById("request-timer-bar");
  bar.style.transition = "none";
  bar.style.width      = "100%";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${REQUEST_TIMEOUT_S}s linear`;
    bar.style.width      = "0%";
  }));

  // Auto-close after timeout
  clearTimeout(_requestTimerBar);
  _requestTimerBar = setTimeout(closeRequestModal, REQUEST_TIMEOUT_S * 1000);
}

function acceptRequest() {
  if (!_pendingRequestId) return;
  sendWS({ type: "trip_accept", request_id: _pendingRequestId });
  closeRequestModal();
  // panel entry added in onTripAcceptConfirmed → markOnboardPending
}

function addPassengerToPanel(tripId, name) {
  const list = document.getElementById("passengers-list");
  const empty = list.querySelector(".passengers-empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "passenger-item";
  item.id = `passenger-${tripId}`;
  item.innerHTML = `
    <div class="passenger-name">${name}</div>
    <div class="passenger-btns">
      <button class="btn-paction dropoff" onclick="markDropoff(${tripId}, 0)">Dejó</button>
    </div>`;
  list.appendChild(item);
}

function refreshPassengersEmpty() {
  const list = document.getElementById("passengers-list");
  if (!list) return;
  if (!list.querySelector(".passenger-item")) {
    if (!list.querySelector(".passengers-empty")) {
      list.innerHTML = '<div class="passengers-empty">Sin pasajeros a bordo</div>';
    }
  }
}

function rejectRequest() {
  if (!_pendingRequestId) return;
  sendWS({ type: "trip_reject", request_id: _pendingRequestId });
  closeRequestModal();
}

function closeRequestModal() {
  clearTimeout(_requestTimerBar);
  _pendingRequestId = null;
  document.getElementById("request-modal").classList.add("hidden");
}

function markOnboard(tripId) {
  sendWS({ type: "passenger_onboard", trip_id: tripId });
  showToast("Verificando abordaje por GPS (20 s)…");
}

function markDropoff(tripId, studentDbId) {
  sendWS({ type: "passenger_dropoff", trip_id: tripId, student_db_id: studentDbId });
  const item = document.getElementById(`passenger-${tripId}`);
  if (item) item.remove();
  removeManual();
  refreshPassengersEmpty();
}

function sendQuickMsg(tripId, key) {
  sendWS({ type: "quick_message", trip_id: tripId, message_key: key });
}

// ── Zone select ────────────────────────────────────────────────────────────

function populateZoneSelect(zones) {
  availableZones = zones;
  ["zone-select", "student-zone-select"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    zones.forEach(z => {
      const opt = document.createElement("option");
      opt.value = z; opt.textContent = z;
      sel.appendChild(opt);
    });
  });
}

function setZone(zone) {
  currentZone = zone;
  sendWS({ type: "zone_set", zone });
}

// ── Rating modal ───────────────────────────────────────────────────────────

let _selectedRating = 0;

function showRatingModal(msg) {
  pendingRatingTrip = msg;
  _selectedRating   = 0;
  document.getElementById("rating-conductor-name").textContent = `Conductor: ${msg.conductor_name}`;
  document.querySelectorAll(".star").forEach(s => s.classList.remove("active"));
  document.getElementById("rating-msg").className = "form-msg hidden";
  document.getElementById("rating-modal").classList.remove("hidden");
}

function selectStar(val) {
  _selectedRating = val;
  document.querySelectorAll(".star").forEach(s =>
    s.classList.toggle("active", parseInt(s.dataset.v) <= val));
}

async function submitRating() {
  if (!_selectedRating || !pendingRatingTrip) return;
  const msgEl = document.getElementById("rating-msg");
  try {
    const res = await fetch(`/trips/${pendingRatingTrip.trip_id}/rate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify({ rating: _selectedRating }),
    });
    if (!res.ok) throw new Error("Error al calificar");
    document.getElementById("rating-modal").classList.add("hidden");
    pendingRatingTrip = null;
  } catch (err) {
    msgEl.className = "form-msg error"; msgEl.textContent = err.message;
  }
}

function skipRating() {
  document.getElementById("rating-modal").classList.add("hidden");
  pendingRatingTrip = null;
}

// ── Status & counter ───────────────────────────────────────────────────────

function cycleStatus() {
  const idx = STATUS_CYCLE.indexOf(myStatus);
  myStatus  = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
  updateStatusButton();
  if (lastLat !== null) sendLocation(lastLat, lastLng);
}

function updateStatusButton() {
  const btn = document.getElementById("btn-status");
  btn.textContent = STATUS_LABELS[myStatus];
  btn.className   = "";
  btn.id          = "btn-status";
  btn.classList.add(myStatus === "en camino" ? "en-camino" : myStatus);
}

function addManual() {
  if (manualPassengers < MAX_PASSENGERS) {
    manualPassengers++;
    updateCounterDisplay(manualPassengers);
    if (lastLat !== null) sendLocation(lastLat, lastLng);
  }
}

function removeManual() {
  const appOnboard = document.querySelectorAll("#passengers-list .passenger-item").length;
  if (manualPassengers > appOnboard) {
    manualPassengers--;
    updateCounterDisplay(manualPassengers);
    if (lastLat !== null) sendLocation(lastLat, lastLng);
  }
}

function updateCounterDisplay(total) {
  const el = document.getElementById("counter-display");
  el.textContent = total + "/" + MAX_PASSENGERS;
  el.className   = total >= MAX_PASSENGERS ? "full" : "";
}

// ── Markers ────────────────────────────────────────────────────────────────

function markerColor(user) {
  if (user.role === "estudiante") return "#0ea5e9";
  if (user.status === "lleno")    return "#ef4444";
  return "#22c55e";
}

function buildIcon(user, isMe) {
  if (user.role === "conductor") {
    const isMyDriver = activeConductorId && user.id === activeConductorId;
    const size  = isMe ? 44 : isMyDriver ? 40 : 32;
    const color = isMyDriver ? "#f59e0b" : markerColor(user);
    const pulse = isMyDriver
      ? `box-shadow:0 0 0 6px rgba(245,158,11,0.25),0 0 0 12px rgba(245,158,11,0.1);border-radius:50%;padding:2px;`
      : "";
    return L.divIcon({
      className: "",
      html: `<div style="position:relative;width:${size}px;height:${size}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));${pulse}">
        <svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${color}">
          <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>
        </svg>
      </div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
  }
  const color = markerColor(user);
  const size  = isMe ? 26 : 18;
  const ring  = isMe
    ? "box-shadow:0 0 0 4px rgba(255,255,255,0.2),0 2px 8px rgba(0,0,0,0.5);"
    : "box-shadow:0 2px 6px rgba(0,0,0,0.4);";
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:3px solid #fff;${ring}"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
}

function buildPopup(user) {
  const isMe    = user.id === myId;
  const elapsed = elapsedTime(user.connected_at);
  let statusHtml = "";
  if (user.role === "conductor" && user.status) {
    const cls = user.status === "en camino" ? "en-camino" : user.status;
    statusHtml = `<div class="popup-status ${cls}">${STATUS_LABELS[user.status]}</div>`;
  }
  const zoneHtml = user.zone_destination
    ? `<div class="popup-info">Destino: ${user.zone_destination}</div>` : "";
  const ratingHtml = user.role === "conductor" && user.rating_avg != null
    ? `<div class="popup-info">★ ${user.rating_avg}</div>` : "";
  const passengerHtml = user.role === "conductor"
    ? `<div class="popup-info">${user.onboard_count || 0}/${MAX_PASSENGERS} pasajeros</div>` : "";
  const timeHtml = user.role === "estudiante"
    ? `<div class="popup-info">Esperando ${elapsed}</div>`
    : `<div class="popup-info">Activo hace ${elapsed}</div>`;
  return `<div class="popup-name">${user.name}${isMe ? " (tú)" : ""}</div>${timeHtml}${zoneHtml}${ratingHtml}${passengerHtml}${statusHtml}`;
}

function elapsedTime(ts) {
  const secs = Math.floor(Date.now() / 1000 - ts);
  if (secs < 60) return secs + " seg";
  const mins = Math.floor(secs / 60);
  return mins < 60 ? mins + " min" : Math.floor(mins / 60) + " h";
}

function addOrUpdateMarker(user) {
  const isMe = user.id === myId;
  if (isMe && _myMarker) { _myMarker.remove(); _myMarker = null; }
  const isStudent = currentUser && currentUser.role === "estudiante";
  // Un estudiante nunca debe ver a otro estudiante (defensa extra al filtro del servidor)
  if (isStudent && user.role === "estudiante" && !isMe) return;
  // El conductor asignado a mi viaje SIEMPRE se muestra (para saber cuándo llega)
  const isMyDriver = activeConductorId && user.id === activeConductorId;
  if (isStudent && !showingNearby && user.role === "conductor" && !isMyDriver) {
    _pendingConductors[user.id] = user;
    return;
  }
  if (markers[user.id]) {
    markers[user.id].setLatLng([user.lat, user.lng]);
    markers[user.id].setIcon(buildIcon(user, isMe));
    markers[user.id].setPopupContent(buildPopup(user));
    markers[user.id]._userData = user;
  } else {
    const m = L.marker([user.lat, user.lng], { icon: buildIcon(user, isMe) })
      .addTo(map).bindPopup(buildPopup(user));
    m._userData = user;
    markers[user.id] = m;
  }
  refreshClusters();
}

function removeMarker(id) {
  if (markers[id]) { markers[id].remove(); delete markers[id]; }
  delete _pendingConductors[id];
  refreshClusters();
}

// ── Clustering ─────────────────────────────────────────────────────────────

function haversineJS(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function refreshClusters() {
  if (!map) return;
  const students = Object.values(markers).map(m => m._userData).filter(u => u && u.role === "estudiante");
  const visited = new Set(), groups = [];
  for (const u of students) {
    if (visited.has(u.id)) continue;
    const group = [u]; visited.add(u.id);
    for (const v of students) {
      if (visited.has(v.id)) continue;
      if (haversineJS(u.lat, u.lng, v.lat, v.lng) <= CLUSTER_RADIUS_M) { group.push(v); visited.add(v.id); }
    }
    groups.push(group);
  }
  Object.values(clusterMarkers).forEach(m => m.remove());
  Object.keys(clusterMarkers).forEach(k => delete clusterMarkers[k]);
  const inCluster = new Set();
  for (const group of groups) {
    if (group.length < 2) continue;
    group.forEach(u => { inCluster.add(u.id); if (markers[u.id]) markers[u.id].setOpacity(0); });
    const cLat = group.reduce((s, u) => s + u.lat, 0) / group.length;
    const cLng = group.reduce((s, u) => s + u.lng, 0) / group.length;
    const count = group.length;
    const key   = group.map(u => u.id).sort().join("-");
    const sz    = Math.min(14 + count * 8, 48);
    const icon  = L.divIcon({
      className: "",
      html: `<div style="background:#0ea5e9;width:${sz}px;height:${sz}px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:800;color:#fff">${count}</div>`,
      iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
    });
    const names = group.map(u => u.name).join(", ");
    clusterMarkers[key] = L.marker([cLat, cLng], { icon }).addTo(map)
      .bindPopup(`<div class="popup-name">${count} estudiantes</div><div class="popup-info">${names}</div>`);
  }
  students.forEach(u => { if (!inCluster.has(u.id) && markers[u.id]) markers[u.id].setOpacity(1); });
}

// ── Toast ──────────────────────────────────────────────────────────────────

function showToast(msg) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className   = "toast show";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.className = "toast", 3500);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function setLoading(btn, loading) {
  btn.disabled = loading;
  if (loading) { btn._orig = btn.textContent; btn.innerHTML = '<span class="spinner"></span>'; }
  else { btn.textContent = btn._orig || btn.textContent; }
}

// ── Drawer ─────────────────────────────────────────────────────────────────

function openDrawer() {
  if (!currentUser) return;

  document.getElementById("dr-name-text").textContent  = currentUser.name;
  document.getElementById("dr-role-badge").textContent =
    currentUser.role === "conductor" ? "Conductor" : "Estudiante";
  document.getElementById("dr-stars").innerHTML = renderStarRow(
    currentUser.rating_avg, currentUser.rating_count, "0.82rem"
  );

  // Botón "Quiero ser conductor" solo para estudiantes
  const becomeSection = document.getElementById("dr-become-conductor");
  if (currentUser.role === "estudiante") {
    becomeSection.classList.remove("hidden");
  } else {
    becomeSection.classList.add("hidden");
  }

  const condSection = document.getElementById("dr-conductor");
  if (currentUser.role === "conductor") {
    condSection.classList.remove("hidden");
    const map = {
      pending:  { text: "Pendiente de revisión", cls: "pending"  },
      approved: { text: "Cuenta verificada ✓",   cls: "approved" },
      rejected: { text: "Verificación rechazada", cls: "rejected" },
    };
    const s = map[currentUser.conductor_status] || map.pending;
    document.getElementById("dr-verify-row").innerHTML =
      `<span class="verify-badge ${s.cls}">${s.text}</span>`;
  } else {
    condSection.classList.add("hidden");
  }

  const overlay = document.getElementById("drawer-overlay");
  const drawer  = document.getElementById("drawer");
  overlay.classList.remove("hidden");
  drawer.classList.remove("hidden");
  requestAnimationFrame(() => requestAnimationFrame(() => drawer.classList.add("open")));
}

function closeDrawer() {
  const drawer  = document.getElementById("drawer");
  const overlay = document.getElementById("drawer-overlay");
  if (!drawer || drawer.classList.contains("hidden")) return;
  drawer.classList.remove("open");
  setTimeout(() => {
    drawer.classList.add("hidden");
    overlay.classList.add("hidden");
  }, 290);
}

// ── Stars renderer ─────────────────────────────────────────────────────────

function renderStarRow(avg, count, size = "0.7rem") {
  if (avg == null || !count) {
    return `<span class="no-rating" style="font-size:${size}">Sin calificaciones</span>`;
  }
  const full = Math.floor(avg);
  const half = (avg - full) >= 0.5;
  let html = `<span class="stars-inline" style="font-size:${size}">`;
  for (let i = 1; i <= 5; i++) {
    if (i <= full) html += '<span class="si active">★</span>';
    else if (i === full + 1 && half) html += '<span class="si half">★</span>';
    else html += '<span class="si">★</span>';
  }
  html += `</span><span class="rating-num" style="font-size:${size}">${avg} (${count})</span>`;
  return html;
}

// ── Delete account ─────────────────────────────────────────────────────────

function confirmDelete() {
  if (!window.confirm("¿Eliminar tu cuenta? Esta acción es irreversible.")) return;
  fetch("/me", { method: "DELETE", credentials: "include" })
    .then(r => { if (r.ok) logout(); else showToast("Error al eliminar la cuenta."); })
    .catch(() => showToast("Error de red."));
}

function setStatus(state, text) {
  document.getElementById("status-dot").className = `dot ${state}`;
  document.getElementById("status-text").textContent = text;
}

function cleanup() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  if (ws) ws.close();
  clearTimeout(_requestTimerBar); _requestTimerBar = null;
  Object.values(markers).forEach(m => m.remove());
  Object.keys(markers).forEach(k => delete markers[k]);
  Object.values(clusterMarkers).forEach(m => m.remove());
  Object.keys(clusterMarkers).forEach(k => delete clusterMarkers[k]);
  myId = null; myDbId = null; lastLat = null; lastLng = null;
  manualPassengers = 0; activeRequestId = null; activeTripId = null;
  pendingRatingTrip = null; _pendingRequestId = null;
  currentZone = ""; showingNearby = false; studentLocationEnabled = false;
  _pendingBoardingTrip = null;
  if (_myMarker) { _myMarker.remove(); _myMarker = null; }
  Object.keys(_pendingConductors).forEach(k => delete _pendingConductors[k]);
  document.getElementById("tb-saldo")?.classList.add("hidden");
  clearOffers();
  document.getElementById("offer-waiting-banner")?.classList.add("hidden");
  startBgPoll();
}

function openEditModal() {
  document.getElementById("edit-name").value = currentUser.name || "";
  document.getElementById("edit-msg").classList.add("hidden");
  document.getElementById("edit-modal").classList.remove("hidden");
}

function closeEditModal() {
  document.getElementById("edit-modal").classList.add("hidden");
}

async function saveProfile(e) {
  e.preventDefault();
  const name = document.getElementById("edit-name").value.trim();
  const msg  = document.getElementById("edit-msg");
  if (!name || name === currentUser.name) {
    msg.textContent = "Ingresa un nombre diferente.";
    msg.style.color = "#94a3b8";
    msg.classList.remove("hidden");
    return;
  }
  const r = await fetch("/me", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (r.ok) {
    const updated = await r.json();
    currentUser = updated;
    document.getElementById("tb-name").textContent      = updated.name;
    document.getElementById("dr-name-text").textContent = updated.name;
    msg.textContent = "¡Guardado!";
    msg.style.color = "#22c55e";
    msg.classList.remove("hidden");
    setTimeout(() => closeEditModal(), 1200);
  } else {
    const err = await r.json().catch(() => ({}));
    msg.textContent = err.detail || "Error al guardar.";
    msg.style.color = "#ef4444";
    msg.classList.remove("hidden");
  }
}

function openPasswordModal() {
  document.getElementById("pw-old").value = "";
  document.getElementById("pw-new").value = "";
  document.getElementById("pw-confirm").value = "";
  document.getElementById("pw-msg").classList.add("hidden");
  document.getElementById("change-password-modal").classList.remove("hidden");
}

function closePasswordModal() {
  document.getElementById("change-password-modal").classList.add("hidden");
}

async function savePassword(e) {
  e.preventDefault();
  const oldPw   = document.getElementById("pw-old").value;
  const newPw   = document.getElementById("pw-new").value;
  const confirm = document.getElementById("pw-confirm").value;
  const msg     = document.getElementById("pw-msg");
  if (newPw !== confirm) {
    msg.textContent = "Las contraseñas nuevas no coinciden.";
    msg.style.color = "#ef4444";
    msg.classList.remove("hidden");
    return;
  }
  const r = await fetch("/me", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: newPw, old_password: oldPw }),
  });
  if (r.ok) {
    msg.textContent = "¡Contraseña actualizada!";
    msg.style.color = "#22c55e";
    msg.classList.remove("hidden");
    setTimeout(() => closePasswordModal(), 1400);
  } else {
    const err = await r.json().catch(() => ({}));
    msg.textContent = err.detail || "Error al guardar.";
    msg.style.color = "#ef4444";
    msg.classList.remove("hidden");
  }
}

// ── Bottom sheet drag ──────────────────────────────────────────────────────

function _initSheetDrag(handle) {
  let startY = 0, curY = 0, dragging = false;
  const sheet = handle.closest(".trip-sheet");
  const bs    = handle.closest("#trip-bottom-sheet");

  function start(clientY) {
    startY = clientY; curY = 0; dragging = true;
    sheet.style.transition = "none";
  }
  function move(clientY) {
    if (!dragging) return;
    curY = Math.max(0, clientY - startY);
    sheet.style.transform = `translateY(${curY}px)`;
  }
  function end() {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = "transform 0.28s cubic-bezier(0.22,1,0.36,1)";
    if (curY > 110) {
      sheet.style.transform = "translateY(110%)";
      setTimeout(() => { sheet.style.transform = ""; bs.classList.add("hidden"); }, 290);
    } else {
      sheet.style.transform = "";
    }
  }

  handle.addEventListener("touchstart",  e => { e.preventDefault(); start(e.touches[0].clientY); },  { passive: false });
  handle.addEventListener("touchmove",   e => { e.preventDefault(); move(e.touches[0].clientY); },   { passive: false });
  handle.addEventListener("touchend",    () => end());
  handle.addEventListener("mousedown",   e => start(e.clientY));
  document.addEventListener("mousemove", e => { if (dragging) move(e.clientY); });
  document.addEventListener("mouseup",   () => end());
}

// Attach drag when the sheet becomes visible
const _sheetObserver = new MutationObserver(() => {
  const handle = document.querySelector("#trip-bottom-sheet:not(.hidden) .trip-sheet-handle");
  if (handle && !handle._dragInit) { handle._dragInit = true; _initSheetDrag(handle); }
});
_sheetObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });