const UNIGUAJIRA_COORDS = [11.5392, -72.9066];
const MAX_PASSENGERS = 4;

const STATUS_CYCLE = ["disponible", "lleno", "en camino"];
const STATUS_LABELS = {
  disponible: "Disponible",
  lleno: "Lleno",
  "en camino": "En camino",
};

let map, ws, myRole, myName, myStatus, watchId;
let myId = null;
let manualPassengers = 0;
let lastLat = null, lastLng = null;
const markers = {};

// ── Name screen ───────────────────────────────────────────────────────────────

function goToRole() {
  const input = document.getElementById("name-input");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  myName = name;
  document.getElementById("name-screen").classList.add("hidden");
  document.getElementById("role-screen").classList.remove("hidden");
  document.getElementById("greeting").textContent = "Hola, " + name;
}

// ── Session ───────────────────────────────────────────────────────────────────

function startSession(role) {
  myRole = role;
  myStatus = role === "conductor" ? "disponible" : null;
  manualPassengers = 0;

  document.getElementById("role-screen").classList.add("hidden");
  document.getElementById("map-screen").classList.remove("hidden");

  const badge = document.getElementById("role-badge");
  badge.textContent = myName + " · " + (role === "estudiante" ? "Estudiante" : "Conductor");

  if (role === "conductor") {
    document.getElementById("btn-status").classList.remove("hidden");
    document.getElementById("passenger-counter").classList.remove("hidden");
    updateStatusButton();
    updateCounterDisplay(0);
  }

  initMap();
  requestLocation();
}

function changeRole() {
  cleanup();
  myStatus = null;
  manualPassengers = 0;
  document.getElementById("btn-status").classList.add("hidden");
  document.getElementById("passenger-counter").classList.add("hidden");
  document.getElementById("map-screen").classList.add("hidden");
  document.getElementById("role-screen").classList.remove("hidden");
}

// ── Status (conductor) ────────────────────────────────────────────────────────

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
  const cls = myStatus === "en camino" ? "en-camino" : myStatus;
  btn.classList.add(cls);
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
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen  = () => { setStatus("connected", "En vivo"); sendLocation(lat, lng); };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose   = () => setStatus("connecting", "Reconectando...");
  ws.onerror   = () => setStatus("error", "Error de conexion");
}

function sendLocation(lat, lng) {
  lastLat = lat;
  lastLng = lng;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      lat,
      lng,
      role: myRole,
      name: myName,
      status: myStatus,
      manual_passengers: myRole === "conductor" ? manualPassengers : 0,
    }));
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

function handleMessage(msg) {
  if (msg.type === "snapshot") {
    msg.users.forEach(addOrUpdateMarker);
  } else if (msg.type === "update") {
    if (!myId && msg.user.name === myName && msg.user.role === myRole) {
      myId = msg.user.id;
    }
    addOrUpdateMarker(msg.user);

    // sync status if server auto-set to lleno
    if (msg.user.id === myId && myRole === "conductor") {
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
  if (user.role === "estudiante") return "#0ea5e9";
  if (user.status === "lleno")      return "#ef4444";
  if (user.status === "en camino")  return "#eab308";
  return "#f97316";
}

function buildIcon(user, isMe) {
  const color = markerColor(user);
  const size  = isMe ? 26 : 18;
  const radius = user.role === "estudiante" ? "50%" : "4px";
  const ring   = isMe
    ? "box-shadow:0 0 0 4px rgba(255,255,255,0.2),0 2px 8px rgba(0,0,0,0.5);"
    : "box-shadow:0 2px 6px rgba(0,0,0,0.4);";
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:${radius};border:3px solid #fff;${ring}"></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
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

  let passengerHtml = "";
  if (user.role === "conductor") {
    const total = user.onboard_count || 0;
    passengerHtml = `<div class="popup-info">${total}/${MAX_PASSENGERS} pasajeros</div>`;
  }

  const timeHtml = user.role === "estudiante"
    ? `<div class="popup-info">Esperando ${elapsed}</div>`
    : `<div class="popup-info">Activo hace ${elapsed}</div>`;

  return `
    <div class="popup-name">${user.name}${isMe ? " (tu)" : ""}</div>
    ${timeHtml}
    ${passengerHtml}
    ${statusHtml}
  `;
}

function elapsedTime(ts) {
  const secs = Math.floor(Date.now() / 1000 - ts);
  if (secs < 60) return secs + " seg";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + " min";
  return Math.floor(mins / 60) + " h";
}

function addOrUpdateMarker(user) {
  const isMe = user.id === myId;
  if (markers[user.id]) {
    markers[user.id].setLatLng([user.lat, user.lng]);
    markers[user.id].setIcon(buildIcon(user, isMe));
    markers[user.id].setPopupContent(buildPopup(user));
    return;
  }
  const marker = L.marker([user.lat, user.lng], { icon: buildIcon(user, isMe) })
    .addTo(map)
    .bindPopup(buildPopup(user));
  markers[user.id] = marker;
}

function removeMarker(id) {
  if (markers[id]) { markers[id].remove(); delete markers[id]; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  document.getElementById("status-dot").className = `dot ${state}`;
  document.getElementById("status-text").textContent = text;
}

function cleanup() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  if (ws) ws.close();
  Object.values(markers).forEach((m) => m.remove());
  Object.keys(markers).forEach((k) => delete markers[k]);
  myId = null;
  lastLat = null;
  lastLng = null;
}
