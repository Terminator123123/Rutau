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
let activeRequestId  = null;
let activeTripId     = null;
let pendingRatingTrip = null;
let requestTimerInterval = null;

// Map state
let showingNearby = false;
const markers        = {};
const clusterMarkers = {};
let _bgMarkers = {};
let _bgPollTimer = null;

// ── Cookie ─────────────────────────────────────────────────────────────────

function readSessionCookie() {
  const match = document.cookie.split("; ").find(r => r.startsWith("cu_info="));
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match.split("=")[1])); } catch (_) { return null; }
}

// ── Init ───────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  initMap();
  startBgPoll();
  const params = new URLSearchParams(location.search);
  if (params.get("verified") === "1") showVerifiedBanner();
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

function showVerifiedBanner() {
  const msg = document.getElementById("login-error");
  if (msg) {
    msg.className = "form-msg success";
    msg.textContent = "¡Correo verificado! Ya puedes iniciar sesión.";
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

// ── Document upload (conductor pending) ────────────────────────────────────

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
      document.getElementById("btn-status").classList.remove("hidden");
      document.getElementById("passenger-counter").classList.remove("hidden");
      document.getElementById("passengers-panel").classList.remove("hidden");
      updateStatusButton();
      updateCounterDisplay(0);
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
  document.getElementById("btn-status").classList.add("hidden");
  document.getElementById("passenger-counter").classList.add("hidden");
  document.getElementById("passengers-panel").classList.add("hidden");
  document.getElementById("student-actions").classList.add("hidden");
  document.getElementById("waiting-overlay").classList.add("hidden");
  document.getElementById("conductor-approaching").classList.add("hidden");
  document.getElementById("zone-select").classList.add("hidden");
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
    pos => { connectWS(pos.coords.latitude, pos.coords.longitude); startWatching(); },
    ()  => setStatus("error", "Permiso de ubicacion denegado"),
    { enableHighAccuracy: true }
  );
}

function startWatching() {
  watchId = navigator.geolocation.watchPosition(
    pos => { if (ws && ws.readyState === WebSocket.OPEN) sendLocation(pos.coords.latitude, pos.coords.longitude); },
    ()   => {},
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connectWS(lat, lng) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen    = () => { setStatus("connected", "En vivo"); sendLocation(lat, lng); };
  ws.onmessage = e  => handleMessage(JSON.parse(e.data));
  ws.onclose   = e  => {
    if (e.code === 4001 || e.code === 4003) { logout(); return; }
    setStatus("connecting", "Reconectando...");
  };
  ws.onerror = () => setStatus("error", "Error de conexion");
}

function sendLocation(lat, lng) {
  lastLat = lat; lastLng = lng;
  if (ws && ws.readyState === WebSocket.OPEN) {
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

    case "trip_accepted":
      onTripAccepted(msg);
      break;

    case "trip_rejected":
      onTripRejected(msg);
      break;

    case "trip_cancelled":
      closeRequestModal();
      break;

    case "onboard_confirmed":
      activeTripId = msg.trip_id;
      showToast("¡A bordo! Buen viaje.");
      break;

    case "dropoff_confirmed":
      activeTripId = null;
      document.getElementById("conductor-approaching").classList.add("hidden");
      break;

    case "rate_prompt":
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
  if (activeRequestId) return;

  document.getElementById("student-actions").classList.add("hidden");
  document.getElementById("waiting-overlay").classList.remove("hidden");

  sendWS({ type: "trip_request", zone_destination: "" });

  // Zoom out animation while waiting
  map.flyTo([lastLat, lastLng], 13, { animate: true, duration: REQUEST_TIMEOUT_S });
}

function cancelRide() {
  sendWS({ type: "trip_cancel" });
  activeRequestId = null;
  resetStudentUI();
}

function resetStudentUI() {
  document.getElementById("waiting-overlay").classList.add("hidden");
  document.getElementById("conductor-approaching").classList.add("hidden");
  document.getElementById("student-actions").classList.remove("hidden");
  if (lastLat) map.flyTo([lastLat, lastLng], 15, { animate: true, duration: 1.2 });
}

function onTripAccepted(msg) {
  activeRequestId = null;
  activeTripId    = msg.trip_id;

  document.getElementById("waiting-overlay").classList.add("hidden");
  document.getElementById("conductor-approaching").classList.remove("hidden");

  const nameEl = document.getElementById("approaching-name");
  const zoneEl = document.getElementById("approaching-zone");
  nameEl.textContent = msg.conductor?.name || "Conductor";
  zoneEl.textContent = msg.conductor?.zone ? `Destino: ${msg.conductor.zone}` : "";

  // Zoom back to user position
  if (lastLat) map.flyTo([lastLat, lastLng], 16, { animate: true, duration: 1 });
}

function onTripRejected(msg) {
  activeRequestId = null;
  resetStudentUI();
  if (msg.reason === "no_conductors") {
    showToast("No hay conductores disponibles en este momento.");
  }
}

function showNearby() {
  showingNearby = true;
  showToast("Mostrando conductores cercanos. No apareces en el mapa.");
  // Conductors are already shown via the normal WS broadcast
}

// ── Trip — conductor ───────────────────────────────────────────────────────

let _pendingRequestId = null;
let _requestTimerBar  = null;

function showRequestModal(msg) {
  _pendingRequestId = msg.request_id;

  document.getElementById("request-student-name").textContent = msg.student?.name || "Estudiante";
  document.getElementById("request-distance").textContent     = msg.distance_m ? `A ${Math.round(msg.distance_m)} m` : "";
  document.getElementById("request-zone").textContent         = msg.zone_destination ? `Destino: ${msg.zone_destination}` : "";

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
}

function markDropoff(tripId, studentDbId) {
  sendWS({ type: "passenger_dropoff", trip_id: tripId, student_db_id: studentDbId });
  const item = document.getElementById(`passenger-${tripId}`);
  if (item) item.remove();
}

function sendQuickMsg(tripId, key) {
  sendWS({ type: "quick_message", trip_id: tripId, message_key: key });
}

// ── Zone select ────────────────────────────────────────────────────────────

function populateZoneSelect(zones) {
  availableZones = zones;
  const sel = document.getElementById("zone-select");
  zones.forEach(z => {
    const opt = document.createElement("option");
    opt.value = z; opt.textContent = z;
    sel.appendChild(opt);
  });
  if (currentUser?.role === "conductor" && currentUser?.conductor_status === "approved") {
    sel.classList.remove("hidden");
  }
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
  if (manualPassengers < MAX_PASSENGERS) { manualPassengers++; if (lastLat !== null) sendLocation(lastLat, lastLng); }
}

function removeManual() {
  if (manualPassengers > 0) { manualPassengers--; if (lastLat !== null) sendLocation(lastLat, lastLng); }
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
    const size  = isMe ? 44 : 32;
    const color = markerColor(user);
    return L.divIcon({
      className: "",
      html: `<div style="position:relative;width:${size}px;height:${size}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35))">
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

  document.getElementById("dr-name").textContent      = currentUser.name;
  document.getElementById("dr-role-badge").textContent =
    currentUser.role === "conductor" ? "Conductor" : "Estudiante";
  document.getElementById("dr-stars").innerHTML = renderStarRow(
    currentUser.rating_avg, currentUser.rating_count, "0.82rem"
  );

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
  Object.values(markers).forEach(m => m.remove());
  Object.keys(markers).forEach(k => delete markers[k]);
  Object.values(clusterMarkers).forEach(m => m.remove());
  Object.keys(clusterMarkers).forEach(k => delete clusterMarkers[k]);
  myId = null; myDbId = null; lastLat = null; lastLng = null;
  manualPassengers = 0; activeRequestId = null; activeTripId = null;
  currentZone = ""; showingNearby = false;
}
