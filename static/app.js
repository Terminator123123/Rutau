const UNIGUAJIRA_COORDS = [11.5392, -72.9066];
const MAX_PASSENGERS = 4;
const CLUSTER_RADIUS_M = 30;

const STATUS_CYCLE = ["disponible", "lleno", "en camino"];
const STATUS_LABELS = { disponible: "Disponible", lleno: "Lleno", "en camino": "En camino" };

let map, ws, myStatus, watchId;
let myId = null;
let manualPassengers = 0;
let lastLat = null, lastLng = null;
let authToken = null;
let currentUser = null;
const markers = {};
const clusterMarkers = {};

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("cu_token");
  const user  = localStorage.getItem("cu_user");
  if (saved && user) {
    authToken   = saved;
    currentUser = JSON.parse(user);
    startMap();
  }
});

// ── Auth tabs ─────────────────────────────────────────────────────────────────

function showTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("login-form").classList.toggle("hidden", !isLogin);
  document.getElementById("register-form").classList.toggle("hidden", isLogin);
  document.querySelectorAll(".tab").forEach((t, i) => {
    t.classList.toggle("active", isLogin ? i === 0 : i === 1);
  });
  // Reset error/success messages when switching tabs
  ["login-error", "register-error"].forEach(id => {
    const el = document.getElementById(id);
    el.className = "form-error hidden";
    el.textContent = "";
  });
}

function selectRole(role) {
  document.getElementById("reg-role").value = role;
  document.getElementById("toggle-estudiante").classList.toggle("active", role === "estudiante");
  document.getElementById("toggle-conductor").classList.toggle("active", role === "conductor");
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();
  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl    = document.getElementById("login-error");
  const btn      = e.target.querySelector("button[type=submit]");
  errEl.classList.add("hidden");

  setLoading(btn, true);
  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Credenciales incorrectas");
    saveSession(data);
    startMap();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
    setLoading(btn, false);
  }
}

// ── Register ──────────────────────────────────────────────────────────────────

async function handleRegister(e) {
  e.preventDefault();
  const name     = document.getElementById("reg-name").value.trim();
  const email    = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const role     = document.getElementById("reg-role").value;
  const errEl    = document.getElementById("register-error");
  const btn      = e.target.querySelector("button[type=submit]");
  errEl.classList.add("hidden");

  setLoading(btn, true);
  try {
    const res = await fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Error al registrarse");

    // Account created but needs email verification before accessing the map
    errEl.className = "form-success";
    errEl.textContent = "¡Cuenta creada! Revisa tu correo y haz clic en el enlace de verificación para ingresar.";
    errEl.classList.remove("hidden");
    e.target.reset();
    setLoading(btn, false);
  } catch (err) {
    errEl.className = "form-error";
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
    setLoading(btn, false);
  }
}

function saveSession(data) {
  authToken   = data.access_token;
  currentUser = data.user;
  localStorage.setItem("cu_token", authToken);
  localStorage.setItem("cu_user", JSON.stringify(currentUser));
}

function logout() {
  localStorage.removeItem("cu_token");
  localStorage.removeItem("cu_user");
  cleanup();
  document.getElementById("map-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
}

// ── Map start ─────────────────────────────────────────────────────────────────

function startMap() {
  myStatus = currentUser.role === "conductor" ? "disponible" : null;
  manualPassengers = 0;

  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("map-screen").classList.remove("hidden");

  const badge = document.getElementById("role-badge");
  const label = currentUser.role === "estudiante" ? "Estudiante" : "Conductor";
  badge.textContent = currentUser.name + " · " + label;

  if (currentUser.role === "conductor") {
    document.getElementById("btn-status").classList.remove("hidden");
    document.getElementById("passenger-counter").classList.remove("hidden");
    updateStatusButton();
    updateCounterDisplay(0);
  }

  initMap();
  requestLocation();
}

// ── Status ────────────────────────────────────────────────────────────────────

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

// ── Passenger counter ─────────────────────────────────────────────────────────

function addManual() {
  if (manualPassengers < MAX_PASSENGERS) {
    manualPassengers++;
    if (lastLat !== null) sendLocation(lastLat, lastLng);
  }
}

function removeManual() {
  if (manualPassengers > 0) {
    manualPassengers--;
    if (lastLat !== null) sendLocation(lastLat, lastLng);
  }
}

function updateCounterDisplay(total) {
  const el = document.getElementById("counter-display");
  el.textContent = total + "/" + MAX_PASSENGERS;
  el.className = total >= MAX_PASSENGERS ? "full" : "";
}

// ── Map ───────────────────────────────────────────────────────────────────────

function initMap() {
  if (map) { map.remove(); map = null; }
  map = L.map("map").setView(UNIGUAJIRA_COORDS, 15);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    maxZoom: 19,
  }).addTo(map);
}

// ── Geolocation ───────────────────────────────────────────────────────────────

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
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendLocation(pos.coords.latitude, pos.coords.longitude);
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS(lat, lng) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${authToken}`);
  ws.onopen  = () => { setStatus("connected", "En vivo"); sendLocation(lat, lng); };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose   = (e) => {
    if (e.code === 4001 || e.code === 4003) { logout(); return; }
    setStatus("connecting", "Reconectando...");
  };
  ws.onerror = () => setStatus("error", "Error de conexion");
}

function sendLocation(lat, lng) {
  lastLat = lat;
  lastLng = lng;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      lat,
      lng,
      status: myStatus,
      manual_passengers: currentUser.role === "conductor" ? manualPassengers : 0,
    }));
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

function handleMessage(msg) {
  if (msg.type === "snapshot") {
    msg.users.forEach(addOrUpdateMarker);
  } else if (msg.type === "update") {
    if (!myId && msg.user.name === currentUser.name && msg.user.role === currentUser.role) {
      myId = msg.user.id;
    }
    addOrUpdateMarker(msg.user);

    if (msg.user.id === myId && currentUser.role === "conductor") {
      if (msg.user.status !== myStatus) {
        myStatus = msg.user.status;
        updateStatusButton();
      }
      updateCounterDisplay(msg.user.onboard_count);
    }
  } else if (msg.type === "remove") {
    removeMarker(msg.id);
  }
}

// ── Markers ───────────────────────────────────────────────────────────────────

function markerColor(user) {
  if (user.role === "estudiante")     return "#0ea5e9";
  if (user.status === "lleno")        return "#ef4444";
  if (user.status === "en camino")    return "#eab308";
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

// ── Clustering ────────────────────────────────────────────────────────────────

function haversineJS(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function refreshClusters() {
  if (!map) return;
  const students = Object.values(markers)
    .map((m) => m._userData)
    .filter((u) => u && u.role === "estudiante");

  const visited = new Set();
  const groups  = [];
  for (const u of students) {
    if (visited.has(u.id)) continue;
    const group = [u];
    visited.add(u.id);
    for (const v of students) {
      if (visited.has(v.id)) continue;
      if (haversineJS(u.lat, u.lng, v.lat, v.lng) <= CLUSTER_RADIUS_M) {
        group.push(v); visited.add(v.id);
      }
    }
    groups.push(group);
  }

  Object.values(clusterMarkers).forEach((m) => m.remove());
  Object.keys(clusterMarkers).forEach((k) => delete clusterMarkers[k]);

  const inCluster = new Set();
  for (const group of groups) {
    if (group.length < 2) continue;
    group.forEach((u) => { inCluster.add(u.id); if (markers[u.id]) markers[u.id].setOpacity(0); });

    const cLat = group.reduce((s, u) => s + u.lat, 0) / group.length;
    const cLng = group.reduce((s, u) => s + u.lng, 0) / group.length;
    const count = group.length;
    const key   = group.map((u) => u.id).sort().join("-");
    const sz    = Math.min(14 + count * 8, 48);

    const icon = L.divIcon({
      className: "",
      html: `<div style="background:#0ea5e9;width:${sz}px;height:${sz}px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:800;color:#fff">${count}</div>`,
      iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
    });
    const names = group.map((u) => u.name).join(", ");
    clusterMarkers[key] = L.marker([cLat, cLng], { icon })
      .addTo(map)
      .bindPopup(`<div class="popup-name">${count} estudiantes</div><div class="popup-info">${names}</div>`);
  }

  students.forEach((u) => {
    if (!inCluster.has(u.id) && markers[u.id]) markers[u.id].setOpacity(1);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setLoading(btn, loading) {
  btn.disabled = loading;
  if (loading) {
    btn._orig = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';
  } else {
    btn.textContent = btn._orig || btn.textContent;
  }
}

function setStatus(state, text) {
  document.getElementById("status-dot").className = `dot ${state}`;
  document.getElementById("status-text").textContent = text;
}

function cleanup() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  if (ws) ws.close();
  Object.values(markers).forEach((m) => m.remove());
  Object.keys(markers).forEach((k) => delete markers[k]);
  Object.values(clusterMarkers).forEach((m) => m.remove());
  Object.keys(clusterMarkers).forEach((k) => delete clusterMarkers[k]);
  myId = null; lastLat = null; lastLng = null;
}
