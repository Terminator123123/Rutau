const UNIGUAJIRA_COORDS = [11.5392, -72.9066];
const MAX_PASSENGERS = 4;
const CLUSTER_RADIUS_M = 30;

const STATUS_CYCLE = ["disponible", "lleno", "en camino"];
const STATUS_LABELS = { disponible: "Disponible", lleno: "Lleno", "en camino": "En camino" };

let map, ws, myStatus, watchId;
let myId = null;
let manualPassengers = 0;
let lastLat = null, lastLng = null;
let currentUser = null;
const markers = {};
const clusterMarkers = {};

// Marcadores de usuarios visibles antes del login (fondo)
let _bgMarkers = {};
let _bgPollTimer = null;

// ── Cookie de sesión ───────────────────────────────────────────────────────

function readSessionCookie() {
  const match = document.cookie.split("; ").find(r => r.startsWith("cu_info="));
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match.split("=")[1])); } catch (_) { return null; }
}

// ── Init ───────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  // Inicializar el mapa inmediatamente (se ve de fondo mientras no hay sesión)
  initMap();
  // Mostrar usuarios reales conectados en el fondo
  startBgPoll();

  const params = new URLSearchParams(location.search);
  if (params.get("verified") === "1") showVerifiedBanner();

  const saved = readSessionCookie();
  if (saved) {
    currentUser = saved;
    startMap();
  }
});

function showVerifiedBanner() {
  const msg = document.getElementById("login-error");
  if (msg) {
    msg.className = "form-msg success";
    msg.textContent = "¡Correo verificado! Ya puedes iniciar sesión.";
  }
}

// ── Polling de usuarios en el fondo (antes del login) ─────────────────────

function startBgPoll() {
  pollBgUsers();
  _bgPollTimer = setInterval(pollBgUsers, 6000);
}

function stopBgPoll() {
  clearInterval(_bgPollTimer);
  _bgPollTimer = null;
  Object.values(_bgMarkers).forEach(m => m.remove());
  _bgMarkers = {};
}

function pollBgUsers() {
  fetch("/usuarios/activos")
    .then(r => r.json())
    .then(data => {
      const activeIds = new Set((data.usuarios || []).map(u => u.id));
      Object.keys(_bgMarkers).forEach(id => {
        if (!activeIds.has(id)) { _bgMarkers[id].remove(); delete _bgMarkers[id]; }
      });
      (data.usuarios || []).forEach(u => {
        if (!u.lat || !u.lng) return;
        const icon = buildIcon(u, false);
        if (_bgMarkers[u.id]) {
          _bgMarkers[u.id].setLatLng([u.lat, u.lng]).setIcon(icon);
        } else {
          _bgMarkers[u.id] = L.marker([u.lat, u.lng], { icon }).addTo(map);
        }
      });
    })
    .catch(() => {});
}

// ── Auth tabs ──────────────────────────────────────────────────────────────

function showTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("login-form").classList.toggle("hidden", !isLogin);
  document.getElementById("register-form").classList.toggle("hidden", isLogin);
  document.querySelectorAll(".tab").forEach((t, i) => {
    t.classList.toggle("active", isLogin ? i === 0 : i === 1);
  });
  ["login-error", "register-msg"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = "form-msg hidden";
    el.textContent = "";
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
  if (!email) {
    errEl.className = "form-msg error";
    errEl.textContent = "Ingresa tu correo primero.";
    return;
  }
  errEl.className = "form-msg hidden";
  fetch("/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  }).then(() => {
    errEl.className = "form-msg success";
    errEl.textContent = "Si el correo existe, recibirás un enlace para restablecer tu contraseña.";
  }).catch(() => {
    errEl.className = "form-msg error";
    errEl.textContent = "Error al enviar. Intenta de nuevo.";
  });
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
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Credenciales incorrectas");
    currentUser = data;
    setLoading(btn, false);
    startMap();
  } catch (err) {
    errEl.className = "form-msg error";
    errEl.textContent = err.message;
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
  const msgEl    = document.getElementById("register-msg");
  const btn      = e.target.querySelector("button[type=submit]");
  msgEl.className = "form-msg hidden";

  setLoading(btn, true);
  try {
    const res = await fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name, email, password, role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Error al registrarse");
    msgEl.className = "form-msg success";
    msgEl.textContent = "¡Cuenta creada! Revisa tu correo y haz clic en el enlace de verificación.";
    e.target.reset();
    selectRole("estudiante");
    setLoading(btn, false);
  } catch (err) {
    msgEl.className = "form-msg error";
    msgEl.textContent = err.message;
    setLoading(btn, false);
  }
}

// ── Transición de login → mapa ─────────────────────────────────────────────

function startMap() {
  stopBgPoll();
  myStatus = currentUser.role === "conductor" ? "disponible" : null;
  manualPassengers = 0;

  const badge = document.getElementById("role-badge");
  badge.textContent = currentUser.name + " · " + (currentUser.role === "estudiante" ? "Estudiante" : "Conductor");

  if (currentUser.role === "conductor") {
    document.getElementById("btn-status").classList.remove("hidden");
    document.getElementById("passenger-counter").classList.remove("hidden");
    updateStatusButton();
    updateCounterDisplay(0);
  }

  // Animación: el card se acerca y desaparece, el mapa queda nítido
  const authScreen = document.getElementById("auth-screen");
  const card       = authScreen.querySelector(".auth-card");
  const overlay    = authScreen.querySelector(".auth-overlay");

  card.style.transform   = "scale(1.12) translateY(-12px)";
  card.style.opacity     = "0";
  overlay.style.opacity  = "0";
  overlay.style.backdropFilter = "blur(0px)";

  setTimeout(() => {
    authScreen.classList.add("hidden");
    document.getElementById("topbar").classList.remove("hidden");
    document.getElementById("legend").classList.remove("hidden");
    map.invalidateSize();
    requestLocation();
  }, 580);
}

// ── Logout → vuelve el card ────────────────────────────────────────────────

async function logout() {
  try { await fetch("/logout", { method: "POST", credentials: "include" }); } catch (_) {}
  currentUser = null;
  cleanup();

  document.getElementById("topbar").classList.add("hidden");
  document.getElementById("legend").classList.add("hidden");
  document.getElementById("btn-status").classList.add("hidden");
  document.getElementById("passenger-counter").classList.add("hidden");

  // Preparar auth screen en estado invisible y mostrarlo
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

  // Animar de vuelta: el card baja y aparece
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

// ── Mapa ───────────────────────────────────────────────────────────────────

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false }).setView(UNIGUAJIRA_COORDS, 15);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    maxZoom: 19,
  }).addTo(map);
}

// ── Geolocation ────────────────────────────────────────────────────────────

function requestLocation() {
  if (!navigator.geolocation) { setStatus("error", "GPS no disponible"); return; }
  setStatus("connecting", "Obteniendo ubicacion...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      connectWS(pos.coords.latitude, pos.coords.longitude);
      startWatching();
    },
    () => setStatus("error", "Permiso de ubicacion denegado"),
    { enableHighAccuracy: true }
  );
}

function startWatching() {
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (ws && ws.readyState === WebSocket.OPEN)
        sendLocation(pos.coords.latitude, pos.coords.longitude);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connectWS(lat, lng) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen    = () => { setStatus("connected", "En vivo"); sendLocation(lat, lng); };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose   = (e) => {
    if (e.code === 4001 || e.code === 4003) { logout(); return; }
    setStatus("connecting", "Reconectando...");
  };
  ws.onerror = () => setStatus("error", "Error de conexion");
}

function sendLocation(lat, lng) {
  lastLat = lat; lastLng = lng;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      lat, lng,
      status: myStatus,
      manual_passengers: currentUser.role === "conductor" ? manualPassengers : 0,
    }));
  }
}

// ── Status & counter ───────────────────────────────────────────────────────

function cycleStatus() {
  const idx = STATUS_CYCLE.indexOf(myStatus);
  myStatus = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
  updateStatusButton();
  if (lastLat !== null) sendLocation(lastLat, lastLng);
}

function updateStatusButton() {
  const btn = document.getElementById("btn-status");
  btn.textContent = STATUS_LABELS[myStatus];
  btn.className = "";
  btn.id = "btn-status";
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
  el.className = total >= MAX_PASSENGERS ? "full" : "";
}

// ── Messages ───────────────────────────────────────────────────────────────

function handleMessage(msg) {
  if (msg.type === "snapshot") {
    msg.users.forEach(addOrUpdateMarker);
  } else if (msg.type === "update") {
    if (!myId && msg.user.name === currentUser.name && msg.user.role === currentUser.role)
      myId = msg.user.id;
    addOrUpdateMarker(msg.user);
    if (msg.user.id === myId && currentUser.role === "conductor") {
      if (msg.user.status !== myStatus) { myStatus = msg.user.status; updateStatusButton(); }
      updateCounterDisplay(msg.user.onboard_count);
    }
  } else if (msg.type === "remove") {
    removeMarker(msg.id);
  }
}

// ── Markers ────────────────────────────────────────────────────────────────

function markerColor(user) {
  if (user.role === "estudiante")  return "#0ea5e9";
  if (user.status === "lleno")     return "#ef4444";
  if (user.status === "en camino") return "#eab308";
  return "#f97316";
}

function buildIcon(user, isMe) {
  const color  = markerColor(user);
  const size   = isMe ? 26 : 18;
  const radius = user.role === "estudiante" ? "50%" : "4px";
  const ring   = isMe
    ? "box-shadow:0 0 0 4px rgba(255,255,255,0.2),0 2px 8px rgba(0,0,0,0.5);"
    : "box-shadow:0 2px 6px rgba(0,0,0,0.4);";
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:${radius};border:3px solid #fff;${ring}"></div>`,
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
  const passengerHtml = user.role === "conductor"
    ? `<div class="popup-info">${user.onboard_count || 0}/${MAX_PASSENGERS} pasajeros</div>` : "";
  const timeHtml = user.role === "estudiante"
    ? `<div class="popup-info">Esperando ${elapsed}</div>`
    : `<div class="popup-info">Activo hace ${elapsed}</div>`;
  return `<div class="popup-name">${user.name}${isMe ? " (tu)" : ""}</div>${timeHtml}${passengerHtml}${statusHtml}`;
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
    const key = group.map(u => u.id).sort().join("-");
    const sz = Math.min(14 + count * 8, 48);
    const icon = L.divIcon({
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

// ── Helpers ────────────────────────────────────────────────────────────────

function setLoading(btn, loading) {
  btn.disabled = loading;
  if (loading) { btn._orig = btn.textContent; btn.innerHTML = '<span class="spinner"></span>'; }
  else { btn.textContent = btn._orig || btn.textContent; }
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
  myId = null; lastLat = null; lastLng = null; manualPassengers = 0;
}
