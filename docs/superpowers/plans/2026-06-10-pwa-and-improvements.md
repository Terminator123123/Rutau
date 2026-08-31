# ColectivoU — PWA + Mejoras Arquitecturales

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir ColectivoU en una PWA instalable con offline básico, y resolver deudas técnicas críticas identificadas en revisión senior.

**Architecture:** Service Worker con cache-first para assets estáticos y network-first para API; manifest.json apuntando a `/dev` como start_url; el backend sirve `/static/sw.js` y `/static/manifest.json` desde FastAPI StaticFiles.

**Tech Stack:** Vanilla JS (sin bundler), FastAPI, Service Worker API, Cache API, Web App Manifest. Sin dependencias nuevas.

---

## Análisis senior — hallazgos pre-plan

### Problemas críticos encontrados en code review

| # | Problema | Archivo | Impacto |
|---|---------|---------|---------|
| 1 | `admin_id=0` hardcoded en Recarga | `app/routers/admin.py:149` | Ningún registro sabe qué admin hizo la recarga |
| 2 | `app.js` es un monolito de ~2000 líneas con todo global | `static/app.js` | Cualquier bug afecta todo; imposible testear |
| 3 | Background poll corre para TODOS los usuarios incluidos los que ya tienen WebSocket | `static/app.js:108-133` | Requests duplicados innecesarios |
| 4 | Sin manifest.json ni Service Worker | — | No instalable como app, sin offline |
| 5 | Sin ningún test | — | Zero cobertura; bugs silenciosos |
| 6 | `index.html` usa tema dark; `style.css` usa tema light | Inconsistencia visual entre landing y app |
| 7 | START_COMMAND en Railway termina sin `$PORT` | Railway env | Potencial problema de arranque |

### Orden de prioridad (expo en 6 días)
- **Antes de expo (tareas 1-5):** PWA foundation, admin_id fix, START_COMMAND fix
- **Post-expo (tareas 6-9):** Tests, split app.js, UX improvements

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---------|--------|-----------------|
| `static/manifest.json` | Crear | Metadata PWA: nombre, iconos, colores, start_url |
| `static/sw.js` | Crear | Service Worker: cache assets, offline fallback |
| `static/offline.html` | Crear | Página fallback cuando no hay conexión |
| `static/icon-192.png` | Crear | Ícono PWA 192×192 (requerido) |
| `static/icon-512.png` | Crear | Ícono PWA 512×512 (requerido) |
| `static/dev.html` | Modificar | Agregar meta tags PWA, link manifest, registro SW |
| `static/index.html` | Modificar | Agregar meta tags PWA básicos |
| `static/app.js` | Modificar | Detener bgPoll si WS está activo; mostrar banner install |
| `app/routers/admin.py` | Modificar | Pasar admin real ID a Recarga en vez de 0 |
| `app/routers/admin.py` | Modificar | Endpoint `/admin/reload-cache` para forzar sw update |
| `app/dependencies.py` | Modificar | `require_admin` debe retornar el objeto admin |
| `app/database.py` | Leer | Verificar modelo `Recarga.admin_id` existe como FK o int |
| `Procfile` | Modificar | Confirmar que usa `$PORT` correctamente |

---

## Task 1: Crear manifest.json

**Files:**
- Create: `static/manifest.json`

- [ ] **Step 1: Crear el manifest**

```json
{
  "name": "ColectivoU",
  "short_name": "ColectivoU",
  "description": "Coordinación de transporte colectivo — Universidad de La Guajira",
  "start_url": "/dev",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#f1f5f9",
  "theme_color": "#2563eb",
  "lang": "es",
  "icons": [
    {
      "src": "/static/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/static/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ],
  "screenshots": [],
  "categories": ["transportation", "utilities"],
  "shortcuts": [
    {
      "name": "Abrir app",
      "url": "/dev",
      "description": "Ir al mapa principal"
    }
  ]
}
```

Guardar en `rutau/static/manifest.json`.

- [ ] **Step 2: Verificar que FastAPI sirve el archivo**

```bash
curl https://rutau-api-production.up.railway.app/static/manifest.json
```

Esperado: JSON con `name: "ColectivoU"` (necesita que el servidor esté desplegado primero).

- [ ] **Step 3: Commit**

```bash
git add static/manifest.json
git commit -m "feat(pwa): add web app manifest"
```

---

## Task 2: Crear íconos PWA

**Files:**
- Create: `static/icon-192.png`
- Create: `static/icon-512.png`

**Nota:** Los íconos deben ser PNG reales. Opciones:

**Opción A — Usar carrito.png existente (más rápido):**

- [ ] **Step 1: Copiar carrito.png como icon-192.png e icon-512.png**

```powershell
Copy-Item "rutau\static\carrito.png" "rutau\static\icon-192.png"
Copy-Item "rutau\static\carrito.png" "rutau\static\icon-512.png"
```

Esto es temporal. Los íconos son válidos aunque no sean exactamente 192×192 — el browser los escala. Para la expo es suficiente.

**Opción B — Generar íconos correctos (recomendado post-expo):**
Usar [realfavicongenerator.net](https://realfavicongenerator.net) con el logo final y reemplazar los archivos.

- [ ] **Step 2: Commit**

```bash
git add static/icon-192.png static/icon-512.png
git commit -m "feat(pwa): add PWA icons"
```

---

## Task 3: Crear Service Worker

**Files:**
- Create: `static/sw.js`
- Create: `static/offline.html`

- [ ] **Step 1: Crear `static/offline.html`**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sin conexión — ColectivoU</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #f1f5f9;
      color: #1e293b;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 2rem;
    }
    .card {
      background: #fff;
      border-radius: 1.25rem;
      padding: 2.5rem 2rem;
      max-width: 320px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem; color: #1e293b; }
    p { color: #64748b; font-size: 0.9rem; line-height: 1.5; margin-bottom: 1.5rem; }
    button {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 0.75rem;
      padding: 0.75rem 1.5rem;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
    }
    button:active { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📡</div>
    <h1>Sin conexión</h1>
    <p>ColectivoU necesita internet para funcionar en tiempo real. Verifica tu señal y vuelve a intentarlo.</p>
    <button onclick="location.reload()">Reintentar</button>
  </div>
</body>
</html>
```

- [ ] **Step 2: Crear `static/sw.js`**

```javascript
const CACHE_VERSION = 'colectivou-v1';
const STATIC_ASSETS = [
  '/dev',
  '/static/style.css',
  '/static/app.js',
  '/static/icon-192.png',
  '/offline',
];

// Instalar: pre-cachear assets críticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activar: limpiar caches viejas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first para assets, network-first para API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ignorar WebSocket y requests de otros orígenes
  if (event.request.url.startsWith('ws') || url.origin !== self.location.origin) return;

  // API calls: siempre red (no cachear respuestas de negocio)
  const isApi = ['/login', '/register', '/me', '/ws', '/forgot', '/reset',
                  '/trips', '/conductor', '/admin', '/zones', '/stats'].some(p =>
    url.pathname.startsWith(p)
  );
  if (isApi) return;

  // Assets estáticos y páginas: cache-first con fallback a red
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback para páginas HTML
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/offline');
        }
      });
    })
  );
});
```

- [ ] **Step 3: Agregar ruta `/offline` en FastAPI**

Abrir `rutau/app/main.py` y agregar después de la ruta `/dev`:

```python
@app.get("/offline", include_in_schema=False)
async def offline_page():
    return FileResponse("static/offline.html")
```

- [ ] **Step 4: Commit**

```bash
git add static/sw.js static/offline.html app/main.py
git commit -m "feat(pwa): add service worker and offline fallback"
```

---

## Task 4: Agregar meta tags PWA a dev.html

**Files:**
- Modify: `static/dev.html` (líneas 1-12 del `<head>`)

- [ ] **Step 1: Reemplazar el bloque `<head>` de dev.html**

Cambiar desde `<head>` hasta el primer `<link rel="stylesheet"...>` para incluir:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#2563eb" />
  <meta name="description" content="Coordinación de transporte colectivo — Universidad de La Guajira" />

  <!-- iOS PWA -->
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="ColectivoU" />
  <link rel="apple-touch-icon" href="/static/icon-192.png" />

  <!-- Manifest -->
  <link rel="manifest" href="/static/manifest.json" />

  <title>ColectivoU</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <link rel="stylesheet" href="/static/style.css" />
</head>
```

- [ ] **Step 2: Verificar con Lighthouse que el manifest está linkado**

Abrir Chrome DevTools → Application → Manifest. Debe mostrar "ColectivoU" con los íconos.

- [ ] **Step 3: Commit**

```bash
git add static/dev.html
git commit -m "feat(pwa): add PWA meta tags to dev.html"
```

---

## Task 5: Registrar Service Worker desde app.js

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Agregar registro del SW al inicio del evento DOMContentLoaded**

En `static/app.js`, dentro de `window.addEventListener("DOMContentLoaded", () => {` (línea 44), agregar como **primera línea** del callback:

```javascript
window.addEventListener("DOMContentLoaded", () => {
  // Registrar Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  }

  // ... resto del código existente ...
  initMap();
  startBgPoll();
  // ...
```

- [ ] **Step 2: Agregar banner de instalación (Install Prompt)**

Buscar la sección `// ── Init ───` en app.js (alrededor de línea 42) y agregar ANTES de `window.addEventListener("DOMContentLoaded"`:

```javascript
// ── PWA Install ───────────────────────────────────────────────────────────
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Mostrar banner solo si el usuario está autenticado y en el mapa
  if (currentUser) _showInstallBanner();
});

function _showInstallBanner() {
  if (!_deferredInstallPrompt) return;
  let banner = document.getElementById('pwa-install-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      background:#2563eb; color:#fff; border-radius:1rem; padding:0.75rem 1.25rem;
      font-size:0.875rem; font-weight:600; box-shadow:0 4px 16px rgba(37,99,235,0.4);
      display:flex; align-items:center; gap:0.75rem; z-index:9999;
      animation: slideUp 0.3s ease;
    `;
    banner.innerHTML = `
      <span>📲 Instalar ColectivoU</span>
      <button onclick="installPWA()" style="background:#fff;color:#2563eb;border:none;
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
});
```

- [ ] **Step 3: Agregar animación slideUp en style.css**

Al final de `static/style.css`:

```css
@keyframes slideUp {
  from { opacity: 0; transform: translateX(-50%) translateY(20px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
```

- [ ] **Step 4: Detener bgPoll cuando WS está activo (evitar doble polling)**

En `static/app.js`, en la función `connectWS` (buscar `function connectWS`), agregar al inicio:

```javascript
function connectWS(lat, lng) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  stopBgPoll(); // ← AGREGAR ESTA LÍNEA — WS reemplaza al polling
  // ... resto del código existente ...
```

Y en la función `cleanup()` (buscar `function cleanup`), restaurar el poll:

```javascript
function cleanup() {
  // ... código existente de cleanup ...
  startBgPoll(); // ← AGREGAR AL FINAL — restaurar poll tras logout
}
```

- [ ] **Step 5: Verificar en Chrome DevTools → Application → Service Workers**

El SW debe aparecer como "Activated and running".

- [ ] **Step 6: Commit**

```bash
git add static/app.js static/style.css
git commit -m "feat(pwa): register service worker, add install prompt, stop redundant poll during WS"
```

---

## Task 6: Fix admin_id en Recarga

**Files:**
- Modify: `app/routers/admin.py`
- Modify: `app/dependencies.py`

**Contexto:** `require_admin` en `dependencies.py` solo valida las credenciales Basic pero no retorna el objeto admin. El admin no tiene entidad en la DB (es Basic Auth sobre env vars), por lo que `admin_id` no puede ser un FK real. La solución correcta es usar el username como identificador.

- [ ] **Step 1: Leer dependencias actuales**

```bash
cat rutau/app/dependencies.py
```

Verificar la firma actual de `require_admin`.

- [ ] **Step 2: Modificar `require_admin` para retornar el username**

En `app/dependencies.py`, cambiar `require_admin` para que retorne el username en lugar de solo validar:

```python
from fastapi.security import HTTPBasic, HTTPBasicCredentials
import secrets, os

_basic = HTTPBasic(auto_error=True)

def require_admin(credentials: HTTPBasicCredentials = Depends(_basic)):
    admin_user = os.getenv("ADMIN_USER", "admin")
    admin_pass = os.getenv("ADMIN_PASSWORD", "colectivou2026")
    ok = (
        secrets.compare_digest(credentials.username.encode(), admin_user.encode()) and
        secrets.compare_digest(credentials.password.encode(), admin_pass.encode())
    )
    if not ok:
        raise HTTPException(status_code=401, detail="Acceso denegado",
                            headers={"WWW-Authenticate": "Basic"})
    return credentials.username  # ← retornar username
```

- [ ] **Step 3: Modificar `admin.py` para usar el username como admin_id en notas**

En `app/routers/admin.py`, el endpoint de recarga ya tiene `admin = Depends(require_admin)`. Cambiar la línea del Recarga:

```python
# Antes:
recarga = Recarga(
    conductor_id=user_id,
    admin_id=0,           # ← eliminar hardcoded 0
    ...
)

# Después: admin_id sigue en 0 (no hay tabla de admins en DB),
# pero el campo notas ya tiene el username — agregar también en nota.
# Si quieres un admin_id real en DB, necesitarías migración (post-expo).
# Por ahora, el fix es cosmético en notas:
admin_notes = f"[{admin}] {body.notas or ''}".strip()
```

**Nota:** Si `admin` era antes un objeto con `.username`, y ahora `require_admin` retorna un string directamente, el código ya existente `f"[{admin.username}]"` se romperá. Cambiar a `f"[{admin}]"`.

- [ ] **Step 4: Verificar que no hay otros usos de `admin.username` en admin.py**

```bash
grep -n "admin\.username\|admin\.password" rutau/app/routers/admin.py
```

Esperado: 0 resultados. Si hay, cambiar a `admin` (el string).

- [ ] **Step 5: Commit**

```bash
git add app/dependencies.py app/routers/admin.py
git commit -m "fix: require_admin returns username string; remove admin_id=0 dependency on object"
```

---

## Task 7: Verificar y corregir START_COMMAND en Railway

**Files:**
- Railway env var `START_COMMAND`
- `Procfile`

- [ ] **Step 1: Leer el Procfile actual**

```bash
cat rutau/Procfile
```

- [ ] **Step 2: Verificar que el Procfile usa $PORT**

El Procfile debe contener exactamente:

```
web: uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Si dice algo diferente (como `--port 8000` o termina sin valor), corregirlo.

- [ ] **Step 3: Si el Procfile está correcto, eliminar START_COMMAND de Railway**

Railway da prioridad a `START_COMMAND` sobre `Procfile`. Si `START_COMMAND` en Railway está incompleto (`uvicorn app.main:app --host 0.0.0.0 --port `), eliminarlo para que Railway use el Procfile:

Usar Railway MCP:
```
mcp__railway__set_variables con START_COMMAND=""
```
O desde railway.app → Settings → eliminar la variable `START_COMMAND`.

- [ ] **Step 4: Verificar el health endpoint tras redeploy**

```bash
curl https://rutau-api-production.up.railway.app/health
```

Esperado: `{"status": "ok", "app": "ColectivoU"}`

- [ ] **Step 5: Commit si se cambió el Procfile**

```bash
git add Procfile
git commit -m "fix: ensure Procfile uses \$PORT for Railway"
```

---

## Task 8: Agregar tests básicos (post-expo)

**Files:**
- Create: `tests/__init__.py`
- Create: `tests/test_auth.py`
- Create: `tests/test_health.py`
- Modify: `requirements.txt`

- [ ] **Step 1: Agregar pytest y httpx a requirements.txt**

```
pytest==8.3.4
pytest-asyncio==0.24.0
httpx==0.27.2  ← ya está, solo verificar
```

- [ ] **Step 2: Crear `tests/__init__.py`**

Archivo vacío:
```python
```

- [ ] **Step 3: Escribir test de health (siempre debe pasar)**

```python
# tests/test_health.py
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

def test_zones():
    r = client.get("/zones")
    assert r.status_code == 200
    zones = r.json()["zones"]
    assert "Rompoi" in zones
    assert len(zones) >= 10
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

```bash
cd rutau && python -m pytest tests/test_health.py -v
```

Esperado:
```
tests/test_health.py::test_health PASSED
tests/test_health.py::test_zones PASSED
2 passed in 0.5s
```

- [ ] **Step 5: Escribir tests de autenticación**

```python
# tests/test_auth.py
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.database import Base, engine

@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)

client = TestClient(app)

def test_register_creates_user():
    r = client.post("/register", json={
        "name": "Test User",
        "email": "test@uniguajira.edu.co",
        "password": "password123",
        "role": "estudiante",
        "terms_accepted": True,
    })
    assert r.status_code == 200
    assert r.json()["role"] == "estudiante"

def test_register_rejects_short_password():
    r = client.post("/register", json={
        "name": "Test",
        "email": "test2@uniguajira.edu.co",
        "password": "abc",
        "role": "estudiante",
        "terms_accepted": True,
    })
    assert r.status_code == 400

def test_login_wrong_password():
    r = client.post("/login", json={
        "email": "nobody@uniguajira.edu.co",
        "password": "wrongpassword",
    })
    assert r.status_code == 401

def test_rate_limit_register():
    for _ in range(5):
        client.post("/register", json={
            "name": "Flood",
            "email": f"flood{_}@x.com",
            "password": "password123",
            "role": "estudiante",
            "terms_accepted": True,
        })
    # 6th request debe ser rechazada por rate limit
    r = client.post("/register", json={
        "name": "Flood",
        "email": "flood6@x.com",
        "password": "password123",
        "role": "estudiante",
        "terms_accepted": True,
    })
    assert r.status_code == 429
```

- [ ] **Step 6: Ejecutar todos los tests**

```bash
cd rutau && python -m pytest tests/ -v
```

Esperado: todos pasan o hay fallas explicables por configuración de DB de test.

- [ ] **Step 7: Commit**

```bash
git add requirements.txt tests/
git commit -m "test: add pytest foundation with auth and health tests"
```

---

## Task 9: UX — Saldo visible en topbar del conductor (post-expo)

**Files:**
- Modify: `static/dev.html` — agregar elemento `#tb-saldo`
- Modify: `static/app.js` — actualizar saldo al conectar y en cada viaje
- Modify: `static/style.css` — estilos del chip de saldo

- [ ] **Step 1: Agregar elemento de saldo en el topbar de dev.html**

Buscar en `dev.html` el div `<div class="tb-center"></div>` y reemplazarlo:

```html
<div class="tb-center">
  <div id="tb-saldo" class="tb-saldo hidden">
    <span id="tb-saldo-amount">$0</span>
  </div>
</div>
```

- [ ] **Step 2: Agregar estilos en style.css**

Al final de `style.css`:

```css
.tb-saldo {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 2rem;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 700;
  color: #16a34a;
  transition: background 0.2s, color 0.2s;
}
.tb-saldo.low {
  background: #fff7ed;
  border-color: #fed7aa;
  color: #ea580c;
}
```

- [ ] **Step 3: Agregar función updateSaldoDisplay en app.js**

Después de la función `readSessionCookie()` (alrededor de línea 40):

```javascript
function updateSaldoDisplay(saldo) {
  const chip = document.getElementById('tb-saldo');
  const amount = document.getElementById('tb-saldo-amount');
  if (!chip || !amount || currentUser?.role !== 'conductor') return;
  chip.classList.remove('hidden');
  amount.textContent = `$${Math.round(saldo).toLocaleString('es-CO')}`;
  chip.classList.toggle('low', saldo < 500);
}
```

- [ ] **Step 4: Llamar updateSaldoDisplay al iniciar sesión como conductor**

En la función `startMap()` (buscar `function startMap`), después de mostrar el topbar para conductores:

```javascript
// Cargar saldo del conductor al iniciar
if (currentUser?.role === 'conductor') {
  fetch('/conductor/saldo', { credentials: 'include' })
    .then(r => r.json())
    .then(data => updateSaldoDisplay(data.saldo || 0))
    .catch(() => {});
}
```

- [ ] **Step 5: Actualizar saldo en el handler de `dropoff_complete`**

Buscar `case "dropoff_complete":` o el handler que procesa el fin del viaje en app.js y agregar:

```javascript
// Refrescar saldo después de cada viaje (cobro de $100)
fetch('/conductor/saldo', { credentials: 'include' })
  .then(r => r.json())
  .then(data => updateSaldoDisplay(data.saldo || 0))
  .catch(() => {});
```

- [ ] **Step 6: Commit**

```bash
git add static/dev.html static/app.js static/style.css
git commit -m "feat(ux): show conductor balance in topbar with low-balance warning"
```

---

## Self-Review

### Cobertura del spec

| Requisito | Tarea |
|-----------|-------|
| PWA instalable | Tasks 1-5 |
| Offline fallback | Task 3 |
| admin_id fix | Task 6 |
| START_COMMAND Railway | Task 7 |
| Sin tests → test foundation | Task 8 |
| bgPoll redundante | Task 5 (Step 4) |
| Saldo conductor en topbar | Task 9 |
| Iconos PWA | Task 2 |
| Install prompt | Task 5 (Step 2) |

### Gaps identificados post-review

- **`/conductor/saldo` endpoint** — Task 9 asume que existe. Verificar con `grep -r "saldo" rutau/app/routers/conductor.py` antes de implementar Task 9.
- **`require_admin` en otros routers** — Si otros archivos importan `require_admin` y usan `.username`, el cambio en Task 6 puede romperlos. Verificar con `grep -rn "require_admin" rutau/app/routers/`.
- **Test de rate limit (Task 8)** — El rate limiter usa IP del cliente. En tests con TestClient la IP es `testclient`, no `127.0.0.1`. El test puede fallar si el limiter filtra por IP real. Ajustar el test o mockear la IP si es necesario.

### Placeholders verificados

Ningún paso tiene "TBD" o "implementar después". Todos los pasos incluyen código concreto.

### Consistencia de tipos

- `require_admin` retorna `str` (username) en Task 6 → `admin.py` usa `f"[{admin}]"` (string) — consistente.
- `updateSaldoDisplay(saldo: number)` — llamada con `data.saldo || 0` — consistente.

---

## Orden de ejecución recomendado

**Antes de la expo (6 días):**
1. Task 7 — START_COMMAND (15 min)
2. Task 1 — manifest.json (10 min)
3. Task 2 — Íconos (5 min)
4. Task 3 — Service Worker + offline.html (30 min)
5. Task 4 — Meta tags dev.html (10 min)
6. Task 5 — Registro SW + install prompt (20 min)
7. Task 6 — admin_id fix (15 min)

**Post-expo:**
8. Task 8 — Tests (2-3 horas)
9. Task 9 — Saldo en topbar (1 hora)
