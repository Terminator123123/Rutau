const UNIGUAJIRA_COORDS = [11.5392, -72.9066];
const LOCATION_INTERVAL_MS = 4000;

const MARKER_ICONS = {
  estudiante: L.divIcon({
    className: '',
    html: `<div style="
      background:#0ea5e9;width:18px;height:18px;
      border-radius:50%;border:3px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,0.4)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  }),
  conductor: L.divIcon({
    className: '',
    html: `<div style="
      background:#f97316;width:22px;height:22px;
      border-radius:4px;border:3px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,0.4)"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  }),
  self: (role) => L.divIcon({
    className: '',
    html: `<div style="
      background:${role === 'estudiante' ? '#0ea5e9' : '#f97316'};
      width:26px;height:26px;
      border-radius:${role === 'estudiante' ? '50%' : '5px'};
      border:3px solid #fff;
      box-shadow:0 0 0 4px rgba(255,255,255,0.25),0 2px 8px rgba(0,0,0,0.5)"></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  }),
};

let map, ws, myRole, myMarker, watchId;
const markers = {};

function startSession(role) {
  myRole = role;
  document.getElementById('role-screen').classList.add('hidden');
  document.getElementById('map-screen').classList.remove('hidden');

  const badge = document.getElementById('role-badge');
  badge.textContent = role === 'estudiante' ? '🎒 Estudiante' : '🚐 Conductor';

  initMap();
  requestLocation();
}

function changeRole() {
  cleanup();
  document.getElementById('map-screen').classList.add('hidden');
  document.getElementById('role-screen').classList.remove('hidden');
}

function initMap() {
  if (map) { map.remove(); map = null; }

  map = L.map('map').setView(UNIGUAJIRA_COORDS, 15);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19,
  }).addTo(map);
}

function requestLocation() {
  if (!navigator.geolocation) {
    setStatus('error', 'GPS no disponible en este dispositivo');
    return;
  }

  setStatus('connecting', 'Obteniendo ubicación...');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      connectWS(pos.coords.latitude, pos.coords.longitude);
      startWatching();
    },
    (err) => setStatus('error', 'Permiso de ubicación denegado'),
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

function connectWS(lat, lng) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    setStatus('connected', 'En vivo');
    sendLocation(lat, lng);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => setStatus('connecting', 'Reconectando...');
  ws.onerror = () => setStatus('error', 'Error de conexión');
}

function sendLocation(lat, lng) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ lat, lng, role: myRole }));
  }
}

function handleMessage(msg) {
  if (msg.type === 'snapshot') {
    msg.users.forEach(addOrUpdateMarker);
  } else if (msg.type === 'update') {
    addOrUpdateMarker(msg.user);
  } else if (msg.type === 'remove') {
    removeMarker(msg.id);
  }
}

function addOrUpdateMarker(user) {
  const isMe = !markers[user.id] && !Object.keys(markers).length
    ? false
    : false;

  // detect own marker by checking if the server echoed our location
  // we track our own marker separately via myMarker
  if (markers[user.id]) {
    markers[user.id].setLatLng([user.lat, user.lng]);
    return;
  }

  const icon = MARKER_ICONS[user.role];
  const label = user.role === 'estudiante' ? 'Estudiante' : 'Conductor';
  const marker = L.marker([user.lat, user.lng], { icon })
    .addTo(map)
    .bindPopup(`<b>${label}</b>`);

  markers[user.id] = marker;
}

function removeMarker(id) {
  if (markers[id]) {
    markers[id].remove();
    delete markers[id];
  }
}

function setStatus(state, text) {
  document.getElementById('status-dot').className = `dot ${state}`;
  document.getElementById('status-text').textContent = text;
}

function cleanup() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  if (ws) ws.close();
  Object.values(markers).forEach(m => m.remove());
  Object.keys(markers).forEach(k => delete markers[k]);
}
